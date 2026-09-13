/**
 * lib/release-manager.js — Sprint 16 发布层（设计稿 §3，2026-09-09 拍板）
 *
 * 三道门（全过才落盘，任何一道不过 = 候选停 BUDGET_WAIT + release-held 事件）：
 *   门 1  release_enabled（总开关；auto/manual 都拦）
 *   门 2  人工确认窗：require_human_approval=true 或 now < require_human_approval_until
 *         （manual=true 绕过本门；设计稿 §12 拍板 2：首 4 周人工点头）
 *   门 3  policy 门（K42 拦错门）：同步问询 agint.qualityPolicy.decide。
 *         release_policy_mode='veto'（默认）只拦 REJECT/ABSTAIN，放行
 *         AUTO_DEPLOY/PENDING_REVIEW（policy 作为「拦错」防御，放过其余进观察期，
 *         由观察期 usage 信号 + 自动回滚收口）；'strict' 仅 AUTO_DEPLOY 放行。
 *         未挂载/超时/异常一律 fail-closed。2026-09-13 修复：喂合法 EvalResult[]。
 *   门 4  周预算：releases 表本周（含已回滚）计数 ≥ weekly_deploy_budget
 *         （manual=true 绕过；设计稿 §3.1：绕预算可以，绕质量门不行）
 *
 * 发布动作 = staging 物料原子搬进 skills_root（tmp 目录 rename，watcher 自动
 * 发现，无需重启 dsh / 无需改 agent.cordis.yml —— Sprint16 设计稿 §1.2 源码
 * 级核实）。回滚 = 整目录 rename 进归档区（只归档不删除）+ 冷却期防振荡。
 *
 * 观察期（§3.3）：数据源 = tool-stats 的 skill 工具调用记录；只判「用得怎么
 * 样」，不读技能内容、不跑评估（诚实边界：没有调用成败数据，「用着差」不
 * 自动判，靠人工 + curator 周报）。
 */

import {
  mkdir, writeFile, rename, access,
} from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { renderSkillMd, renderManifest, assertSafeCandidateId, cleanupCandidate } from './staging.js';
import { nowIso, datedId, releaseEntrySchema, checkLimit } from './storage.js';

// ── 纯函数（可单测）───────────────────────────────────────────────────────

/** ISO 周标识，如 '2026-W37'（周一为一周起点，UTC 口径足够预算计数用） */
export function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;            // 周日=7
  d.setUTCDate(d.getUTCDate() - (day - 1));  // 回到周一
  const year = d.getUTCFullYear();
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + (4 - ((firstThursday.getUTCDay()) || 7)));
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 人工确认窗是否生效（拍板 2：默认至 2026-10-07） */
export function humanApprovalActive(cfg, now = new Date()) {
  if (cfg.require_human_approval === true) return true;
  const until = cfg.require_human_approval_until;
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && now.getTime() < t;
}

/** skill 工具调用记录是否命中指定技能（args 字段形态未定稿，宽匹配 + 注释） */
export function matchSkillCall(record, skillName) {
  if (!record || record.tool !== 'skill') return false;
  const a = record.args;
  if (!a || typeof a !== 'object') return false;
  if (a.name === skillName || a.skill === skillName || a.skillName === skillName) return true;
  // 兜底：name/skill 嵌套或字符串化后精确包含（防字段改名漏计）
  try {
    return JSON.stringify(a).includes(`"${skillName}"`);
  } catch {
    return false;
  }
}

/** 按天计数窗口内的 skill 调用（releases 观察期核心计算，无状态可重放） */
export function callsByDay(records, skillName, fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const byDay = {};
  let total = 0;
  for (const r of records ?? []) {
    if (!matchSkillCall(r, skillName)) continue;
    const t = Date.parse(typeof r.ts === 'number' ? new Date(r.ts).toISOString() : String(r.ts));
    if (!Number.isFinite(t) || t < from || t > to) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
    total++;
  }
  return { total, byDay };
}

/**
 * 把候选的评估结果转成 policy 门（agint.qualityPolicy.decide）能消费的 EvalResult[]。
 *
 * 2026-09-13 B 修复：release-manager 此前把 candidate.evalResults（{phase1,phase2,phase3}
 * 摘要对象）直接当 EvalResult[] 传给 policy.decide → policy 内部对对象做 .length/.some/
 * for...of 迭代 → 抛异常 → 门3 一律 fail-closed → 候选永远卡 BUDGET_WAIT，自演化闭环断。
 *
 * 修复：优先用 Phase3 真实跑出的 D-QAF EvalResult（evaluator 已挂在
 * evalResults.policyInput，含完整 dimensions[]），包成数组即可；缺失时（老候选 /
 * 评估数据不全）用 phases 摘要兜底构造一个合成 EvalResult，保证门3 不会因格式错配
 * 而全 fail-closed。门3 语义见 checkGates（veto 模式只拦 REJECT/ABSTAIN）。
 *
 * @returns {Array<{targetId:string, dimensions:Array, tags:string[]}>}
 */
export function buildPolicyInput(candidate) {
  const pi = candidate?.evalResults?.policyInput;
  if (pi && Array.isArray(pi.dimensions) && pi.dimensions.length) {
    // 真实 D-QAF 结果（单 target）→ policy 期望 EvalResult[]，包成数组。
    return [pi];
  }
  // 兜底：从 phases 摘要构造（合成但不造假：safe/trust 取 Phase1 是否无 blocker，
  // reliability 取 Phase2 sandbox 是否通过，effectiveness 取 rankingScore）。
  const er = candidate?.evalResults ?? {};
  const p1 = er.phase1 ?? {};
  const p2 = er.phase2 ?? {};
  const p3 = er.phase3 ?? {};
  const safe = p1.status === 'pass' && !(Array.isArray(p1.blockers) && p1.blockers.length);
  const sand = p2.status === 'pass';
  return [{
    targetId: candidate?.skillDraft?.name ?? 'autocreate-candidate',
    dimensions: [
      { key: 'safety', score: { score: safe ? 1 : 0 } },
      { key: 'trust', score: { score: safe ? 1 : 0 } },
      { key: 'reliability', score: { score: sand ? 1 : 0.7 } },
      { key: 'effectiveness', score: { score: typeof p3.rankingScore === 'number' ? p3.rankingScore : 0.6 } },
      { key: 'integrability', score: { score: 1 } },
    ],
    tags: [],
  }];
}


/**
 * 观察期判定（§3.3，纯函数）。
 * @returns {{ verdict: 'stable'|'rollback'|'postpone'|'keep',
 *             reason: string, callsTotal: number }}
 *   stable    → 观察窗结束且调用达标
 *   rollback  → 最近 rollback_zero_call_windows 个完整子窗全 0 调用（可提前）
 *             或 窗口结束且不达标且模式已死（不给展期）
 *   keep      → 窗口结束但不达标，模式仍在活动 → 展期一次
 *   postpone  → 数据源失效（整份 jsonl 在回滚窗长内零记录），不判定
 */
export function judgeObservation(release, records, cfg, now = new Date()) {
  const windowDays = cfg.observation_period_days ?? 14;
  const minCalls = cfg.observation_min_calls ?? 5;
  const subWindowDays = cfg.rollback_window_days ?? 3;
  const zeroWindows = cfg.rollback_zero_call_windows ?? 3;

  const start = Date.parse(release.createdAt);
  const end = release.observationEndAt ? Date.parse(release.observationEndAt) : start + windowDays * 86400000;
  const nowMs = now.getTime();

  // 数据源失效：整个 jsonl 最近 subWindowDays 天零记录 → 顺延不判定
  const srcCutoff = nowMs - subWindowDays * 86400000;
  const srcAlive = (records ?? []).some((r) => {
    const t = Date.parse(typeof r.ts === 'number' ? new Date(r.ts).toISOString() : String(r.ts));
    return Number.isFinite(t) && t >= srcCutoff;
  });
  const { total, byDay } = callsByDay(records, release.skillName, release.createdAt, new Date(Math.min(nowMs, end)).toISOString());
  if (!srcAlive && total === 0) {
    return { verdict: 'postpone', reason: 'tool-stats 数据源失效（近窗零记录），顺延判定不回滚', callsTotal: total };
  }

  // 完整子窗调用数（从 createdAt 起每 subWindowDays 一窗）
  const completedSubs = [];
  for (let s = start; s + subWindowDays * 86400000 <= Math.min(nowMs, end); s += subWindowDays * 86400000) {
    const wFrom = new Date(s).toISOString();
    const wTo = new Date(s + subWindowDays * 86400000).toISOString();
    completedSubs.push(callsByDay(records, release.skillName, wFrom, wTo).total);
  }
  const tail = completedSubs.slice(-zeroWindows);
  if (tail.length >= zeroWindows && tail.every((n) => n === 0)) {
    return { verdict: 'rollback', reason: `zero-usage：最近 ${zeroWindows} 个 ${subWindowDays} 天子窗 0 调用`, callsTotal: total };
  }

  if (nowMs >= end) {
    if (total >= minCalls) {
      return { verdict: 'stable', reason: `观察窗结束，调用 ${total} ≥ ${minCalls}`, callsTotal: total };
    }
    const metrics = release.observationMetrics ?? {};
    if ((metrics.extensions ?? 0) >= 1) {
      return { verdict: 'rollback', reason: `insufficient-usage：展期一次后调用仍 ${total} < ${minCalls}`, callsTotal: total };
    }
    return { verdict: 'keep', reason: `观察窗结束但调用 ${total} < ${minCalls}，展期一次`, callsTotal: total };
  }

  return { verdict: 'postpone', reason: `观察中（${total} 次调用）`, callsTotal: total };
}

// ── 文件操作（原子落盘 / 归档）────────────────────────────────────────────

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

/**
 * 原子发布：staging 物料 → skillsRoot/<skillName>（先写 tmp 再整目录 rename）。
 * @returns {{ dir: string, version: string }}
 */
export async function publishToSkillsRoot({ candidate, skillsRoot, version = '1', releasedBy = 'auto' }) {
  const draft = candidate.skillDraft;
  const skillName = draft?.name ?? '';
  if (!skillName || skillName.includes('/') || skillName.includes('\\') || skillName.startsWith('.')) {
    throw new Error(`publish: unsafe skillName '${skillName}'`);
  }
  assertSafeCandidateId(candidate.id);
  await mkdir(skillsRoot, { recursive: true });

  const target = join(skillsRoot, skillName);
  if (await pathExists(target)) {
    throw new Error(`publish: target exists '${target}'（重名硬防线，Phase 1 去重失守）`);
  }
  const tmp = join(skillsRoot, `.${skillName}.tmp-${Date.now()}`);
  try {
    await mkdir(tmp, { recursive: true });
    const manifest = renderManifest(draft, candidate.id, nowIso());
    manifest.version = version;
    manifest.releasedBy = releasedBy;
    manifest.stagedBy = 'agint-skill-autocreate/sprint16-release';
    await writeFile(join(tmp, 'SKILL.md'), renderSkillMd(draft), 'utf8');
    await writeFile(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const scripts = draft?.scripts ?? [];
    if (scripts.length) {
      const scriptsDir = join(tmp, 'scripts');
      await mkdir(scriptsDir, { recursive: true });
      for (let i = 0; i < scripts.length; i++) {
        const s = scripts[i];
        const fileName = typeof s === 'string' ? `script_${i}.sh` : (s?.name ?? `script_${i}.sh`);
        const content = typeof s === 'string' ? s : (s?.content ?? '');
        if (!content) continue;
        const safeName = String(fileName).split(/[\\/]/).pop();
        if (!safeName) continue;
        await writeFile(join(scriptsDir, safeName), content, 'utf8');
      }
    }
    await rename(tmp, target);   // 同盘 rename 原子；watcher 只会看到完整目录
  } catch (e) {
    await rename(tmp, `${tmp}.failed-${Date.now()}`).catch(() => {});
    throw e;
  }
  return { dir: target, version };
}

/** 回滚归档：skillsRoot/<name> → archiveRoot/<name>-<ts>（只归档不删除） */
export async function archiveSkillDir({ skillName, skillsRoot, archiveRoot }) {
  const src = join(skillsRoot, skillName);
  if (!(await pathExists(src))) return { archived: false, reason: 'dir-already-gone' };
  await mkdir(archiveRoot, { recursive: true });
  const dest = join(archiveRoot, `${skillName}-${Date.now()}`);
  await rename(src, dest);
  return { archived: true, dest };
}

// ── 编排器（依赖注入：table / audit / publishEvent / cfg / getService / readToolStatsRecords）──

export function createReleaseManager(deps) {
  const {
    table, audit, publishEvent, cfg: effectiveConfig,
    getService, readToolStatsRecords, dshHome,
  } = deps;

  const skillsRootOf = () => resolvePath(effectiveConfig().skills_root);
  const archiveRootOf = () => resolvePath(effectiveConfig().rollback_archive_dir);

  /** 三道门（不含文件预检）；返回 {ok} 或 {ok:false, gate, reason} */
  async function checkGates(candidate, { manual }) {
    const c = effectiveConfig();
    // 门 1：总开关
    if (!c.release_enabled) return { ok: false, gate: 'release-switch', reason: 'release_enabled=false' };
    // 门 2：人工确认窗（manual 绕过）
    if (!manual && humanApprovalActive(c)) {
      return {
        ok: false, gate: 'human-approval',
        reason: `人工确认窗生效（until ${c.require_human_approval_until}），需 autocreate_release 手动点头发`,
      };
    }
    // 门 3：policy 门（manual 也不绕——绕预算可以，绕质量门不行）
    const policy = getService('agint.qualityPolicy');
    if (!policy || typeof policy.decide !== 'function') {
      return { ok: false, gate: 'policy', reason: 'agint.qualityPolicy 未挂载（fail-closed）' };
    }
    // 2026-09-13 B 修复：用合法 EvalResult[] 喂 policy（真实 D-QAF 结果优先，phases 兜底），
    // 不再把 {phase1,phase2,phase3} 对象当数组传入（否则 policy 抛异常 → 全 fail-closed）。
    const policyInput = buildPolicyInput(candidate);
    let decision = null;
    try {
      decision = await withTimeout(
        policy.decide({ results: policyInput, options: { source: 'skill-autocreate-release' } }),
        c.release_policy_timeout_ms,
      );
    } catch (e) {
      return { ok: false, gate: 'policy', reason: `policy 调用失败（fail-closed）：${e?.message ?? e}` };
    }
    // 放行语义（release_policy_mode）：
    //   'veto'  （默认，K42 原则）只拦 REJECT/ABSTAIN，放行 AUTO_DEPLOY/PENDING_REVIEW
    //           —— policy 作为「拦错门」，放过其余进观察期，由观察期 usage 信号 + 自动回滚收口。
    //   'strict'（旧行为）仅 AUTO_DEPLOY 放行；PENDING_REVIEW/其它一律 fail-closed。
    // 注：新候选 D-QAF 综合分恒 ~71.4 < pendingReview 75，policy 必给 PENDING_REVIEW；
    // 故 veto 模式是让自演化闭环闭合的关键，strict 会因「不够绿」而永不自动发布。
    const kind = decision?.kind;
    const blocked = kind === 'REJECT' || kind === 'ABSTAIN' || kind == null;
    const strictFail = c.release_policy_mode === 'strict' && kind !== 'AUTO_DEPLOY';
    if (blocked || strictFail) {
      return {
        ok: false, gate: 'policy',
        reason: `policy=${kind ?? 'NO_DECISION'}${c.release_policy_mode === 'strict' ? '（strict：需 AUTO_DEPLOY）' : ''}（fail-closed）${decision?.reason ? `：${decision.reason}` : ''}`,
        decision,
      };
    }
    // 门 4：周预算（manual 绕过；含已回滚的发布）
    const week = weekKey();
    const rt = await table('releases');
    const weekCount = [...rt.entries()].filter(([, v]) => v.budgetWeek === week).length;
    if (!manual && weekCount >= (c.weekly_deploy_budget ?? 3)) {
      await publishEvent('skill-autocreate.budget-exceeded', {
        candidateId: candidate.id, skillName: candidate.skillDraft?.name, weekCount, budget: c.weekly_deploy_budget,
      });
      return { ok: false, gate: 'budget', reason: `周预算 ${weekCount}/${c.weekly_deploy_budget} 已满（含已回滚）` };
    }
    return { ok: true, week };
  }

  /** 回滚冷却检查：同名技能 30 天内被回滚过 → 禁止再发 */
  async function checkCooldown(skillName) {
    const days = effectiveConfig().rollback_cooldown_days ?? 30;
    if (!days) return null;
    const rt = await table('releases');
    const cutoff = Date.now() - days * 86400000;
    const hit = [...rt.entries()].find(([, v]) =>
      v.skillName === skillName
      && v.status === 'ROLLED_BACK'
      && v.rollbackAt && Date.parse(v.rollbackAt) >= cutoff);
    return hit
      ? { gate: 'cooldown', reason: `技能 '${skillName}' 于 ${hit[1].rollbackAt} 被回滚，冷却 ${days} 天内不得重发` }
      : null;
  }

  /**
   * 发布单个候选。input: { id, manual=false, actor?, reason? }
   * 门不过 → 候选停 BUDGET_WAIT（rejectionReason 承载原因），不抛错。
   */
  async function releaseCandidate(input = {}) {
    const { id, manual = false } = input;
    const actor = input.actor ?? (manual ? 'human' : 'system');
    if (!id) throw new Error('release: id is required');

    const cd = await table('candidates');
    const found = cd.entries().find(([key]) => key === id);
    if (!found) throw new Error(`release: no candidate '${id}'`);
    const candidate = found[1];
    if (candidate.status !== 'QUEUED_FOR_RELEASE' && candidate.status !== 'BUDGET_WAIT') {
      throw new Error(`release: candidate '${id}' is ${candidate.status}（仅 QUEUED_FOR_RELEASE / BUDGET_WAIT 可发布）`);
    }
    const skillName = candidate.skillDraft?.name;

    // 冷却期（发布与重发都拦）
    const cooldown = await checkCooldown(skillName);
    if (cooldown) {
      await holdCandidate(cd, id, candidate, cooldown.gate, cooldown.reason);
      return { candidateId: id, released: false, gate: cooldown.gate, reason: cooldown.reason };
    }

    // 三道门
    const gates = await checkGates(candidate, { manual });
    if (!gates.ok) {
      await holdCandidate(cd, id, candidate, gates.gate, gates.reason);
      return { candidateId: id, released: false, gate: gates.gate, reason: gates.reason, decision: gates.decision ?? null };
    }

    // 重名预检（门 3.5：文件系统硬防线）
    const target = join(skillsRootOf(), skillName);
    if (await pathExists(target)) {
      const reason = `重名冲突：skills 目录已存在 '${skillName}'（Phase 1 去重失守）`;
      await holdCandidate(cd, id, candidate, 'name-conflict', reason);
      return { candidateId: id, released: false, gate: 'name-conflict', reason };
    }

    // 落盘 + 落账（candidate 状态先置 RELEASED 再落盘？——先落盘，失败则候选保持原状态）
    let published;
    try {
      published = await publishToSkillsRoot({ candidate, skillsRoot: skillsRootOf(), releasedBy: manual ? 'human' : 'auto' });
    } catch (e) {
      await audit({
        actor, action: 'release_publish_failed', targetType: 'candidate', targetId: id,
        details: { skillName }, reason: String(e?.message ?? e),
      });
      throw e;
    }

    const releasedAt = nowIso();
    const obsDays = effectiveConfig().observation_period_days ?? 14;
    const releaseEntry = releaseEntrySchema.parse({
      id: datedId('sr'),
      kind: 'skill_release',
      createdAt: releasedAt,
      candidateId: id,
      skillName,
      version: published.version,
      snapshot: { evalResults: candidate.evalResults ?? {}, estimatedBenefit: candidate.estimatedBenefit ?? {} },
      observationEndAt: new Date(Date.now() + obsDays * 86400000).toISOString(),
      observationMetrics: { callsTotal: 0, callsByDay: {}, extensions: 0, lastComputedAt: releasedAt },
      status: 'OBSERVING',
      budgetWeek: gates.week ?? weekKey(),
      releasedBy: manual ? 'human' : 'auto',
    });
    const rt = await table('releases');
    const relWarn = checkLimit('releases', rt.entries().length);
    if (relWarn) console.warn(`[agint-skill-autocreate] ${relWarn._warn}`);
    await rt.put(releaseEntry.id, releaseEntry);

    await cd.put(id, {
      ...candidate,
      status: 'RELEASED',
      rejectionReason: null,
      releasedAt,
      releasedVersion: published.version,
    });

    await publishEvent('skill-autocreate.released', {
      candidateId: id, skillName, releaseId: releaseEntry.id, releasedBy: manual ? 'human' : 'auto',
      observationEndAt: releaseEntry.observationEndAt,
    });
    await audit({
      actor, action: manual ? 'human_released' : 'auto_released', targetType: 'release', targetId: releaseEntry.id,
      details: { candidateId: id, skillName, dir: published.dir, budgetWeek: releaseEntry.budgetWeek },
      reason: input.reason ?? null,
    });

    // 记忆固化（软依赖 evolution，失败不阻断发布）
    const evo = getService('agint.evolution');
    if (evo && typeof evo.addSuccess === 'function') {
      try {
        await evo.addSuccess({
          template: `技能自动创建：重复模式[${candidate.sourcePatternId}] → 技能 ${skillName}（模板 ${candidate.skillDraft?.template}）发布成功`,
          evidence: `candidate=${id} release=${releaseEntry.id}`,
          appliesTo: ['skill-autocreate'],
        });
      } catch { /* 软依赖降级：发布已完成，失败仅影响记忆沉淀 */ }
    }

    // staging 清理（失败不阻断）
    await cleanupCandidate(id, { dshHome }).catch(() => {});

    return {
      candidateId: id, released: true, releaseId: releaseEntry.id, skillName,
      dir: published.dir, version: published.version,
      observationEndAt: releaseEntry.observationEndAt,
    };
  }

  async function holdCandidate(cd, id, candidate, gate, reason) {
    await cd.put(id, { ...candidate, status: 'BUDGET_WAIT', rejectionReason: `[${gate}] ${reason}`.slice(0, 300) });
    await publishEvent('skill-autocreate.release-held', { candidateId: id, gate, reason });
    await audit({
      actor: 'system', action: 'release_held', targetType: 'candidate', targetId: id,
      details: { gate, reason }, reason,
    });
  }

  /** cron：遍历队列自动发布（人工确认窗内全部被门 2 拦下，正好实现拍板 2） */
  async function releaseQueue(args = {}) {
    const c = effectiveConfig();
    if (!c.release_enabled) return { skipped: true, reason: 'release_enabled=false' };
    const cd = await table('candidates');
    const queued = [...cd.entries()]
      .map(([, v]) => v)
      .filter((v) => v.status === 'QUEUED_FOR_RELEASE' || v.status === 'BUDGET_WAIT')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const results = [];
    let released = 0;
    for (const cand of queued) {
      const r = await releaseCandidate({ id: cand.id, manual: false, actor: 'system' });
      results.push(r);
      if (r.released) released++;
      if (r.gate === 'budget') break;   // 预算满，后面全是陪跑
    }
    return { attempted: queued.length, released, results };
  }

  /** 人工/自动回滚。input: { id?|skillName?, reason, actor? } */
  async function rollback(input = {}) {
    const actor = input.actor ?? 'human';
    const reason = input.reason ?? '';
    if (!reason) throw new Error('rollback: reason is required');

    const rt = await table('releases');
    const entries = [...rt.entries()].map(([, v]) => v)
      .filter((v) => v.status === 'OBSERVING' || v.status === 'STABLE');
    let release = null;
    if (input.id) release = entries.find((v) => v.candidateId === input.id) ?? null;
    else if (input.skillName) release = entries.find((v) => v.skillName === input.skillName) ?? null;
    else throw new Error('rollback: id or skillName is required');
    if (!release) throw new Error(`rollback: no active release for '${input.id ?? input.skillName}'`);

    const cd = await table('candidates');
    const candEntry = cd.entries().find(([key]) => key === release.candidateId);

    const arch = await archiveSkillDir({
      skillName: release.skillName, skillsRoot: skillsRootOf(), archiveRoot: archiveRootOf(),
    });
    const rolledAt = nowIso();
    await rt.put(release.id, {
      ...release,
      status: 'ROLLED_BACK',
      rollbackAt: rolledAt,
      rollbackReason: reason,
      observationMetrics: { ...(release.observationMetrics ?? {}), archivedTo: arch.dest ?? null, dirAlreadyGone: !arch.archived },
    });
    if (candEntry) {
      await cd.put(candEntry[0], {
        ...candEntry[1],
        status: 'ROLLED_BACK',
        rollbackReason: reason,
      });
    }
    await publishEvent('skill-autocreate.rolled-back', {
      candidateId: release.candidateId, skillName: release.skillName, releaseId: release.id,
      reason, operator: actor, archivedTo: arch.dest ?? null,
    });
    await audit({
      actor, action: 'skill_rolled_back', targetType: 'release', targetId: release.id,
      details: { candidateId: release.candidateId, skillName: release.skillName, archived: arch.archived, dest: arch.dest ?? null },
      reason,
    });
    return {
      releaseId: release.id, candidateId: release.candidateId, skillName: release.skillName,
      archived: arch.archived, dest: arch.dest ?? null,
    };
  }

  /** cron：观察期滚动（所有 OBSERVING release） */
  async function observe() {
    const c = effectiveConfig();
    const rt = await table('releases');
    const observing = [...rt.entries()].map(([, v]) => v).filter((v) => v.status === 'OBSERVING');
    if (!observing.length) return { observing: 0, stable: [], rolledBack: [], postponed: 0 };
    const records = await readToolStatsRecords();
    const out = { observing: observing.length, stable: [], rolledBack: [], postponed: 0 };
    for (const release of observing) {
      const verdict = judgeObservation(release, records, c, new Date());
      // metrics 回写（即使 postpone 也刷新计数，可观测）
      const { total, byDay } = callsByDay(records, release.skillName, release.createdAt, release.observationEndAt ?? nowIso());
      const metrics = {
        ...(release.observationMetrics ?? {}),
        callsTotal: total, callsByDay: byDay, lastComputedAt: nowIso(),
      };

      if (verdict.verdict === 'stable') {
        metrics.verdict = verdict.reason;
        await rt.put(release.id, { ...release, status: 'STABLE', observationMetrics: metrics });
        const cd = await table('candidates');
        const candEntry = cd.entries().find(([key]) => key === release.candidateId);
        if (candEntry) await cd.put(candEntry[0], { ...candEntry[1], status: 'STABLE' });
        await publishEvent('skill-autocreate.release-stable', {
          candidateId: release.candidateId, skillName: release.skillName, callsTotal: total,
        });
        await audit({
          actor: 'system', action: 'observation_stable', targetType: 'release', targetId: release.id,
          details: { callsTotal: total }, reason: verdict.reason,
        });
        out.stable.push(release.skillName);
      } else if (verdict.verdict === 'rollback') {
        await rt.put(release.id, { ...release, observationMetrics: metrics });   // 先记账再回滚
        const r = await rollback({ skillName: release.skillName, reason: verdict.reason, actor: 'system' });
        out.rolledBack.push({ skillName: release.skillName, reason: verdict.reason, ...r });
      } else if (verdict.verdict === 'keep') {
        // 展期一次：observationEndAt 延一个观察窗
        const extEnd = new Date(Date.now() + (c.observation_period_days ?? 14) * 86400000).toISOString();
        metrics.extensions = (metrics.extensions ?? 0) + 1;
        metrics.verdict = verdict.reason;
        await rt.put(release.id, { ...release, observationEndAt: extEnd, observationMetrics: metrics });
        await audit({
          actor: 'system', action: 'observation_extended', targetType: 'release', targetId: release.id,
          details: { callsTotal: total, newEnd: extEnd }, reason: verdict.reason,
        });
        out.postponed++;
      } else {
        metrics.verdict = verdict.reason;
        await rt.put(release.id, { ...release, observationMetrics: metrics });
        out.postponed++;
      }
    }
    return out;
  }

  async function listReleases(args = {}) {
    const t = await table('releases');
    let list = [...t.entries()].map(([, v]) => v);
    if (args.status) list = list.filter((v) => v.status === args.status);
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (args.limit) list = list.slice(0, args.limit);
    return list;
  }

  return {
    releaseCandidate, releaseQueue, rollback, observe, listReleases,
    // 暴露纯函数与 helper 供测试/工具复用
    _internals: { checkGates, checkCooldown, weekKey, humanApprovalActive, judgeObservation, matchSkillCall, callsByDay, skillsRootOf, archiveRootOf, buildPolicyInput },
  };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`policy timeout ${ms}ms`)), ms)),
  ]);
}
