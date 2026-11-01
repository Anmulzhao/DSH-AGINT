/**
 * agint-evolve/lib/execution.js —— 提案「执行计划」的纯逻辑层（无 IO、无 ctx）。
 *
 * ## 它补的是哪个洞
 *
 * `approved` 这一档 2026-10-23 加进来时只解决了「点过头和已落地分开记」，
 * 没解决**谁来动手**：`agint-evolution-driver.runOnce()` 只挑 `status:'proposed'`
 * 的候选，`approved` 的行它一眼都不看。于是批准完的提案在家族面板里挂成一张
 * 「已批准待执行（工作单）」，催人去改代码 —— 而「自动执行」这件事在系统里
 * 压根没有入口。2026-10-27 老板要求补齐：批准之后自己进执行流程，
 * 可以立即跑，也可以定到某个时刻跑，**不是**再生成一张催办单。
 *
 * ## 为什么判据要单独成文件
 *
 * 「能不能入队」「什么时候该跑」「这次算不算成功」「现在卡在谁身上」四件事会被
 * 五个地方问：setStatus（批准入口）／家族面板（显示口径）／agint-executor（调度）／
 * 工具／待办汇总。判据散成五份，就会出现「面板说排队中、执行器说没这条」的
 * 自相矛盾 —— 这正是 blocker 那次改动踩过的坑（`proposalBlocked()` 只能有一处）。
 *
 * ⛔ 本文件不许碰存储、不许读 env、不许拿 Date.now()：时间一律由调用方传 now。
 *    这样「定时到点该跑」「过了周上限该顺延」才测得住。
 *    `ticketStage()` 更进一步：它连 now 都不收 —— 判据里有任何时间项，面板那份
 *    镜像实现就会和这边算出不同的答案（面板拿不到同一时刻）。
 */

/** 执行方式三档。`manual` = 只批准、不自动执行（老行的隐含默认值）。 */
export const EXEC_MODES = ['manual', 'immediate', 'scheduled'];

/**
 * 提案上的执行态（展示口径；与 execution 表的 job 状态不是同一个东西）。
 *
 * 2026-10-28 加 `partial`（提案 `846f4fbb` 实证）：
 *   一次自动执行的原子单元是「一个文件的一次编辑」，但提案是按主题写的、常常横跨
 *   多个文件。此前没有这一档，执行器只能二选一：
 *     ① 报成功 ⇒ 提案被标 `applied`（尽管 3 个单元只落地 1 个，剩余单元在台账上彻底消失）；
 *     ② 报失败 ⇒ 已经通过 policy + 验证写进仓库的那份改动被当成没做。
 *   `partial` 就是为此存在的：**job 成功了，提案没做完**。
 *   它不改变提案的 status（仍是 approved），只把欠账摆到 execError / 面板上。
 */
export const EXEC_STATES = ['idle', 'queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled', 'partial'];

/** 一次执行（execution 表一行）的状态机。 */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled'];

/** 到期仍可被 claim 的状态：queued 是正常待跑，deferred 是被周上限/前置顺延过的。 */
const CLAIMABLE = new Set(['queued', 'deferred']);

/** 定时的上限/下限：太远的将来（>365 天）几乎一定是填错了。 */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** 允许的过去容差：面板填 09:00、提交时已经 09:00:03 属于正常，不该拒。 */
const PAST_TOLERANCE_MS = 5 * 60 * 1000;

/** 历史行（加字段前写入）没有这些键 ⇒ 一律归一成契约里的默认值。 */
export function normalizeExec(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const mode = EXEC_MODES.includes(rec.execMode) ? rec.execMode : 'manual';
  const state = EXEC_STATES.includes(rec.execState) ? rec.execState : 'idle';
  return {
    ...rec,
    execMode: mode,
    execAt: typeof rec.execAt === 'string' ? rec.execAt : '',
    execState: state,
    // ⛔ Number(undefined) === NaN：不挡一下，NaN 会让「重试次数 < 上限」恒 false，
    //    表现是失败后永不重试，而且日志里只印 NaN。
    execAttempts: Number.isFinite(Number(rec.execAttempts)) ? Math.max(0, Math.trunc(Number(rec.execAttempts))) : 0,
    execError: typeof rec.execError === 'string' ? rec.execError : '',
    execStartedAt: typeof rec.execStartedAt === 'string' ? rec.execStartedAt : '',
    execFinishedAt: typeof rec.execFinishedAt === 'string' ? rec.execFinishedAt : '',
    // 2026-10-29：`autoExecutable` 降级为**惰性历史标记** —— 存档里还留着
    // 2026-10-27 那批 `false`，但它不再参与任何判据（老板裁定：批准即自动执行）。
    // 保留这个派生字段只为让面板/工具能显示「这条当年被标过什么」，不是闸。
    autoExecutable: rec.autoExecutable !== false,
  };
}

/**
 * 校验一份执行计划。返回 `{ ok: true, mode, at }` 或 `{ ok: false, reason }`。
 *
 * ⛔ 这里是**唯一**的入参校验点：面板 route、evolve_set_status 工具、setStatus
 *    服务都调它。三处各写一份的结果必然是「工具能手填过去时间、面板不行」。
 */
export function validateExecPlan(input = {}, now = Date.now()) {
  const rawMode = input.execMode;
  if (rawMode !== undefined && rawMode !== null && rawMode !== '') {
    if (!EXEC_MODES.includes(rawMode)) {
      return { ok: false, reason: `execMode 不在白名单：${String(rawMode)}（可选 ${EXEC_MODES.join(' / ')}）` };
    }
  }
  const mode = EXEC_MODES.includes(rawMode) ? rawMode : 'manual';
  const rawAt = typeof input.execAt === 'string' ? input.execAt.trim() : '';
  if (mode !== 'scheduled') {
    // immediate / manual 带 at 属于自相矛盾（面板切换选择时会残留旧值）：
    // 不报错，但**丢弃** —— 留着它，日后读的人会以为这条真有定时。
    return { ok: true, mode, at: '' };
  }
  if (rawAt === '') return { ok: false, reason: 'execMode=scheduled 必须给 execAt（ISO 时间）' };
  const ts = Date.parse(rawAt);
  if (!Number.isFinite(ts)) return { ok: false, reason: `execAt 不是合法时间：${rawAt}` };
  if (ts < now - PAST_TOLERANCE_MS) return { ok: false, reason: `execAt 在过去（${rawAt}）—— 要立刻跑请选 immediate` };
  if (ts > now + MAX_AHEAD_MS) return { ok: false, reason: `execAt 超过一年（${rawAt}）—— 大概率填错` };
  return { ok: true, mode, at: new Date(ts).toISOString() };
}

/**
 * 一条提案此刻该不该自动进执行队列。返回 `null` = 该入队；
 * 否则返回**不能入队的原因码**（面板与执行器都按这个码分区显示，不各自造词）。
 *
 * 原因码：
 *   not-approved        —— 没批准（含 applied/rejected/wontfix）
 *   blocked             —— 批准了但前置没到位（`proposalBlocked()` 判过的那种）
 *   manual              —— 明确选择「只批准，不自动执行」
 *   scheduled-at-missing/invalid —— 定时计划不完整
 *   already-queued      —— 已经有排队中/执行中的一次执行，别叠
 */
export function autoEnqueueBlocker(rec, activeJobs = []) {
  if (!rec || rec.status !== 'approved') return 'not-approved';
  const n = normalizeExec(rec);
  const blocker = typeof n.blocker === 'string' ? n.blocker.trim() : '';
  if (blocker !== '') return 'blocked';
  if (n.execMode === 'manual') return 'manual';
  if (n.execMode === 'scheduled') {
    if (n.execAt === '') return 'scheduled-at-missing';
    if (!Number.isFinite(Date.parse(n.execAt))) return 'scheduled-at-invalid';
  }
  const hasActive = (Array.isArray(activeJobs) ? activeJobs : []).some(
    (j) => j && j.proposalId === rec.id && (j.state === 'queued' || j.state === 'running' || j.state === 'deferred'),
  );
  if (hasActive) return 'already-queued';
  return null;
}

/** 到期时间：immediate=立刻；scheduled=execAt；解析不出来就当作立刻。 */
export function computeDueAt(mode, at, now = Date.now()) {
  if (mode === 'scheduled') {
    const ts = Date.parse(String(at ?? ''));
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  return new Date(now).toISOString();
}

/** 这条 job 到点了吗（claim 的判据；deferred 也走这里，顺延期一过自动恢复）。 */
export function isJobDue(job, now = Date.now()) {
  if (!job || !CLAIMABLE.has(job.state)) return false;
  const ts = Date.parse(String(job.dueAt ?? ''));
  if (!Number.isFinite(ts)) return true; // 时间坏了不能卡死队列，当作立刻到期
  return ts <= now;
}

/**
 * 周自动执行上限。
 *
 * ⛔ 这不是新发明的护栏，是 AGENTS.md 既有红线「不要跨周累计自动部署超过 3 次」
 *    的可执行化。之前它是纸面约定，因为「自动部署」这件事根本没发生过；
 *    现在批准即自动执行，它必须变成代码，否则第一条越线的改动就没人拦。
 *
 * @param {Array} jobs 最近窗口内的执行行
 * @param {number} cap 上限（0 = 不限，给测试/临时放开用）
 */
export function weeklyUsage(jobs, now = Date.now(), windowMs = 7 * 24 * 60 * 60 * 1000) {
  const since = now - windowMs;
  const hits = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || j.ok !== true || j.state !== 'succeeded') return false;
    const ts = Date.parse(String(j.finishedAt ?? j.updatedAt ?? ''));
    return Number.isFinite(ts) && ts >= since;
  });
  return { count: hits.length, since: new Date(since).toISOString(), jobs: hits };
}

/**
 * 本周起点（周一 00:00 本地时间）。
 *
 * ⛔ 用**自然周**而不是滚动 7 天：AGENTS.md 的红线原文是「不要**跨周**累计自动
 *    部署超过 3 次」。滚动窗口下，周一发生的第 3 次会一直压到下周一才释放，
 *    等于实际限流成了 3 次/14 天；自然周才是那句话的意思。
 */
export function startOfWeek(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun
  const back = (dow + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** 顺延到下一个自然周起点，用于周上限触发后的自动恢复。 */
export function nextWeekStart(now = Date.now()) {
  const d = new Date(startOfWeek(now));
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}

/** 执行结果 → 是否算「真的落地」。只有 commit 成功才算，提案被构造出来不算。 */
export function interpretRunResult(out) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'driver-returned-nothing' };
  if (out.skipped === true) {
    const first = Array.isArray(out.failures) && out.failures.length ? out.failures[0] : null;
    return { ok: false, reason: first ?? out.reason ?? out.lastError ?? 'driver-skipped' };
  }
  const commit = out.commit ?? null;
  if (commit && commit.ok === true) {
    return {
      ok: true,
      mutationId: out.proposalId ?? '',
      commitPath: commit.path ?? '',
      policyDecision: commit.policyDecision ?? '',
      reason: '',
    };
  }
  if (commit) {
    return {
      ok: false,
      mutationId: out.proposalId ?? '',
      commitPath: commit.path ?? '',
      policyDecision: commit.policyDecision ?? '',
      reason: commit.reason ?? 'commit-not-ok',
    };
  }
  return { ok: false, mutationId: out.proposalId ?? '', reason: 'no-commit-attempted（变异已构造但没写盘：commit 关闭或缺 repoRoot）' };
}

/**
 * 一条提案此刻「卡在谁身上」—— 工单状态机（2026-11-01，v0.16.0）。
 *
 * ## 它补的是哪个洞
 *
 * `status` 说的是「这件事在台账上算哪一档」，`execState` 说的是「最近一次执行跑到
 * 哪一步」—— 两个字段各自都对，但**没有一个字段回答「现在该谁动」**。于是面板只能
 * 拿 execState 硬猜，猜出过两次相反的事故：
 *
 *   · `a85ef850`：approved + immediate + execState=idle + blocker 非空 ⇒ 标成
 *     「已批准·待入队」，而它其实卡在前置上，永远等不到入队那一刻。
 *   · `846f4fbb`：误结案成 applied 后人工改回 approved，execState 仍停在 succeeded
 *     ⇒ 标签说「已落地」，台账说「没做完」，两边都不像在撒谎。
 *
 * 两次的根因是同一个：**「等机器」与「等人」被混在一个字段里**。
 *
 * ## 为什么不复用 superagent 的 stage 表（照抄会错）
 *
 * dsh-superagent 的同一张表里有一档 `idle`（「这一轮干完了，等下一条 Trigger」）。
 * AGINT 没有这个健康静息态：一条 `approved` 提案的唯一正常归宿是**被执行**，
 * 不是等什么。所以「批准了、计划就绪、队列里却没有」在那边是 idle，在这里是
 * **异常**（下面的 `stalled`）。照抄会把一个真实的静默缺陷伪装成正常。
 *
 * ## 判据顺序不能改
 *
 *   ① 已结束 → ② 待批准 → ③ blocker → ④ 失败 → ⑤ 部分落地 →
 *   ⑥ 排队/顺延 → ⑦ 在跑 → ⑧ 计划没定 → ⑨ 应入队未入队
 *
 * ⛔ ③ 必须排在 ④~⑦ 之前：blocker 在时执行态没有意义（它根本排不进去）。
 *    这条是 `a85ef850` 那次定下的，面板 CHANGELOG 也这么写。
 * ⛔ ⑥⑦ 必须在 ⑧ 之前：`autoEnqueueBlocker()` 会把 queued/running 的提案
 *    也判成「该入队」，反过来问会得到「计划就绪却 stalled」的假警报。
 */
export const TICKET_STAGES = Object.freeze([
  'closed',
  'draft',
  'person/blocked',
  'person/failed',
  'person/review',
  'person/plan',
  'working/queued',
  'working',
  'stalled',
]);

/** stage → 谁在等。`system` = 没人在等，这是个该被修掉的缺陷。 */
export const STAGE_SIDES = Object.freeze({
  closed: 'closed',
  draft: 'person',
  'person/blocked': 'person',
  'person/failed': 'person',
  'person/review': 'person',
  'person/plan': 'person',
  'working/queued': 'working',
  working: 'working',
  stalled: 'system',
});

/** stage → 面板标签。⛔ 标签只在这里定义：面板镜像同一张表，靠用例钉等价。 */
export const STAGE_LABELS = Object.freeze({
  closed: '已结束',
  draft: '待批准',
  'person/blocked': '阻塞·等前置',
  'person/failed': '执行失败·等处理',
  'person/review': '部分落地·等续跑',
  'person/plan': '待定执行计划',
  'working/queued': '排队中',
  working: '执行中',
  stalled: '应入队未入队',
});

/** 已结束的提案状态（不再有人等，也不该再占面板空间）。 */
const ENDED_STATUS = new Set(['applied', 'rejected', 'wontfix']);

/** `autoEnqueueBlocker()` 的原因码 → 人话。加了新码这里必须补，否则面板显示裸码。 */
const PLAN_REASONS = Object.freeze({
  manual: '执行方式选了 manual（只批准、不自动跑）—— 要么改成 immediate/scheduled，要么手动放行',
  'scheduled-at-missing': '选了 scheduled 但没填时刻',
  'scheduled-at-invalid': 'execAt 不是合法时间',
  'already-queued': '已有活跃执行（理论上不会走到这里）',
  'not-approved': '状态不是 approved（理论上不会走到这里）',
  blocked: '被 blocker 挡住（理论上不会走到这里）',
});

const clip = (text, max = 120) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * 一条提案此刻卡在谁身上。
 *
 * @param {object} rec 提案行（可以是未归一化的历史行）
 * @returns {{stage:string, side:string, label:string, why:string, stalled:boolean}}
 *
 * ⛔ 只看 `rec` 本身，**不碰 execution 表、不读时钟**。
 *    面板走的是「直接读 agint_evolve.json 的 tables.proposal」那条路（不 import
 *    本插件），所以只要判据依赖 execution 表，两边就必然算出不同的答案 ——
 *    而修 stage 的全部意义就是让两边说同一句话。
 */
export function ticketStage(rec) {
  const n = normalizeExec(rec) ?? {};
  const status = typeof n.status === 'string' && n.status !== '' ? n.status : 'proposed';
  const state = n.execState;
  const blocker = typeof n.blocker === 'string' ? n.blocker.trim() : '';

  const out = (stage, why) => ({
    stage,
    side: STAGE_SIDES[stage] ?? 'system',
    label: STAGE_LABELS[stage] ?? stage,
    why: why ?? '',
    stalled: stage === 'stalled',
  });

  // ① 已结束
  if (ENDED_STATUS.has(status)) return out('closed', `提案已 ${status}`);

  // ② 待批准 —— 人还没表态，谈不上执行
  if (status === 'proposed') return out('draft', '还没人批准这条提案');

  // ③ blocker 优先于任何执行态（a85ef850）
  if (blocker !== '') return out('person/blocked', `阻塞：${clip(blocker, 80)}`);

  // ④ 机器试过、没成功
  if (state === 'failed') return out('person/failed', clip(n.execError) || '上次执行失败，原因未记录');

  // ⑤ job 成功但提案没做完（846f4fbb）—— 可评审的成果已就绪，欠账在 execError 里
  if (state === 'partial') return out('person/review', clip(n.execError) || 'job 成功但提案没做完');

  // ⑥ 排队中 / 已顺延
  if (state === 'deferred') return out('working/queued', clip(n.execError) || '已顺延，到期自动恢复');
  if (state === 'queued') {
    const at = String(n.execAt ?? '');
    return out('working/queued', at ? `排在 ${at.slice(0, 16).replace('T', ' ')}` : '等执行器捡起');
  }

  // ⑦ 正在跑
  if (state === 'running') return out('working', '执行器正在跑');

  // ⑧ 批准了，但执行计划没定 —— 这一步复用 autoEnqueueBlocker，判据只有一份
  const why = autoEnqueueBlocker(n, []);
  if (why !== null) return out('person/plan', PLAN_REASONS[why] ?? String(why));

  // ⑨ 计划就绪却不在队列里（idle / succeeded / cancelled 的残留）
  //
  // ⛔ 这一档是 AGINT 独有、superagent 没有的：那边 idle 是健康状态（等 Trigger），
  //    这边 approved + 计划就绪 + 队列空 = 没人会来跑它。labelled 为 system 而非
  //    person，因为**没有人需要回答什么问题**，需要的是修一个缺陷。
  return out('stalled', `计划就绪（${n.execMode}）但队列里没有执行 —— 应入队未入队`);
}

/** 一行执行的人读摘要（面板、工具、日志共用一句话，避免各印各的）。 */
export function describeExecution(job) {
  if (!job) return '—';
  const pct = {
    queued: `排队中（${job.dueAt ? `到期 ${String(job.dueAt).slice(0, 16).replace('T', ' ')}` : '即时'}）`,
    running: '执行中',
    succeeded: `已落地${job.commitPath ? ` → ${job.commitPath}` : ''}`,
    failed: `失败：${job.error || job.reason || '未知原因'}`,
    deferred: `已顺延：${job.reason || job.error || '等条件成熟'}`,
    cancelled: `已撤销${job.reason ? `（${job.reason}）` : ''}`,
  };
  return pct[job.state] ?? job.state;
}
