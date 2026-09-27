/**
 * agint-evolution-driver —— 闭环引擎的驱动源（变异构造器）
 *
 * ## 它补的是哪个洞
 *
 * `agint-mutator` 的设计红线是「不调真 LLM」：它只负责**登记与执行**变异，
 * 变异内容（`oldText → newText`）必须由 caller 提供。而全仓从来没有人写过这个
 * caller —— 于是 mutator / population 两个插件挂载了、测试绿了，生产里一次都没跑过
 * （见 `docs/known-limitations/evolution-main-chain-not-energized.md`）。
 *
 * 本插件就是那个 **caller**：
 *
 * ```
 * agint.evolve 的 proposed 提案（真实、人工审核过的改进点）
 *   → 定位目标资产（preset skills 的 SKILL.md）
 *   → spawn subagent（真 LLM）生成 oldText → newText
 *   → 硬校验：oldText 必须真实存在于原文（防幻觉）
 *   → agint.mutator.propose()  → validate()
 *   → agint.population.ingest()   （走 policy gate）
 *   → 发布 evolution.mutation.proposed
 * ```
 *
 * ## 边界（三条红线，改代码前先读）
 *
 * 1. **第一阶段不 commit。** commit 会真改文件；且改部署位没用（install.sh 会镜像覆盖），
 *    必须落到仓库正本 —— 「仓库路径怎么拿」是未决项，见设计稿 §6。
 *    在它被解决前，commit 由 `AGINT_EVOLUTION_DRIVER_COMMIT=on` 显式开启（默认 off）。
 * 2. **不自己造变异内容。** 内容一律来自 LLM 的结构化输出，且 oldText 必须能在原文里
 *    找到；找不到就放弃本次（记 degraded），绝不写入"看起来像"的文本。
 * 3. **全软依赖。** inject=[]，bundle apply 顺序不保证 ⇒ runtime 必须**调用时** ctx.get，
 *    不许在 apply() 里缓存。
 *
 * ## kill-switch
 *
 * `AGINT_EVOLUTION_DRIVER=off` → runOnce 直接返回 skipped。出厂即开。
 */

import { randomUUID } from 'node:crypto';

// ── 常量 ────────────────────────────────────────────────────────────────

const KILL_ENV = 'AGINT_EVOLUTION_DRIVER';
const COMMIT_ENV = 'AGINT_EVOLUTION_DRIVER_COMMIT';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SNIPPET = 6000;
const MAX_CANDIDATES = 5;

/** 结构化输出契约（subagents.start 方言：required 挂在父对象数组上，K70） */
export const MUTATION_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['applicable', 'targetSkill', 'oldText', 'newText', 'rationale'],
  properties: {
    applicable: {
      type: 'boolean',
      description:
        'Whether this proposal can be expressed as a concrete, atomic edit to the target skill file. ' +
        'Answer false if the proposal is too vague, needs new files, or would require code changes.',
    },
    targetSkill: {
      type: 'string',
      description: 'Kebab-case name of the preset skill to edit. Must be one of the listed candidates.',
    },
    oldText: {
      type: 'string',
      description:
        'EXACT verbatim excerpt from the target file that should be replaced. Copy it character for ' +
        'character, including whitespace and line breaks. Never paraphrase, never compose new text here.',
    },
    newText: {
      type: 'string',
      description: 'The replacement text for oldText. Same language as the original file.',
    },
    rationale: {
      type: 'string',
      description: 'One paragraph: why this edit implements the proposal, and how to falsify it.',
    },
  },
});

const SYSTEM_PROMPT = Object.freeze(
  'You are the mutation constructor of an agent framework called AGINT. ' +
  'You are given an improvement proposal that a human has already reviewed, plus the verbatim text of ' +
  'one skill document. Your ONLY job: turn the proposal into ONE atomic edit of that document.\n\n' +
  'HARD RULES:\n' +
  '1. oldText MUST be a verbatim substring of the document you were shown — copy, never paraphrase.\n' +
  '2. The edit must be atomic: one coherent block, no unrelated changes.\n' +
  '3. If the proposal cannot be expressed as a document edit, reply applicable=false and leave the text fields empty.\n' +
  '4. Do not invent file paths, APIs, or commands that do not appear in the document.',
);

// ── 纯函数（可单测，不碰 ctx）────────────────────────────────────────────

/** kill-switch：只有显式 'off' 才关（大小写不敏感 + 去空格）。 */
export function isDisabled(env = {}) {
  const v = String(env?.[KILL_ENV] ?? '').trim().toLowerCase();
  return v === 'off';
}

/** commit 开关：只有显式 'on' 才开 —— 改自己代码这件事默认不做。 */
export function isCommitEnabled(env = {}) {
  const v = String(env?.[COMMIT_ENV] ?? '').trim().toLowerCase();
  return v === 'on';
}

/**
 * 从提案标题/正文里定位目标技能名。
 * @returns {string|null} 命中的技能名；无命中返回 null（不猜）
 */
export function resolveTargetSkill(candidate, availableSkills = []) {
  if (!candidate || !Array.isArray(availableSkills) || !availableSkills.length) return null;
  const hay = `${candidate.title ?? ''}\n${candidate.body ?? ''}`.toLowerCase();
  // 长名优先：`plugin-preflight` 应优先于 `plugin`
  const sorted = [...availableSkills].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const needle = String(name).toLowerCase();
    if (!needle) continue;
    // 词边界命中：前后不能是 [a-z0-9-]，避免 `push` 命中 `github-push` 的半截
    const re = new RegExp(`(?<![a-z0-9-])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
    if (re.test(hay)) return name;
  }
  return null;
}

/** 硬校验：oldText 必须是原文的真实子串（防 LLM 幻觉的第一道闸）。 */
export function anchorExists(fileText, oldText) {
  if (typeof fileText !== 'string' || typeof oldText !== 'string') return false;
  if (!oldText.trim()) return false;
  return fileText.includes(oldText);
}

/** 挑候选：最老的未处理提案（避免每次都挑同一条，也避免随机）。 */
export function pickCandidate(proposals = [], seen = new Set()) {
  const open = (Array.isArray(proposals) ? proposals : [])
    .filter((p) => p && p.status === 'proposed' && p.id && !seen.has(p.id));
  if (!open.length) return null;
  return open.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))[0];
}

// ── 插件主体 ────────────────────────────────────────────────────────────

export function apply(ctx) {
  const state = {
    runs: 0,
    proposed: 0,
    ingested: 0,
    degraded: 0,
    lastRunAt: null,
    lastError: null,
    lastProposalId: null,
    seen: new Set(),
  };

  // 可观测出口（2026-09-27 补）：本插件第一条 job 跑完（evolution-cycle
  // 06:32Z，lastResult ok）却零产出、零留痕 —— 静默失败是本项目头号杀手，
  // 每一条 skipped / continue 都必须留下一句话，否则「跑过但没产出」和
  // 「根本没跑」在生产上无法区分。logger 可能不存在 ⇒ 全链路可选调用。
  const logger = ctx?.logger ?? null;
  const warn = (msg, extra) => {
    try {
      logger?.warn?.(`evolution-driver: ${msg}`, extra ?? {});
    } catch {
      /* 日志失败绝不阻断主流程 */
    }
  };

  // 软依赖：调用时取，不缓存（bundle apply 顺序不保证）
  const dep = (name) => (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null);
  const publish = async (topic, payload) => {
    const bus = dep('agint.eventBus.publish');
    if (typeof bus !== 'function') return false;
    try {
      // ⛔ 单参数，别再传三个：`agint.eventBus.publish` 的签名是
      // `(input) => publish(busCtx, input)`，input = { topic, source, payload }。
      // 传 (topic, payload, opts) 时 bus.js 的 `'id' in input` 对**字符串**抛
      // TypeError，被它内部 catch 成 accepted:false 静默丢弃 —— 2026-09-27
      // 两轮触发零 evolution.* 事件，全部丢在这里。
      // topic 正则（schemas.js）：^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$，本插件三个 topic 均合法。
      const res = await bus({ topic, payload, source: 'agint-evolution-driver' });
      // accepted:false 是 bus 内部校验失败的唯一信号，不能当成功
      return res?.accepted === true;
    } catch {
      return false; // 观测失败绝不影响主流程
    }
  };

  /**
   * 让 LLM 把提案变成一次原子编辑。
   * 注入点：opts.llm（测试用），否则走 agents.create + subagents.start。
   */
  async function construct({ candidate, skillName, fileText, timeoutMs = DEFAULT_TIMEOUT_MS, llm = null }) {
    const build = llm ?? ((args) => spawnLlm(ctx, args));
    const out = await build({
      system: SYSTEM_PROMPT,
      user: [
        '## Improvement proposal',
        `Title: ${candidate.title ?? ''}`,
        `Category: ${candidate.category ?? 'other'}`,
        `Source: ${candidate.source ?? ''}`,
        '',
        candidate.body ?? '',
        '',
        `## Target skill document: ${skillName}`,
        '```',
        String(fileText).slice(0, DEFAULT_SNIPPET),
        '```',
        '',
        'Reply with the structured output: one atomic edit, or applicable=false.',
      ].join('\n'),
      schema: MUTATION_OUTPUT_SCHEMA,
      timeoutMs,
    });
    if (!out || out.ok !== true) {
      return { ok: false, reason: out?.reason ?? 'llm unavailable', degraded: true };
    }
    const v = out.value ?? {};
    if (v.applicable !== true) {
      return { ok: false, reason: 'llm judged not applicable', rationale: v.rationale ?? null };
    }
    if (!anchorExists(fileText, v.oldText)) {
      // ⛔ 幻觉闸门：oldText 不在原文里 ⇒ 这条变异是编的，丢弃而不是"修一修"
      return { ok: false, reason: 'oldText not found in target file (hallucination guard)', degraded: true };
    }
    if (!v.newText || v.newText === v.oldText) {
      return { ok: false, reason: 'empty or no-op edit' };
    }
    return { ok: true, value: v };
  }

  /**
   * 跑一轮：挑候选 → 构造 → propose → validate → ingest。
   * @param {object} opts
   * @param {object} [opts.inject] 测试注入：{ evolve, mutator, population, skills, fs, llm }
   */
  async function runOnce(opts = {}) {
    // 全路径出口：每条 return 都发一条 summary（2026-09-27 三修）。
    // 前两版只覆盖了「走到循环末尾」的情况，早期 return（依赖缺失等）照样静默。
    const emitSummary = async (exitReason, extra = {}) =>
      publish('evolution.cycle.summary', {
        exitReason,
        runs: state.runs,
        seen: state.seen.size,
        proposed: state.proposed,
        ingested: state.ingested,
        degraded: state.degraded,
        lastError: state.lastError,
        failures: [],
        failuresTotal: 0,
        commitEnabled: isCommitEnabled(opts.env ?? process.env),
        ...extra,
      });

    if (isDisabled(opts.env ?? process.env)) {
      await emitSummary('paused');
      return { skipped: true, reason: `paused（${KILL_ENV}=off）` };
    }
    state.runs += 1;
    state.lastRunAt = new Date().toISOString();

    const inj = opts.inject ?? {};
    const evolve = inj.evolve ?? dep('agint.evolve');
    const mutator = inj.mutator ?? dep('agint.mutator');
    const population = inj.population ?? dep('agint.population');
    const fs = inj.fs ?? null;

    if (!evolve || typeof evolve.listProposals !== 'function') {
      state.degraded += 1;
      state.lastError = 'agint.evolve unavailable';
      warn('runOnce skipped', { reason: state.lastError, hasEvolve: Boolean(evolve) });
      await emitSummary('evolve-unavailable');
      return { skipped: true, reason: 'agint.evolve unavailable' };
    }
    if (!mutator || typeof mutator.propose !== 'function') {
      state.degraded += 1;
      state.lastError = 'agint.mutator unavailable';
      warn('runOnce skipped', { reason: state.lastError, hasMutator: Boolean(mutator) });
      await emitSummary('mutator-unavailable');
      return { skipped: true, reason: 'agint.mutator unavailable' };
    }

    let proposals = [];
    try {
      proposals = await evolve.listProposals({ status: 'proposed' });
    } catch (error) {
      state.degraded += 1;
      state.lastError = `listProposals failed: ${error?.message ?? String(error)}`;
      warn('runOnce skipped', { reason: state.lastError });
      await emitSummary('listProposals-failed');
      return { skipped: true, reason: state.lastError };
    }

    // 可用技能清单：注入优先；否则按插件自身位置列出 bundle 内 preset skills
    let available = Array.isArray(inj.skillNames) ? inj.skillNames : null;
    if (!available) {
      try {
        available = await listSkillNames({ roots: inj.skillRoots });
      } catch {
        available = [];
      }
    }
    const pool = Array.isArray(proposals) ? proposals.slice(0, MAX_CANDIDATES * 4) : [];
    // ⭐ 失败清单（2026-09-27 二修）：warn 走宿主 stdout，常驻进程下**读不到**；
    // cron 持久化只写死字符串 "ok"，统计也不落盘。唯一外部可读的出口是事件总线。
    // 每轮结束必发一条 evolution.cycle.summary，把「跑了几个 / 卡在哪」写进去。
    const failures = [];

    for (const candidate of pool) {
      if (state.seen.has(candidate.id)) continue;
      state.seen.add(candidate.id);

      const skillName = resolveTargetSkill(candidate, available);
      if (!skillName) {
        // 定位不到目标资产 → 换下一条，不硬凑。留痕：这是「有提案但没目标」的静默路径。
        warn('candidate skipped: no target skill resolved', {
          candidateId: candidate.id,
          title: candidate.title ?? '',
          availableCount: Array.isArray(available) ? available.length : 0,
        });
        failures.push(`${candidate.id}: no target skill resolved`);
        continue;
      }

      let fileText = null;
      try {
        fileText = await readSkillText({ skillName, fs, roots: inj.skillRoots });
      } catch (error) {
        fileText = null;
        warn('candidate skipped: target file unreadable', {
          candidateId: candidate.id,
          skillName,
          error: error?.message ?? String(error),
        });
      }
      if (typeof fileText !== 'string' || !fileText) {
        failures.push(`${candidate.id}: target file unreadable (${skillName})`);
        continue;
      }

      const built = await construct({ candidate, skillName, fileText, llm: inj.llm ?? null });
      if (built.ok !== true) {
        if (built.degraded) state.degraded += 1;
        warn('candidate skipped: construct failed', {
          candidateId: candidate.id,
          skillName,
          reason: built.reason ?? 'unknown',
          degraded: built.degraded === true,
        });
        failures.push(`${candidate.id}: construct failed — ${built.reason ?? 'unknown'}`);
        continue;
      }
      const v = built.value;

      let proposal = null;
      try {
        proposal = await mutator.propose({
          source: 'evolution-reversed',
          failureId: candidate.id,
          rootCause: `PROMPT_DEFICIENCY: ${candidate.category ?? 'other'}`,
          atomicScope: 'prompt',
          expectedEffect: 'baseline 通过率 >= 95% 在 7 天',
          rollbackCondition: 'regression → auto-rollback',
          promptPayload: {
            promptId: skillName,
            oldText: v.oldText,
            newText: v.newText,
            diffStrategy: 'unified_diff',
          },
          failureContext: {
            proposalTitle: candidate.title ?? '',
            rationale: v.rationale ?? '',
            source: candidate.source ?? '',
          },
        });
      } catch (error) {
        state.lastError = `propose failed: ${error?.message ?? String(error)}`;
        warn('candidate skipped: mutator.propose threw', {
          candidateId: candidate.id,
          skillName,
          reason: state.lastError,
        });
        failures.push(`${candidate.id}: propose threw — ${state.lastError}`);
        continue;
      }
      state.proposed += 1;
      state.lastProposalId = proposal?.id ?? null;

      // validate 是"不通过不抛错"的形态：写 findings + 返回 {ok, findings}
      let verdict = { ok: true, findings: [] };
      if (typeof mutator.validate === 'function') {
        try {
          verdict = await mutator.validate({ proposalId: proposal.id });
        } catch (error) {
          verdict = { ok: false, findings: [String(error?.message ?? error)] };
        }
      }
      if (verdict && verdict.ok === false) {
        await publish('evolution.mutation.rejected', {
          proposalId: proposal.id,
          candidateId: candidate.id,
          findings: (verdict.findings ?? []).slice(0, 5),
        });
        failures.push(`${candidate.id}: validate rejected — ${(verdict.findings ?? []).slice(0, 2).join(' | ')}`);
        continue;
      }

      let variant = null;
      if (population && typeof population.ingest === 'function') {
        try {
          variant = await population.ingest({ proposal, generation: 0 });
          state.ingested += 1;
        } catch (error) {
          state.lastError = `ingest failed: ${error?.message ?? String(error)}`;
        }
      }

      await publish('evolution.mutation.proposed', {
        proposalId: proposal.id,
        candidateId: candidate.id,
        skill: skillName,
        variantId: variant?.variant_id ?? null,
        policyDecision: variant?.policy_decision ?? null,
        stage: variant?.stage ?? null,
        commitEnabled: isCommitEnabled(opts.env ?? process.env),
      });

      return {
        skipped: false,
        candidateId: candidate.id,
        skill: skillName,
        proposalId: proposal.id,
        variantId: variant?.variant_id ?? null,
        policyDecision: variant?.policy_decision ?? null,
        rationale: v.rationale ?? '',
      };
    }

    // ⭐ 无论有没有产出都发一条 summary：这是本插件唯一「外部可读」的出口
    // （warn→stdout 常驻读不到；cron 持久化只写死 "ok"）。零产出时更要发。
    await emitSummary('no-actionable-candidate', {
      poolSize: pool.length,
      availableSkills: Array.isArray(available) ? available.length : 0,
      failures: failures.slice(0, 10),
      failuresTotal: failures.length,
    });

    // 跑完一轮什么都没产出 —— 必须留痕，否则与「根本没跑」无法区分。
    const summary = {
      poolSize: pool.length,
      availableSkills: Array.isArray(available) ? available.length : 0,
      seen: state.seen.size,
      degraded: state.degraded,
      lastError: state.lastError,
    };
    warn('runOnce ended with no actionable candidate', summary);
    return {
      skipped: true,
      reason: 'no actionable candidate（无候选 / 定位不到目标 / LLM 判定不适用）',
      ...summary,
    };
  }

  function status() {
    return {
      runs: state.runs,
      proposed: state.proposed,
      ingested: state.ingested,
      degraded: state.degraded,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      lastProposalId: state.lastProposalId,
      seenCandidates: state.seen.size,
      commitEnabled: isCommitEnabled(process.env),
      killSwitch: isDisabled(process.env) ? 'off' : 'on',
    };
  }

  ctx.provide('agint.evolutionDriver', { runOnce, status, construct });

  ctx.effect(() => () => {
    /* 无 interval / 无订阅：生命周期干净 */
  });
}

// ── 副作用：读技能文件 + 起子 agent（与纯逻辑分离，便于注入测试）─────────

async function readSkillText({ skillName, fs, roots }) {
  const read = fs?.readSkill;
  if (typeof read === 'function') return await read(skillName);
  const list = roots ?? null;
  if (typeof list === 'function') return await list(skillName);
  // 默认：按插件自身位置定位 bundle 内的 presets（K83：包内相对路径锚包根）
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const base = fileURLToPath(new URL('../../../presets/agint/skills/', import.meta.url));
  return await readFile(join(base, String(skillName), 'SKILL.md'), 'utf8');
}

/** 列出 bundle 内 preset skills 的目录名（默认发现路径，生产靠它拿到可用技能清单）。 */
async function listSkillNames({ roots } = {}) {
  if (typeof roots === 'function') return await roots();
  const { readdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const base = fileURLToPath(new URL('../../../presets/agint/skills/', import.meta.url));
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !String(e.name).startsWith('.')).map((e) => e.name);
}

async function spawnLlm(ctx, { system, user, schema, timeoutMs }) {
  const agents = ctx?.get?.('agents');
  const subagents = ctx?.get?.('subagents');
  if (!agents || typeof agents.create !== 'function') return { ok: false, reason: 'agents unavailable' };
  if (!subagents || typeof subagents.start !== 'function') return { ok: false, reason: 'subagents unavailable' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('evolution-driver-timeout'), timeoutMs);
  let handle = null;
  let run = null;
  try {
    handle = await agents.create({
      sessionId: `evolution-driver-${randomUUID()}`,
      meta: { cwd: process.cwd(), origin: 'subagent' },
      signal: controller.signal,
    });
    run = await subagents.start('spawn', {
      parent: handle.agent,
      prompt: [{ type: 'text', text: `${system}\n\n${user}` }],
      outputSchema: schema,
      signal: controller.signal,
      label: 'agint-evolution-driver mutation',
    });
    const result = await run.result;
    if (result?.stopReason !== 'completed') {
      return { ok: false, reason: `stopReason=${result?.stopReason ?? 'unknown'}` };
    }
    return { ok: true, value: result?.output ?? null };
  } catch (error) {
    return { ok: false, reason: `llm error: ${error?.message ?? String(error)}` };
  } finally {
    clearTimeout(timer);
    try {
      await run?.dispose?.();
    } catch {
      /* dispose 失败不阻断 */
    }
    try {
      await handle?.dispose?.();
    } catch {
      /* 同上 */
    }
  }
}

export default { apply };
