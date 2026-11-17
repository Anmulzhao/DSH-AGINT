/**
 * agint-evolve/lib/schedule-bridge.js —— 提案批准 → dsh 原生自动化任务（2026-11-17）。
 *
 * ## 这条路的历史与为什么现在是「开关」
 *
 * 用户（老板）2026-10-27 的原始要求：提案被批准后**形成自动化任务**，并利用
 * **dsh 的自动化任务功能**执行。dsh 的自动化任务 = 宿主 Schedule 服务
 * （`@deepseek-ai/dsh-schedule`，`ctx.schedule`；`schedule_create` 等工具）。
 *
 * 但 2026-10-21（D5）老板令「复用 dsh ctx.schedule」时，agint-cron 的桥
 * （`plugins/agint-cron/lib/host-schedule.js`）明确**不调用 `ctx.schedule.create()`**，
 * 理由是语义冲突：dsh schedule 的投递语义是「往绑定 Session 注入提醒消息」，
 * 而 AGINT 的执行是 host 平面无人值守直调。强行 create() 会把无人值守 job 变成
 * agent 会话消息 —— 属行为变更，留待拍板。
 *
 * 2026-11-17 老板明确拍板「接 dsh 原生 schedule」，推翻 D5 的暂缓。本模块即该接线。
 * ⛔ 因为这是语义变更 + agent 在环，默认**关闭**（`scheduleBridge.enabled` 显式开），
 *    且保留原 executor 轮询路径不动 —— 开关关掉时本模块零副作用。
 *
 * ## 它做什么 / 不做什么
 *
 * - 做：在提案入队时，把「执行这条提案」登记为一条 dsh 自动化任务（title 带
 *   稳定幂等键 `agint-proposal:<proposalId>`），由 dsh 到点把执行指令投递到一个
 *   新建并复用的 agint Session；撤销 / 结案时删除该任务。
 * - 不做：**不判断该不该执行**（那是 agint-evolve 六道闸的事）、**不改仓库**
 *   （那是 driver 的事）、**不替代 execution 表**（它是单一事实源，dsh 任务只是
 *   定时器 + agent 投递）。
 *
 * ## 双触发为什么安全
 *
 * dsh 任务到点投递的 prompt 让 agent 调 `evolve_executions run <id>`，最终走
 * `agint.executor.runNow()`，它仍经过 execution 表的状态机：正在跑 → already-running、
 * 已排队 → already-queued、非 approved → 不执行；executor 的 `inFlight` 锁也照旧。
 * 所以即便 executor 的 setInterval 与 dsh 投递同时到达，也只会真正执行一次。
 *
 * ## 全软依赖
 *
 * 拿不到 `ctx.schedule`、create/edit 抛错、字段不合法 —— 一律返回 `{ok:false,reason}`，
 * 绝不抛到调用方、绝不影响入队事实（提案仍留在 execution 表，executor 轮询兜底）。
 */

/** title 前缀：既是人可读标记，也是幂等键的一部分。 */
export const PROPOSAL_TASK_PREFIX = 'agint-proposal:';

/**
 * dsh 自动化任务的稳定 title。用 proposalId 做幂等键：同一提案反复批准不会叠任务。
 * @param {string} proposalId
 * @returns {string}
 */
export function taskTitle(proposalId) {
  return `${PROPOSAL_TASK_PREFIX}${String(proposalId ?? '').trim()}`.slice(0, 120);
}

/**
 * 从 dsh 任务 title 反解 proposalId；不是本桥的任务返回 null。
 * @param {string} title
 * @returns {string|null}
 */
export function proposalIdFromTitle(title) {
  const s = String(title ?? '');
  return s.startsWith(PROPOSAL_TASK_PREFIX) ? s.slice(PROPOSAL_TASK_PREFIX.length) : null;
}

/**
 * 构造投递给 agent 的执行指令。prompt 明确指定工具与提案 id，并带上幂等与
 * 「已落地就别重跑」的护栏，避免 agent 自由发挥重复改仓库。
 * @param {{id:string,title?:string}} rec
 * @returns {string}
 */
export function executionPrompt(rec) {
  const id = String(rec?.id ?? '');
  const title = String(rec?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return [
    'AGINT 自动化任务：执行一条已批准的进化提案。',
    title ? `提案：${title}` : null,
    `提案 ID：${id}`,
    '',
    '请调用工具 evolve_executions，参数 action=run、id=' + JSON.stringify(id) + '，',
    '让 agint-executor 按既有六道闸（blocker / 周上限 / 重试上限 / 环境熔断）执行。',
    '',
    '约束：不要自己改仓库文件；不要绕过 agint-evolution-driver 的 D-QAF 路径；',
    '若该提案已落地（applied）或已撤销，工具会拒绝，直接如实报告即可，不要重试。',
  ].filter((x) => x !== null).join('\n');
}

/**
 * 构造 dsh schedule.create() 的 timing。
 *   immediate → after（尽快投递；dsh 对一次性延迟允许短于一分钟）
 *   scheduled → at（提案指定的绝对时刻）
 * @param {{execMode:string,execAt?:string}} rec
 * @param {number} nowMs
 * @param {number} immediateDelaySeconds
 * @returns {{ok:true,timing:object}|{ok:false,reason:string}}
 */
export function buildTiming(rec, nowMs, immediateDelaySeconds = 10) {
  const mode = String(rec?.execMode ?? 'immediate');
  if (mode === 'scheduled') {
    const at = rec?.execAt;
    if (!at || !Number.isFinite(Date.parse(at))) {
      return { ok: false, reason: 'scheduled 提案缺合法 execAt' };
    }
    // dsh 要求 at 严格位于未来；已过点的定时提案不建 dsh 任务（executor 轮询会补跑）。
    if (Date.parse(at) <= nowMs) {
      return { ok: false, reason: 'execAt 已过，交给 executor 轮询补跑' };
    }
    return { ok: true, timing: { kind: 'at', at: new Date(at).toISOString() } };
  }
  if (mode === 'manual') return { ok: false, reason: 'manual 提案不建自动化任务' };
  const sec = Math.max(1, Math.trunc(Number(immediateDelaySeconds) || 10));
  return { ok: true, timing: { kind: 'after', after_seconds: sec } };
}

/**
 * 构造完整的 ScheduleCreateRequest。
 * @param {{id:string,title?:string,execMode:string,execAt?:string}} rec
 * @param {{nowMs:number,cwd:string,agentPreset:string,immediateDelaySeconds?:number}} opts
 * @returns {{ok:true,request:object}|{ok:false,reason:string}}
 */
export function buildCreateRequest(rec, opts = {}) {
  const t = buildTiming(rec, opts.nowMs ?? Date.now(), opts.immediateDelaySeconds);
  if (!t.ok) return t;
  return {
    ok: true,
    request: {
      title: taskTitle(rec?.id),
      prompt: executionPrompt(rec),
      timing: t.timing,
      target: {
        kind: 'new_once',
        create: {
          cwd: String(opts.cwd ?? '').trim() || undefined,
          agentPreset: String(opts.agentPreset ?? 'agint').trim() || 'agint',
        },
      },
    },
  };
}

/**
 * 组装桥接实例（软依赖 dsh 宿主 Schedule 服务）。
 *
 * @param {object} deps
 * @param {() => object|null} deps.getScheduleService - 取 ctx.schedule；取不到返回 null
 * @param {object} [deps.createOpts] - buildCreateRequest 的 cwd/agentPreset/immediateDelaySeconds
 * @param {boolean} [deps.enabled] - 总开关；false 时所有方法返回 skipped
 * @param {(level:string,msg:string,meta?:object)=>void} [deps.log]
 */
export function createBridge({ getScheduleService, createOpts = {}, enabled = false, log } = {}) {
  const emit = (level, msg, meta) => {
    try { log?.(level, msg, meta); } catch { /* noop */ }
  };
  const svc = () => {
    try {
      const s = typeof getScheduleService === 'function' ? getScheduleService() : null;
      // create/edit/catalog/list 至少要有一个写方法才算可用。
      if (!s || (typeof s.create !== 'function' && typeof s.edit !== 'function')) return null;
      return s;
    } catch { return null; }
  };

  return {
    /** 开关状态（供 status() 观测）。 */
    isEnabled: () => enabled === true,

    /**
     * 提案入队后同步 dsh 自动化任务（幂等：同提案已有任务则跳过）。
     * @returns {Promise<{ok:boolean,skipped?:boolean,reason?:string,taskId?:string}>}
     */
    async sync(rec) {
      if (enabled !== true) return { ok: false, skipped: true, reason: 'scheduleBridge disabled' };
      const s = svc();
      if (!s) return { ok: false, skipped: true, reason: 'dsh schedule service unavailable' };
      const built = buildCreateRequest(rec, createOpts);
      if (!built.ok) return { ok: false, skipped: true, reason: built.reason };
      const title = taskTitle(rec?.id);
      try {
        // 幂等：优先用 catalog()，退回 list()。不存在这些读方法时跳过查重（dsh 版本差异）。
        let existing = null;
        if (typeof s.catalog === 'function') {
          const all = await s.catalog();
          existing = Array.isArray(all) ? all.find((e) => e?.title === title) : null;
        } else if (typeof s.list === 'function') {
          const page = await s.list({ limit: 500 });
          const items = Array.isArray(page?.items) ? page.items : [];
          existing = items.find((e) => e?.title === title) ?? null;
        }
        if (existing) {
          return { ok: true, skipped: true, reason: 'already-scheduled', taskId: existing.id };
        }
        const out = await s.create(built.request);
        const taskId = out?.id ?? out?.task?.id ?? null;
        emit('info', '[agint-evolve] dsh schedule task created', { proposalId: rec?.id, taskId });
        return { ok: true, taskId };
      } catch (error) {
        const reason = error?.message ?? String(error);
        emit('warn', '[agint-evolve] schedule create failed (soft)', { proposalId: rec?.id, reason });
        return { ok: false, reason };
      }
    },

    /**
     * 提案撤销 / 结案后删除对应 dsh 自动化任务（幂等：找不到也算成功）。
     * @returns {Promise<{ok:boolean,skipped?:boolean,reason?:string,deleted?:number}>}
     */
    async cancel(proposalId) {
      if (enabled !== true) return { ok: false, skipped: true, reason: 'scheduleBridge disabled' };
      const s = svc();
      if (!s || typeof s.edit !== 'function') return { ok: false, skipped: true, reason: 'dsh schedule edit unavailable' };
      const title = taskTitle(proposalId);
      try {
        const ids = [];
        if (typeof s.catalog === 'function') {
          const all = await s.catalog();
          for (const e of Array.isArray(all) ? all : []) if (e?.title === title && e?.id) ids.push(e.id);
        } else if (typeof s.list === 'function') {
          const page = await s.list({ limit: 500 });
          for (const e of Array.isArray(page?.items) ? page.items : []) if (e?.title === title && e?.id) ids.push(e.id);
        }
        let deleted = 0;
        for (const id of ids) {
          await s.edit({ id, action: 'delete' });
          deleted += 1;
        }
        if (deleted) emit('info', '[agint-evolve] dsh schedule task deleted', { proposalId, deleted });
        return { ok: true, deleted };
      } catch (error) {
        const reason = error?.message ?? String(error);
        emit('warn', '[agint-evolve] schedule cancel failed (soft)', { proposalId, reason });
        return { ok: false, reason };
      }
    },
  };
}
