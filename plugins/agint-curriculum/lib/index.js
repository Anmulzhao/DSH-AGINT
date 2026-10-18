/**
 * agint-curriculum — P7 自主课程生成器（Sprint 14 Part B）。
 *
 * 定位（§4.1）：让 AGINT 主动去找自己不会的东西练，而不是等任务来了才暴露
 * 能力缺口。消费 self-model（v0.7.1）的能力画像，在 UNCERTAIN / 久未复验 /
 * miscalibrated 的域上生成挑战，执行后用**可验证的结果**回写。
 *
 * Service（§4.8）：
 *   agint.curriculum.probe({ force? })           → 边界探测 → 待练域列表
 *   agint.curriculum.generate({ domain, count? })→ 生成挑战（带可自动判定条件）
 *   agint.curriculum.nextChallenge({ domain? })  → 出队（不自动执行，§4.5）
 *   agint.curriculum.submit({ challengeId, evidence }) → 提交 + 判定 + 回写
 *   agint.curriculum.stats()                     → 各域完成率/难度档
 *   agint.curriculum.difficulty({ domain })      → 单域难度详情
 *
 * 硬约束：
 *   - §4.2 方案 B：A11 只当触发器，数据一律走 snapshot()（零 L0 改动）
 *   - §4.4 C1/C2/C3：判定外部化（verdict.js）
 *   - §4.5：不自动执行（executor 只出队/分发）
 *   - §4.9：判定权和写入权分离——只调 self-model.update() 提供证据，
 *     不直接改 capability 表
 *   - D1：挑战自带 sessionId 前缀 curriculum-（本插件持 D4 黑名单副本）
 *
 * Sprint 14 明确不挂载 prod（观察窗 10 月底才满足）；仅仓库实现 + 测试。
 */

import { ConfigSchema, RUNTIME_CONFIG_KEYS, TEMPLATE_DOMAINS, DIFFICULTY_LEVELS } from './schema.js';
import {
  spec,
  checkLimit,
  LIMITS,
  packChallenge,
  packAttempt,
  packDifficulty,
  packAudit,
  nowIso,
  datedId,
  challengeSessionId,
} from './storage.js';
import { probeDomains } from './boundary-probe.js';
import { generateChallenge, hasTemplate, bankSize, totalBankSize } from './challenge-gen.js';
import { judge } from './verdict.js';
import { recordVerdict, adjustDifficulty } from './difficulty.js';

const name = 'agint-curriculum';
const inject = ['storageDomain'];

function apply(ctx, config) {
  const cfg = ConfigSchema.parse(config ?? {});
  let domain = null;
  let domainError = null;
  let disposed = false;
  let paused = false;
  let lastProbeAt = null;
  const runtimeOverrides = new Map();

  ctx.effect(() => () => {
    disposed = true;
    if (domain) return domain.close();
    return undefined;
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) { void d.close().catch(() => {}); return null; }
      domain = d;
      return d;
    },
    (error) => { domainError = error; return null; },
  );

  const table = async (tableName) => {
    if (disposed) throw new Error(`${name}: disposed`);
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error(`${name}: domain unavailable`);
    return d.table(tableName);
  };

  const effectiveConfig = () => {
    const merged = { ...cfg };
    for (const [k, v] of runtimeOverrides) merged[k] = v;
    return merged;
  };

  // ── 事件发布（软依赖 event-bus，降级不抛）──────────────────────────────
  async function publishEvent(topic, payload) {
    const p = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
    if (typeof p !== 'function') return false;
    try {
      await p({ topic, version: 1, source: name, payload });
      return true;
    } catch (e) {
      if (!disposed) console.error(`[${name}] publish ${topic} failed:`, e?.message ?? e);
      return false;
    }
  }

  // ── audit（唯一自动滚动清理的表）───────────────────────────────────────
  async function audit(entry) {
    const t = await table('audit_log');
    const record = packAudit(entry);
    await t.put(record.id, record);
    const entries = t.entries();
    const warn = checkLimit('audit_log', entries.length);
    if (warn) {
      const overflow = entries.length - warn.limit;
      if (overflow > 0) {
        const del = typeof t.del === 'function' ? (k) => t.del(k) : null;
        if (del) {
          const sorted = [...entries].sort((a, b) => String(a[1].timestamp).localeCompare(String(b[1].timestamp)));
          for (const [key] of sorted.slice(0, overflow)) await del(key).catch(() => {});
        }
      }
    }
    return record;
  }

  // ── self-model 访问（软降级：不可用 → null，probe 返回 skipped）─────────
  //
  // ⚠️ 2026-09-09 挂载前修复：agint-self-model 实际只 provide **全名子键**
  // （agint.selfModel.snapshot / .update / .calibrate / .stats / .inspectSummary），
  // 而 cordis 的 service store 是扁平的（reflect._getImpl 按确切键名查），
  // 所以 ctx.get('agint.selfModel') 恒为 undefined → probe() 永远走软降级，
  // 一个待练域都找不出来。全仓其它消费方（如 agint-quality-eval）都是按全名
  // 子键取的，这里对齐同一惯例：优先父键（未来若 self-model 改为注册对象），
  // 否则按子键组装成 { snapshot, update }。
  function getSelfModel() {
    if (typeof ctx.get !== 'function') return null;
    const direct = ctx.get('agint.selfModel');
    if (direct && typeof direct === 'object') return direct;
    const snapshot = ctx.get('agint.selfModel.snapshot');
    const update = ctx.get('agint.selfModel.update');
    if (typeof snapshot !== 'function' && typeof update !== 'function') return null;
    return { snapshot, update };
  }

  async function readSnapshot() {
    const sm = getSelfModel();
    if (!sm || typeof sm.snapshot !== 'function') return null;
    try {
      return await sm.snapshot({});
    } catch {
      return null;
    }
  }

  // ── 读取/写入难度状态 ──────────────────────────────────────────────────
  async function readDifficulty(domainName) {
    const t = await table('difficulty_state');
    const id = `df_${domainName}`;
    const existing = t.entries().find(([, v]) => v.id === id);
    return existing ? existing[1] : {
      id,
      domain: domainName,
      level: 'D1',
      windowResults: [],
      consecutivePass: 0,
      consecutiveFail: 0,
      cannotCandidate: false,
      lastGeneratedAt: null,
      lastAdjustedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  async function writeDifficulty(state) {
    const t = await table('difficulty_state');
    const packed = packDifficulty(state, state);
    await t.put(packed.id, packed);
    const warn = checkLimit('difficulty_state', t.size);
    if (warn) console.warn(`[${name}] ${warn._warn}`);
    return packed;
  }

  // ── Service: probe（§4.3 [1]）──────────────────────────────────────────
  async function probe(args = {}) {
    const c = effectiveConfig();
    if (args.force !== true && paused) {
      return { skipped: true, reason: 'paused（curriculum_pause）' };
    }
    const snapshot = await readSnapshot();
    if (!snapshot) {
      return { skipped: true, reason: 'self-model snapshot 不可用（软降级）' };
    }
    const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
    const { domains, unverifiable } = probeDomains(snapshot, {
      staleReverifyDays: c.stale_reverify_days,
      nowMs,
    });
    lastProbeAt = nowIso();
    await publishEvent('curriculum.boundary-probed', {
      domains: domains.map((d) => d.domain),
      unverifiable: unverifiable.map((d) => d.domain),
    });
    return { skipped: false, domains, unverifiable, probedAt: lastProbeAt };
  }

  // ── Service: generate（§4.3 [2] + 7.1 冷却/上限）────────────────────────
  async function generate(args = {}) {
    const c = effectiveConfig();
    const domainName = args.domain;
    if (!domainName || typeof domainName !== 'string') {
      throw new Error('generate: domain is required');
    }
    if (!hasTemplate(domainName)) {
      return {
        skipped: true,
        reason: `domain "${domainName}" 无模板（可自动判定域仅 ${TEMPLATE_DOMAINS.join('/')}，C1/Q5 诚实留白）`,
        unverifiable: true,
      };
    }
    if (!args.force && paused) {
      return { skipped: true, reason: 'paused（curriculum_pause）' };
    }

    const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
    const df = await readDifficulty(domainName);

    // 同域 24h 冷却（7.1 防挑战生成量爆炸）
    if (!args.force && df.lastGeneratedAt) {
      const last = Date.parse(df.lastGeneratedAt);
      if (!Number.isNaN(last) && nowMs - last < c.challenge_cooldown_hours * 60 * 60 * 1000) {
        const hoursLeft = Math.ceil((c.challenge_cooldown_hours * 60 * 60 * 1000 - (nowMs - last)) / (60 * 60 * 1000));
        return { skipped: true, reason: `domain "${domainName}" 冷却中（剩约 ${hoursLeft}h）` };
      }
    }

    const count = Math.max(1, Math.min(
      Number.isInteger(args.count) ? args.count : 1,
      c.generation_batch_limit,
    ));

    const ct = await table('challenges');

    // ── 生成期去重 + 题目池选variant（v0.1.4 / v0.1.5）──────────────────────
    // challenge-gen 是 (domain, level, variant) 的确定性纯函数，没有去重就会
    // 每周产出逐字相同的题面（2026-10-08 / 10-15 两批生产数据实测同题）。
    //
    // 窗口内同 domain+level+prompt 视为重复。撞重时的顺序是：
    //   1. 先在本档内换 variant（同难度换题，不动档位）——v0.1.5 新增
    //   2. 本档题池用完，才沿 DIFFICULTY_LEVELS 向上顺延
    //   3. 全档位都出过 → 如实 skipped（题目池耗尽，等 dedup 窗口过期复验）
    // 顺延原因写进 audit_log.reason，不伪装成「能力提升带来的升档」。
    // dedup_window_days = 0 关闭去重；force=true 同样绕过（与冷却语义一致）。
    const dedupWindowMs = c.dedup_window_days * 24 * 60 * 60 * 1000;
    const dedupOn = c.dedup_window_days > 0 && args.force !== true;
    const seenPrompts = new Map(); // `${level}|${prompt}` → 最近一条同域挑战
    if (dedupOn) {
      for (const [, ch] of ct.entries()) {
        if (ch.domain !== domainName) continue;
        const ts = Date.parse(ch.createdAt);
        if (Number.isNaN(ts) || nowMs - ts > dedupWindowMs) continue;
        const key = `${ch.level}|${ch.prompt}`;
        const prev = seenPrompts.get(key);
        if (!prev || Date.parse(prev.createdAt) < ts) seenPrompts.set(key, ch);
      }
    }

    const nextLevelOf = (lvl) => {
      const i = DIFFICULTY_LEVELS.indexOf(lvl);
      return i >= 0 && i + 1 < DIFFICULTY_LEVELS.length ? DIFFICULTY_LEVELS[i + 1] : null;
    };

    const created = [];
    const duplicates = [];
    let startLevel = df.level;
    for (let i = 0; i < count; i++) {
      let picked = null;
      for (let lvl = startLevel; lvl; lvl = nextLevelOf(lvl)) {
        // 本档题池逐个 variant 试；池子用完再上顺延下一档
        const poolSize = Math.max(1, bankSize(domainName, lvl));
        for (let v = 0; v < poolSize; v++) {
          const challengeId = datedId('clg');
          const business = generateChallenge(domainName, lvl, {
            sessionId: challengeSessionId(challengeId),
            variant: v,
          });
          const key = `${business.level}|${business.prompt}`;
          const dup = dedupOn ? seenPrompts.get(key) : undefined;
          if (!dup) { picked = { challengeId, business, key, level: lvl }; break; }
          duplicates.push({ existingId: dup.id, level: lvl, prompt: business.prompt });
        }
        if (picked) break;
      }
      if (!picked) break; // 该域全部档位 × 全部 variant 都出过

      const packed = packChallenge({
        ...picked.business,
        id: picked.challengeId,
        // createdAt 跟随 nowMs（generate 的可注入时间基准），让去重窗口、
        // 冷却与审计时间戳共用一个时钟；生产路径 nowMs 即 Date.now()。
        createdAt: new Date(nowMs).toISOString(),
      });
      await ct.put(packed.id, packed);
      seenPrompts.set(picked.key, packed);
      created.push(packed);
      // 本轮已用掉该档一个题面：下一轮从下一档起找，避免 count>1 时产重复
      startLevel = nextLevelOf(picked.level) ?? picked.level;
    }
    const warn = checkLimit('challenges', ct.size);
    if (warn) console.warn(`[${name}] ${warn._warn}`);

    // 全部撞重（该域题面耗尽）：不写 lastGeneratedAt —— 没生成就不能假装生成过，
    // 否则白白烧掉 24h 冷却。如实返回 skipped。
    if (created.length === 0) {
      return {
        skipped: true,
        reason: `domain "${domainName}" 在 ${c.dedup_window_days} 天内 ${df.level}-D5 全部题面（共 ${totalBankSize(domainName)} 道）均已出过（题目池耗尽；force=true 可绕过，或继续扩题库）`,
        domain: domainName,
        level: df.level,
        duplicates,
      };
    }

    // 只写 lastGeneratedAt，**不写 level**：顺延是“题面耗尽”，不是能力提升。
    // 难度档只能由 submit 的判定证据推动（difficulty.js 的 40%-70% 护栏 + 连续序列），
    // 让去重顺手改档等于用行为证据伪造能力结论。
    const usedLevels = [...new Set(created.map((c) => c.level))];
    const shifted = created.some((c) => c.level !== df.level);
    await writeDifficulty({ ...df, lastGeneratedAt: new Date(nowMs).toISOString() });
    await audit({
      actor: 'system',
      action: 'challenge_generated',
      targetType: 'challenge',
      targetId: created.map((c) => c.id).join(','),
      details: {
        domain: domainName,
        level: df.level,
        challengeLevels: usedLevels,
        bankSizeAtLevel: bankSize(domainName, df.level),
        totalBankSize: totalBankSize(domainName),
        count,
        generatedCount: created.length,
        dedupSkipped: duplicates.length,
      },
      reason: shifted
        ? `同档题面用尽，顺延难度档（${df.level} → ${usedLevels.join('/')}；仅影响本次题面，未计入难度升降；boundary-probe 驱动的挑战生成）`
        : 'boundary-probe 驱动的挑战生成',
    });
    await publishEvent('curriculum.challenge-created', {
      domain: domainName,
      level: df.level,
      challengeIds: created.map((c) => c.id),
    });

    return {
      skipped: false,
      domain: domainName,
      level: df.level,
      challengeLevels: usedLevels,
      levelShifted: shifted,
      generated: created.map((c) => ({
        id: c.id, domain: c.domain, level: c.level, status: c.status,
        prompt: c.prompt, passCriteria: c.passCriteria, sessionId: c.sessionId,
      })),
      duplicates,
    };
  }

  // ── Service: nextChallenge（§4.5：出队/分发，不自动执行）────────────────
  async function nextChallenge(args = {}) {
    const ct = await table('challenges');
    const all = [...ct.entries()].map(([, v]) => v);
    let pool = all.filter((c) => c.status === 'open');
    if (args.domain) {
      pool = pool.filter((c) => c.domain === args.domain);
    }
    if (pool.length === 0) {
      return { skipped: true, reason: '无 open 挑战（可先 probe + generate）' };
    }
    pool.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const pick = pool[0];
    const updated = { ...pick, status: 'in_progress', updatedAt: nowIso() };
    await ct.put(updated.id, updated);
    await audit({
      actor: 'agent',
      action: 'challenge_next',
      targetType: 'challenge',
      targetId: pick.id,
      details: { domain: pick.domain, level: pick.level },
      reason: '挑战出队（agent 领取）',
    });
    return {
      skipped: false,
      challenge: {
        id: pick.id,
        domain: pick.domain,
        level: pick.level,
        prompt: pick.prompt,
        passCriteria: pick.passCriteria,
        sessionId: pick.sessionId,   // D1：执行请使用该 sessionId（curriculum- 前缀）
        verifySpec: pick.verifySpec, // 只读展示，判定由系统执行（C1）
      },
    };
  }

  // ── Service: submit（§4.4 判定 + §4.9 回写）─────────────────────────────
  async function submit(args = {}) {
    const c = effectiveConfig();
    const { challengeId, evidence } = args;
    if (!challengeId) throw new Error('submit: challengeId is required');
    if (!evidence || typeof evidence !== 'object') {
      throw new Error('submit: evidence is required（C3：无证据不记 pass）');
    }

    const ct = await table('challenges');
    const hit = [...ct.entries()].find(([, v]) => v.id === challengeId);
    if (!hit) throw new Error(`submit: challenge "${challengeId}" 不存在`);
    const challenge = hit[1];

    const verdict = judge(challenge, evidence, { requireEvidence: c.require_evidence !== false });

    // 落 attempts（C2：selfAssessment 剥离为 notes；C3：evidence 原样留档）
    const at = await table('attempts');
    const attempt = packAttempt({
      challengeId,
      domain: challenge.domain,
      templateType: challenge.templateType,
      level: challenge.level,
      result: verdict.result,
      evidence: verdict.evidence,
      selfAssessment: verdict.notes,
      reason: verdict.reason,
      verifiedAt: nowIso(),
    });
    await at.put(attempt.id, attempt);
    const aw = checkLimit('attempts', at.size);
    if (aw) console.warn(`[${name}] ${aw._warn}`);

    // 更新挑战状态
    const updatedChallenge = {
      ...challenge,
      status: verdict.result === 'pass' ? 'passed' : 'failed',
      attemptCount: (challenge.attemptCount ?? 0) + 1,
      updatedAt: nowIso(),
    };
    await ct.put(updatedChallenge.id, updatedChallenge);

    // 难度调节（§4.6）
    const df = await readDifficulty(challenge.domain);
    const recorded = recordVerdict(df, { result: verdict.result, at: attempt.verifiedAt }, {
      windowDays: c.difficulty_window_days,
    });
    const adjusted = adjustDifficulty(recorded, {
      minSamples: c.difficulty_min_samples,
      passFloor: c.pass_floor,
      passCeiling: c.pass_ceiling,
      forcePromoteStreak: c.force_promote_streak,
      forceDemoteStreak: c.force_demote_streak,
    });
    await writeDifficulty({ ...recorded, ...adjusted, lastAdjustedAt: nowIso() });

    // 事件（§4.8）
    await publishEvent('curriculum.challenge-verdicted', {
      challengeId, domain: challenge.domain, result: verdict.result, reason: verdict.reason,
    });
    if (adjusted.action !== 'keep') {
      await publishEvent('curriculum.difficulty-adjusted', {
        domain: challenge.domain,
        from: challenge.level,
        to: adjusted.level,
        action: adjusted.action,
      });
    }

    // §4.9 self-model 回写：只提供证据，由 self-model 决定是否更新 capability
    if (c.self_model_writeback !== false) {
      const sm = getSelfModel();
      if (sm && typeof sm.update === 'function') {
        try {
          await sm.update({
            trigger: verdict.result === 'pass' ? 'task-completed' : 'task-failed',
            evidence: {
              domain: challenge.domain,
              source: 'agint-curriculum',
              challengeId,
              templateType: challenge.templateType,
              level: challenge.level,
              result: verdict.result,
              verifiedAt: attempt.verifiedAt,
              notes: verdict.notes ?? undefined,
            },
          });
        } catch { /* 回写失败不影响判定（软依赖） */ }
      }
    }

    await audit({
      actor: 'agent',
      action: 'challenge_verdicted',
      targetType: 'challenge',
      targetId: challengeId,
      details: { domain: challenge.domain, result: verdict.result, level: challenge.level },
      reason: verdict.reason,
    });

    return {
      challengeId,
      result: verdict.result,
      reason: verdict.reason,
      notes: verdict.notes,
      domain: challenge.domain,
      levelBefore: challenge.level,
      levelAfter: adjusted.level,
      difficultyAction: adjusted.action,
      windowStats: adjusted.windowStats,
    };
  }

  // ── Service: list（B-8 curriculum_list 的支撑）─────────────────────────
  async function list(filter = {}) {
    const t = await table('challenges');
    let list = [...t.entries()].map(([, v]) => v);
    if (filter.status) list = list.filter((c) => c.status === filter.status);
    if (filter.domain) list = list.filter((c) => c.domain === filter.domain);
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (filter.limit) list = list.slice(0, filter.limit);
    return list;
  }

  // ── Service: stats ─────────────────────────────────────────────────────
  async function stats() {
    const [ct, at, dt, al] = await Promise.all([
      table('challenges'), table('attempts'), table('difficulty_state'), table('audit_log'),
    ]);
    const challenges = [...ct.entries()].map(([, v]) => v);
    const attempts = [...at.entries()].map(([, v]) => v);
    const difficulties = [...dt.entries()].map(([, v]) => v);

    const byStatus = challenges.reduce((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});
    const byResult = attempts.reduce((m, a) => ({ ...m, [a.result]: (m[a.result] ?? 0) + 1 }), {});
    const byDomain = {};
    for (const d of difficulties) {
      const total = d.windowResults?.length ?? 0;
      const passed = d.windowResults?.filter((r) => r.result === 'pass').length ?? 0;
      byDomain[d.domain] = {
        level: d.level,
        windowSamples: total,
        windowRate: total > 0 ? Number((passed / total).toFixed(3)) : null,
        cannotCandidate: d.cannotCandidate === true,
        lastGeneratedAt: d.lastGeneratedAt,
      };
    }

    return {
      challenges: {
        total: challenges.length,
        byStatus,
        open: challenges.filter((c) => c.status === 'open').length,
        inProgress: challenges.filter((c) => c.status === 'in_progress').length,
      },
      attempts: {
        total: attempts.length,
        byResult,
      },
      domains: byDomain,
      limits: LIMITS,
      paused,
      lastProbeAt,
      config: {
        stale_reverify_days: effectiveConfig().stale_reverify_days,
        generation_batch_limit: effectiveConfig().generation_batch_limit,
        challenge_cooldown_hours: effectiveConfig().challenge_cooldown_hours,
        dedup_window_days: effectiveConfig().dedup_window_days,
        difficulty_window_days: effectiveConfig().difficulty_window_days,
        difficulty_min_samples: effectiveConfig().difficulty_min_samples,
        pass_floor: effectiveConfig().pass_floor,
        pass_ceiling: effectiveConfig().pass_ceiling,
        self_model_writeback: effectiveConfig().self_model_writeback,
        weekly_cron: effectiveConfig().weekly_cron,
      },
      sprint: '14-自主课程仓库实现（不挂载 prod）',
    };
  }

  // ── Service: difficulty ────────────────────────────────────────────────
  async function difficulty({ domain: domainName } = {}) {
    if (!domainName) {
      const t = await table('difficulty_state');
      return [...t.entries()].map(([, v]) => v)
        .sort((a, b) => String(a.domain).localeCompare(String(b.domain)));
    }
    return readDifficulty(domainName);
  }

  function pause(actor = 'human') {
    paused = true;
    return audit({ actor, action: 'paused', targetType: 'difficulty_state', targetId: '*', details: {} })
      .then(() => ({ ok: true, paused: true }));
  }

  function resume(actor = 'human') {
    paused = false;
    return audit({ actor, action: 'resumed', targetType: 'difficulty_state', targetId: '*', details: {} })
      .then(() => ({ ok: true, paused: false }));
  }

  const configApi = (patch) => {
    if (patch == null) return { ...effectiveConfig(), paused, overrides: Object.fromEntries(runtimeOverrides) };
    const allowed = new Set(RUNTIME_CONFIG_KEYS);
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || v === undefined) continue;
      runtimeOverrides.set(k, v);
    }
    return { ...effectiveConfig(), paused, overrides: Object.fromEntries(runtimeOverrides) };
  };

  ctx.provide('agint.curriculum', {
    probe,
    generate,
    nextChallenge,
    submit,
    list,
    stats,
    difficulty,
    pause,
    resume,
    config: configApi,
  });
}

export { ConfigSchema, apply, inject, name };
