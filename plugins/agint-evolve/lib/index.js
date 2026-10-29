/**
 * agint-evolve: host service plugin (provides `agint.evolve`).
 *
 * HOST plane, single instance: the review loop's data + proposal layer.
 *
 * - Reviews are markdown files under a configured root (default
 *   ${HOME}/projects/agint-dsh/reviews) — files stay human-readable and
 *   diff-able, same medium as the wiki.
 * - Proposals live in the `agint_evolve` storage domain (unique name, K12)
 *   so their status can be queried and updated across sessions.
 *
 * The intelligence stays in the model: dataSnapshot() gathers facts from the
 * agint-* services, writeReview() renders a review report with auto-detected
 * findings, and the session reads the report, proposes improvements
 * (evolve_propose), and tracks them (evolve_set_status). The Sunday cron job
 * `evolve-review` calls writeReview() automatically.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-evolve
 *         name: ./plugins/agint-evolve/lib/index.js
 *         config:
 *           root: .../agint-dsh/reviews
 */

import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { findingsFromSnapshot, buildReport } from './report.js';
import {
  EXEC_MODES,
  EXEC_STATES,
  JOB_STATES,
  normalizeExec,
  validateExecPlan,
  autoEnqueueBlocker,
  computeDueAt,
  isJobDue,
  weeklyUsage,
  startOfWeek,
  describeExecution,
} from './execution.js';

const name = 'agint-evolve';
const inject = ['storageDomain'];

const Config = z.object({
  root: z.string().min(1, 'agint-evolve: config.root is required'),
  // A4：eval 存量 FAIL 归因产物（`node bin/attribute-eval-fails.mjs --json` 的落盘产物）。
  // 可选 —— 不配就整章印「本周未采到」，⛔ 绝不印「0 个 FAIL」（K：没查 ≠ 没有）。
  // ⚠️ 路径在 apply() 里从 import.meta.url 推导（仓库根 = 插件所在 plugins/<name>/lib 的上两级），
  //    不用环境变量：cron 的 cwd 与宿主环境都不可靠（与 quality-sandbox 同款做法）。
  evalAttributionPath: z.string().min(1).optional(),
});

/**
 * 从本文件位置向上找**真实存在 `eval/` 的仓库根**。
 *
 * ⛔ 2026-10-04 部署位实测修正（A4 原实现的真缺陷）：
 *   原实现按固定层数 `new URL('../../../')` 推根，这隐含假设「插件住在**仓库**的
 *   plugins/ 下」。但宿主真正加载的是**部署位**那份：
 *     boot 源  ~/.dsh/.agint-bundle/plugins/agint-evolve/lib/index.js
 *     镜像位  ~/.dsh/profiles/web/plugins/agint-evolve/lib/index.js
 *   往上三级分别是 `.agint-bundle/` 与 `profiles/web/` —— **两处都没有 `eval/`**。
 *   ⇒ 固定层数在部署位必推错目录，周报永远印「本周未采到」，而且看不出是路径错
 *     还是真没数据（静默降级，正是本节要防的那类失败）。
 *
 * 改为**逐级向上探测 + 存在性判据**：命中含 `eval/` 的祖先才算找到。
 * 找不到就返回 null，让调用方把「路径没解析出来」当成一种**独立的可观测状态**
 * 报出来，而不是伪装成「没采到数据」。
 *
 * 不用环境变量、不用 cwd（K：cron 的 cwd 与宿主环境都不可靠）。
 * @returns {string|null} 仓库根绝对路径；探测不到返回 null
 * 导出供单测直接验「生产函数在当前所在位置的行为」——
 * ⛔ 只在测试里复算一遍算法不算数：复算的那份和生产的不是同一份代码。
 */
export function repoRootFromHere() {
  let dir = dirname(fileURLToPath(import.meta.url));
  // 最多向上 8 级：lib→插件→plugins→(仓库|bundle|profile)→…
  // 超過这个深度还没命中 eval/，基本可判定「此处不是仓库布局」，早停不空转。
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'eval'))) return dir;
    const up = dirname(dir);
    if (up === dir) break; // 到根了
    dir = up;
  }
  return null;
}

// 提案状态五档（2026-10-23 加 `approved`）。
//
// ⛔ 为什么不复用 `applied` 表示「老板批准了」：`applied` 的语义是**已落地**，
//    note 里写的是落地证据（改了什么文件）。把「同意做」写成 `applied` 会让
//    proposal 表说假话 —— 而未落地的提案占着 applied，事后无法区分「真做完」
//    与「只是点了头」。`approved` 补的是「人工批准、尚未执行」这一档，
//    它让待批队列第一次有出口：proposed → approved → applied。
//
// 状态流转（只增不改，历史行全部仍合法）：
//   proposed ──批准──▶ approved ──落地──▶ applied
//        └──拒绝──▶ rejected
//        └──暂不处理──▶ wontfix
//   人工改判允许回 proposed（家族面板提供「撤销」，走 setStatus 同一出口）。
const proposalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  category: z.enum(['rule', 'skill', 'doc', 'preset', 'service', 'plugin', 'other']).default('other'),
  status: z.enum(['proposed', 'approved', 'applied', 'rejected', 'wontfix']).default('proposed'),
  source: z.string().default(''),
  note: z.string().default(''),
  // 2026-10-27：`approved` 只说了「同意做」，没说「现在能做」。
  //
  // 实测反例（提案 a85ef850）：老板 2026-10-26 批准"权重真标定"，可这条的
  // 前置是「攒够 8-12 周人工标注样本」，当周周报明确 31/31 未标注且**冻结**
  // 权重常量。于是它在待办里挂成一张「工作单」，催人去动手 —— 而真动手就
  // 违反自家门禁。这一档缺的不是状态，是「为什么还不能做」的表达位。
  //
  //   blocker           —— 阻塞原因（卡在什么上）
  //   unblockCondition  —— 解锁条件（等什么满足才算能动手）
  //
  // 空串 = 没卡住。历史行没有这两个字段 ⇒ 读到 undefined，一律按空串归一
  // （normalize()），绝不把「字段缺席」读成「阻塞原因未知」。
  blocker: z.string().default(''),
  unblockCondition: z.string().default(''),
  // 2026-10-27：`approved` 之后由谁动手？此前答案是「没有人」—— driver 只挑
  // status:'proposed'，approved 的行它不看，于是批准完的提案在家族面板里挂成
  // 一张催办工作单。这七个字段是「批准即入执行流程」的载体：
  //
  //   execMode          manual（只批准）/ immediate（立即）/ scheduled（定时）
  //   execAt            scheduled 的到期时刻（ISO）；其余模式为空串
  //   execState         idle / queued / running / succeeded / failed / deferred / cancelled
  //   execAttempts      已尝试次数（由执行器 claim 时自增）
  //   execError         最近一次失败/顺延的原因（空串 = 没有）
  //   execStartedAt     最近一次开始执行的时刻
  //   execFinishedAt    最近一次结束（成功或失败）的时刻
  //
  // ⛔ 默认 manual：加字段之前批准的老提案（50+ 条）**不会**因为这次升级突然
  //    开始自动改代码。要自动执行必须有人这一次明确选了 immediate/scheduled。
  execMode: z.enum(EXEC_MODES).default('manual'),
  execAt: z.string().default(''),
  execState: z.enum(EXEC_STATES).default('idle'),
  execAttempts: z.number().int().nonnegative().default(0),
  execError: z.string().default(''),
  execStartedAt: z.string().default(''),
  execFinishedAt: z.string().default(''),
  // 2026-10-27：这条提案**能不能被自动执行**。
  //
  // 实机反例（首跑就撞上）：oracle 周报产出的「美谕提案：决策确信度 扣 1.7 分」，
  // 正文自述「纯机械动作提案，status 锁 proposed，**永不 auto-apply**；是否执行
  // 由老板裁定」「不改动、不删除、不自动生效」—— 它要的动作是**人去复核一条
  // 记忆条目**，不是改代码。但面板默认 execMode=immediate ⇒ 它被塞进自动执行
  // 队列 ⇒ driver 定位不到可改的目标资产 ⇒ 两次都在 1 秒内失败。
  //
  // 缺的就是「我不可自动执行」这个表达位。⛔ 默认 true：字段是后加的，老提案
  // （含 driver/mutator 产出的）一律仍可执行，不会因这次升级突然被挡。
  autoExecutable: z.boolean().default(true),
  // 2026-10-27 补回：这两个时间戳字段在本次加 blocker/execMode/autoExecutable
  // 时被漏掉了 —— schema 里没声明 ⇒ 存储域 open 时 zod **strip 掉**（未知键）
  // ⇒ 内存里的提案行没有 createdAt ⇒ listProposals 排序
  //   `b.createdAt.localeCompare(a.createdAt)` 直接抛 TypeError，
  //   工具 evolve_proposals 全挂；更糟的是 setStatus 用「已 strip 的内存行」
  //   写回磁盘，把该行的 createdAt 永久抹掉（实测 3 行中招）。
  // ⛔ default('')：老行照读不报错（加字段不改 domain version，见上方注释）。
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
  // 2026-10-27：提案的**成立条件** —— 这条结论依赖哪一版判尺口径。
  //
  // 实机反例（提案 a85ef850）：2026-10-09 12:58 立项「用 Q2 最丑归因标定权重」，
  // 当时 q2Worst 按**绝对扣分**排序，权重直接决定归因，这条建议成立；同日 13:07
  // 落地的 f51d3280 把排序改成 ratio(deduction/maxWeight)，而
  // `deduction = maxWeight × g(value, threshold)` ⇒ 权重在分子分母被约掉，
  // 归因只由阈值决定。于是这条提案**静默失效**，却仍挂在台账里「待批」，
  // 直到 18 天后人工点开才发现方法已无意义。
  //
  //   formulaVersion  propose 时由当前判尺口径自动填（oracle 未挂载 ⇒ 空串=未知）
  //   assumedBy       可选，人写的更强假设锚点（如 `scoring.js@r2`）
  //   conflictsWith   声明与哪些提案互斥（创建时校验，见 propose）
  //
  // ⛔ formulaVersion 空串 = **口径未知**，不是「与当前一致」。历史行没有这个字段，
  //    一律读成空串 —— 绝不因为「没记」就判它失效（那会把 90+ 条老提案集体标黄）。
  formulaVersion: z.string().default(''),
  assumedBy: z.string().default(''),
  conflictsWith: z.array(z.string()).default([]),
});

// Sprint 12 B3: baseline_history 表由 cron `baseline-regression-suite` 写入，
// 由 `agint.evolve.baselineGate(channel)` 读取上一周期 frozen 状态。
// 一行 = 一次 cron 跑的结果。id = ISO 时间戳（毫秒精度）。
const baselineHistorySchema = z.object({
  id: z.string().min(1),
  channel: z.string().min(1), // 当前固定 'mount'，预留扩展
  passRate: z.number().min(0).max(1),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  frozen: z.boolean(),
  source: z.string().default('cron:baseline-regression-suite'),
  ranAt: z.string(),
});

/**
 * 一次执行（`execution` 表一行）。
 *
 * 为什么执行记录要独立成表，而不是只记在提案行上：
 *   提案行只放得下「最近一次」的状态，而自动执行是会失败重试的 ——
 *   「第一次为什么失败、重试了几次、每次写到了哪个文件」必须留得下来，
 *   否则出事时只能看到一句 `execError`，查不到演化过程（本仓的审计要求）。
 *
 * 一行 = 一次批准触发的一次执行（重试复用同一行，attempts 自增，log 追加）。
 */
const executionSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  mode: z.enum(['immediate', 'scheduled']).default('immediate'),
  dueAt: z.string().default(''),
  state: z.enum(JOB_STATES).default('queued'),
  attempts: z.number().int().nonnegative().default(0),
  requestedBy: z.string().default('approval'),
  ok: z.boolean().default(false),
  mutationId: z.string().default(''),
  commitPath: z.string().default(''),
  policyDecision: z.string().default(''),
  reason: z.string().default(''),
  error: z.string().default(''),
  // 逐次尝试的追加日志（截断到 4KB，防止一行长到把存储文件撑爆）
  log: z.string().default(''),
  startedAt: z.string().default(''),
  finishedAt: z.string().default(''),
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
});

// ⛔ domain version 刻意**不升**（2026-10-27）。dsh 的 json backend 是硬版本校验
//    （storage-json/lib/index.js:102 `stored version != expected` 直接抛
//    version-mismatch，没有 compatibleVersions 通道），升版本 = 现有
//    agint_evolve.json 里 50+ 条提案整表读不出来，域直接开不了。
//    加表 + 加可选字段（带 default）在这个 backend 上是安全的：未声明的表按空表
//    加载（parse 里 `tables[table] === undefined → 空 Map`），老记录缺的键由 zod
//    default 补齐。1→2 那次升版本是加 baseline_history 表时做的，代价是手工迁移；
//    这次没有必须升的理由，就不制造一次「必须先迁移再启动」的窗口。
const spec = defineDomain({
  name: 'agint_evolve',
  version: 2,
  tables: {
    proposal: { valueSchema: proposalSchema },
    baseline_history: { valueSchema: baselineHistorySchema },
    execution: { valueSchema: executionSchema },
  },
});

const PROPOSAL_STATUSES = ['proposed', 'approved', 'applied', 'rejected', 'wontfix'];
const PROPOSAL_CATEGORIES = ['rule', 'skill', 'doc', 'preset', 'service', 'plugin', 'other'];

/**
 * 提案行归一：补齐 2026-10-27 新增的阻塞字段（blocker / unblockCondition）。
 *
 * 为什么必须有这一层：存储层按原样返回行，**不会**重新过 schema；加字段前写入的
 * 历史行没有这两个键。若不归一，每个读出口（tools / 家族面板 / 周报）都要各自
 * `?? ''`，早晚有一处忘 —— 而忘掉的表现是「阻塞原因丢了」，不是报错。
 *
 * ⛔ 字段缺席（undefined）与空串在**展示口径**上等价（都=没卡住），但语义不同：
 *    前者是「这行写在加字段之前」，后者是「明确判过没卡住」。这个等价只在这里做，
 *    别处不许再自行猜测。
 */
export function normalizeProposal(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  return normalizeExec({
    ...rec,
    blocker: typeof rec.blocker === 'string' ? rec.blocker : '',
    unblockCondition: typeof rec.unblockCondition === 'string' ? rec.unblockCondition : '',
  });
}

/**
 * 一条提案此刻是不是「批准了但动不了手」。
 *
 * 判据只有一处（本函数），面板/工具都读它 —— 判据散成两份就会出现
 * 「待办说卡住、提案台说可催办」的自相矛盾。
 * ⛔ 只看 status==='approved'：proposed 挂 blocker 没意义（还没批），
 *    applied 挂 blocker 自相矛盾（事实已发生，去 setStatus 时会被一并清掉）。
 */
export function proposalBlocked(rec) {
  if (!rec || rec.status !== 'approved') return false;
  const b = normalizeProposal(rec).blocker.trim();
  return b !== '';
}

/**
 * 这条提案的成立条件是否已被判尺口径的变更甩在身后。
 *
 * 返回 `'r2→r4'` 表示「立项时按 r2 成立，现在是 r4，结论未必还站得住」；
 * 返回 `''` 表示**没有依据说它失效** —— 三态而非二态：
 *   - 提案记了口径 + 当前口径已知 + 两者不同  ⇒ 有差值（标黄）
 *   - 提案没记口径（历史行 / oracle 未挂载）  ⇒ 空（未知，不指控）
 *   - 两者相同                                ⇒ 空（仍然成立）
 *
 * ⛔ 只产提示，**不改 status**：判失效要人确认。f51d3280 那次就是「看起来完全
 *    正常的待批提案」，机器没资格替人决定它是不是已经废了。
 */
export function proposalStaleSince(rec, current) {
  const own = String(rec?.formulaVersion ?? '').trim();
  const cur = String(current ?? '').trim();
  if (!own || !cur || own === cur) return '';
  return `${own}→${cur}`;
}


function apply(ctx, config) {
  const root = resolve(config.root);
  // A4：归因 JSON 路径。两级来源，优先级 config > 自动探测。
  // 不依赖 cwd / 环境变量（cron 的 cwd 不保证是仓库根，宿主环境变量也没约定）。
  //
  // ⛔ 自动探测在**部署位**多半解析不出仓库根（插件住在 ~/.dsh/.agint-bundle/plugins/
  //    或 ~/.dsh/profiles/web/plugins/ 下，祖先里没有 eval/）。此时 pathResolved=false
  //    会进快照，由周报明确印「路径没解析出来」——
  //    这与「解析出来了但文件不存在」「文件坏了」是三件不同的事，不能混成一个「未采到」。
  const autoRoot = config.evalAttributionPath ? null : repoRootFromHere();
  const pathResolved = Boolean(config.evalAttributionPath) || autoRoot !== null;
  const evalAttributionPath = config.evalAttributionPath
    ? resolve(config.evalAttributionPath)
    : autoRoot
      ? resolve(autoRoot, 'eval', 'attribution', 'fail-attribution.json')
      : null;

  // ---- storage domain (double-sentinel pattern, K4/K8) ----
  let domain = null;
  let domainError = null;
  let disposed = false;

  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
        void d.close().catch(() => {});
        return null;
      }
      domain = d;
      return d;
    },
    (error) => {
      domainError = error;
      return null;
    },
  );

  const table = async () => {
    if (disposed) throw new Error('agint-evolve: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-evolve: domain unavailable');
    return d.table('proposal');
  };

  const historyTable = async () => {
    if (disposed) throw new Error('agint-evolve: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-evolve: domain unavailable');
    return d.table('baseline_history');
  };

  const nowIso = () => new Date().toISOString();
  const randomId = () => {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  };

  // ---- 执行队列（2026-10-27）---------------------------------------------
  // 「批准即入队、执行器来捡」的存取层。判据全在 lib/execution.js（纯函数），
  // 这里只做读改写。⛔ 不在这里判断「该不该跑」—— 那是调用方的事，
  // 判定散进存取层就会出现「同一个问题两个答案」。
  const executionTable = async () => {
    if (disposed) throw new Error('agint-evolve: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-evolve: domain unavailable');
    return d.table('execution');
  };

  const execWake = () => {
    // 入队后立刻捅一下执行器，别等下一个 tick（「立即执行」只等 30 秒很怪）。
    // ⛔ 软依赖：执行器没挂 / 抛错都不影响入队事实。
    try {
      const ex = typeof ctx.get === 'function' ? ctx.get('agint.executor') : null;
      if (ex && typeof ex.wake === 'function') ex.wake();
    } catch { /* noop */ }
  };

  const activeJobsFor = async (proposalId) => {
    const et = await executionTable();
    const out = [];
    for (const [id, row] of et.entries()) {
      if (!row || row.proposalId !== proposalId) continue;
      if (row.state === 'queued' || row.state === 'running' || row.state === 'deferred') out.push({ id, ...row });
    }
    return out;
  };

  /** 读-改-写提案行（只动执行相关字段；状态迁移走 applyStatus）。 */
  const markProposal = async (proposalId, patch) => {
    const t = await table();
    const rec = t.get(proposalId);
    if (!rec) return null;
    const updated = normalizeProposal({ ...rec, ...patch, updatedAt: nowIso() });
    await t.put(proposalId, updated);
    return updated;
  };

  const cancelJobs = async (jobs, reason) => {
    const et = await executionTable();
    const ts = nowIso();
    const done = [];
    for (const job of jobs) {
      if (!job || job.state === 'succeeded') continue;
      const next = executionSchema.parse({
        ...job,
        state: 'cancelled',
        reason: reason || job.reason || '',
        finishedAt: ts,
        updatedAt: ts,
        log: [job.log, `${ts} cancelled ${reason ?? ''}`.trim()].filter(Boolean).join('\n').slice(-4000),
      });
      await et.put(job.id, next);
      done.push(next);
    }
    return done;
  };

  /**
   * 一条提案入队。判据走 `autoEnqueueBlocker()`（单一事实源）。
   * @returns {{enqueued:boolean, job?:object, reason?:string}}
   */
  async function enqueueOne(rec, { by = 'approval', force = false } = {}) {
    const jobs = await activeJobsFor(rec.id);
    // ⛔ 正在跑的时候，force 也不允许再排一条：两条执行会同时改同一处资产，
    //    第二条的旧锚点必然失配（phantom 冲突），徒增一次失败记录。
    const running = jobs.find((j) => j.state === 'running');
    if (running) return { enqueued: false, reason: 'already-running', job: running };
    const why = autoEnqueueBlocker(rec, jobs);
    if (why && !force) return { enqueued: false, reason: why };
    if (jobs.length && !force) return { enqueued: false, reason: 'already-queued', job: jobs[0] };
    const et = await executionTable();
    const now = Date.now();
    const ts = new Date(now).toISOString();
    const job = executionSchema.parse({
      id: `exec-${now}-${Math.random().toString(36).slice(2, 8)}`,
      proposalId: rec.id,
      mode: rec.execMode === 'scheduled' ? 'scheduled' : 'immediate',
      dueAt: computeDueAt(rec.execMode, rec.execAt, now),
      state: 'queued',
      attempts: 0,
      requestedBy: by,
      log: `${ts} queued（${rec.execMode}）by ${by}`,
      createdAt: ts,
      updatedAt: ts,
    });
    await et.put(job.id, job);
    await markProposal(rec.id, { execState: 'queued', execError: '', execFinishedAt: '' });
    return { enqueued: true, job };
  }

  /**
   * 提案状态/执行计划写完之后，把队列调整到与之一致。
   *
   * 四种情形：
   *   ① 不在 approved（被撤销/拒绝/人工标记落地）→ 撤销所有活跃执行
   *   ② approved 且正在跑 → 不动（别把正在跑的活掐了）
   *   ③ approved 但不满足自动执行条件（有 blocker / 改成 manual / 定时没填时间）
   *      → 撤掉排着的队，execState 归 idle
   *   ④ approved 且该跑而没有活跃 job → 入队
   */
  async function syncExecutionQueue(rec, { autoEnqueue = true } = {}) {
    const jobs = await activeJobsFor(rec.id);
    if (rec.status !== 'approved') {
      if (jobs.length) await cancelJobs(jobs, `提案状态变为 ${rec.status}`);
      if (rec.execState === 'queued' || rec.execState === 'deferred') {
        await markProposal(rec.id, { execState: rec.status === 'applied' ? 'succeeded' : 'cancelled' });
      }
      return { cancelled: jobs.length };
    }
    if (rec.execState === 'running' || jobs.some((j) => j.state === 'running')) return { kept: 'running' };
    if (!autoEnqueue) return { skipped: 'autoEnqueue-off' };
    const why = autoEnqueueBlocker(rec, jobs);
    if (why === 'already-queued') return { kept: 'queued' };
    if (why) {
      if (jobs.length) await cancelJobs(jobs, `不再满足自动执行条件（${why}）`);
      if (rec.execState === 'queued' || rec.execState === 'deferred') {
        await markProposal(rec.id, { execState: 'idle' });
      }
      return { skipped: why };
    }
    const out = await enqueueOne(rec, { by: 'approval' });
    if (out.enqueued) execWake();
    return out;
  }

  // ---- review files: path discipline + walk (same as agint-wiki) ----
  // Windows 路径逃逸误报修复（2026-10-14）：
  // `resolve()` 在 win32 返回反斜杠路径（`D:\...\reviews`），而判据
  // `abs.startsWith(root + '/')` 拼出的 `D:\...\reviews/` 与真实
  // `D:\...\reviews\xxx.md` 永不匹配 ⇒ 所有合法相对路径都被判 escapes root。
  // 症状（实测）：evolve_read path="2026-10-12-周复盘.md" 抛
  //   `agint-evolve: path escapes root` ⇒ 14 份复盘报告一份都读不到。
  // 修法与 agint-wiki v0.4 同型（plugins/agint-wiki/lib/index.js:43-51）：
  //   比较前把两侧都归一化成正斜杠。不削弱安全 —— `../` 经 resolve() 后
  //   会真正跳出 root，归一化后照样被拒（回归用例覆盖）。
  const normRoot = root.replace(/\\/g, '/');

  const clean = (p) => {
    const trimmed = String(p ?? '').replace(/^\/+/, '');
    if (!trimmed.endsWith('.md')) throw new Error(`agint-evolve: path must end with .md (got "${p}")`);
    const abs = resolve(root, trimmed);
    const normAbs = abs.replace(/\\/g, '/');
    if (normAbs !== normRoot && !normAbs.startsWith(normRoot + '/')) throw new Error(`agint-evolve: path escapes root (got "${p}")`);
    return { rel: trimmed, abs };
  };

  const walk = async (dir) => {
    const out = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return out;
      throw error;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(abs));
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(relative(root, abs));
    }
    return out;
  };

  const readMaybe = async (abs) => {
    try {
      return await readFile(abs, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };

  // ---- live data snapshot from the sibling agint-* services ----
  const safe = async (fn) => {
    try {
      const v = fn();
      return v && typeof v.then === 'function' ? await v : v;
    } catch {
      return null;
    }
  };

  async function dataSnapshot() {
    const memory = ctx.get('agint.memory');
    const wiki = ctx.get('agint.wiki');
    const cron = ctx.get('agint.cron');
    const rules = ctx.get('agint.rules');
    const metrics = ctx.get('agint.metrics');
    const sessionQuery = ctx.get('sessionQuery');
    const inputGateway = ctx.get('agint.inputGateway');

    const snapshot = { collectedAt: nowIso() };

    if (memory && typeof memory.stats === 'function') snapshot.memory = await safe(() => memory.stats());

    if (wiki && typeof wiki.lint === 'function') {
      snapshot.wiki = await safe(() => wiki.lint());
    }

    if (cron && typeof cron.health === 'function') snapshot.cron = await safe(() => cron.health());

    if (rules) {
      const audit = rules.audit ? await safe(() => rules.audit()) : null;
      const lintIssues = rules.lint ? await safe(() => rules.lint()) : null;
      if (audit || lintIssues) {
        snapshot.rules = {
          totals: audit?.totals ?? null,
          fired: audit?.rules ?? [],
          lintIssues: Array.isArray(lintIssues) ? lintIssues : [],
        };
      }
    }

    if (metrics && typeof metrics.summary === 'function') snapshot.metrics = await safe(() => metrics.summary());

    // 神谕层归因样本（提案 a85ef850 第 3 步；老板 2026-10-09 拍板「先建标注采集，
    // 再标定」）。7 个判尺常量至今无回测依据——要标定就得先有「机器判的最丑维
    // ↔ 人工认定的最丑维」成对样本。神谕层是机器侧样本的天然产地（它逐轮记了
    // score/worstKey/verdict），但此前没人把这些行读出来做对照。
    // ⛔ 缺席即 null，不静默跳过：oracle 未挂载与「采集到 0 条」是两句话。
    const oracle = ctx.get('agint.aestheticOracle');
    if (oracle && typeof oracle.calibrationSamples === 'function') {
      snapshot.oracleCalibration = await safe(() => oracle.calibrationSamples({}));
    }

    if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
      snapshot.sessions = await safe(async () => {
        const list = await sessionQuery.listSessions();
        const arr = Array.isArray(list) ? list : [];
        return { count: arr.length, latest: arr[0] ? (arr[0].title ?? arr[0].id ?? '') : '' };
      });
    }

    // v0.7.2：多源输入网关（外部信号 Channel 状态 + security 门禁计数）
    if (inputGateway && typeof inputGateway.getStatus === 'function') {
      snapshot.inputGateway = await safe(() => inputGateway.getStatus());
    }

    // A4：eval 存量 FAIL 归因。⛔ 读不到 ⇒ 整个键缺席，让周报印「本周未采到」，
    //   绝不塞一个 { total: 0 } —— 「没采到」与「真的 0 个 fail」含义相反。
    //
    //   ⛔⛔ 2026-10-04 部署位实测：三种失败态必须各自可观测，不能都退化成「未采到」——
    //     ① pathUnresolved 路径没解析出来（部署位插件不在仓库布局里，祖先无 eval/）
    //     ② 文件不存在        （路径对，产物没生成）
    //     ③ parseError        （路径对，文件坏）
    //   ①②③ 混成一个「未采到」时，运维会去查归因脚本，而真因是插件根本找不到仓库。
    if (!pathResolved) {
      // 状态①：显式带上，让周报说清是「路径没解析出来」而不是「没数据」。
      snapshot.evalFailAttributionUnresolved = true;
      try {
        ctx.logger?.warn?.('evolve: eval 归因路径未解析（不在仓库布局内，需在 config 显式给 evalAttributionPath）', {
          pluginLocation: fileURLToPath(import.meta.url),
        });
      } catch { /* noop */ }
    } else if (evalAttributionPath) {
      const raw = await safe(() => readFile(evalAttributionPath, 'utf8'));
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          const parsed = JSON.parse(raw);
          // 只取白名单字段：周报是给人读的，不该被产物文件里的额外键带偏。
          // 2026-10-20：expectedRed / denominator 一并搬运 ——
          //   覆盖率分母已排除负控制，周报必须能印出分母口径，
          //   否则 total 与 attributed 对不上，读者会以为算错或以为数字突变。
          snapshot.evalFailAttribution = {
            total: Number(parsed.total) || 0,
            attributed: Number(parsed.attributed) || 0,
            coverage: typeof parsed.coverage === 'number' ? parsed.coverage : null,
            coverageMin: typeof parsed.coverageMin === 'number' ? parsed.coverageMin : null,
            expectedRed: typeof parsed.expectedRed === 'number' ? parsed.expectedRed : null,
            denominator: typeof parsed.denominator === 'number' ? parsed.denominator : null,
            byCategory: parsed.byCategory && typeof parsed.byCategory === 'object' ? parsed.byCategory : {},
            realDefects: Number(parsed.realDefects) || 0,
            generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
            unattributedUnitIds: Array.isArray(parsed.results)
              ? parsed.results.filter((r) => r?.category === 'NOT_ATTRIBUTED').map((r) => r.unitId).filter(Boolean)
              : [],
          };
        } catch (parseErr) {
          // 产物文件坏了也要如实说，不能静默当 0。
          snapshot.evalFailAttribution = {
            total: null, attributed: null, coverage: null, coverageMin: null,
            byCategory: {}, realDefects: 0, generatedAt: null,
            parseError: parseErr?.message ?? String(parseErr),
            unattributedUnitIds: [],
          };
        }
      }
    }

    return snapshot;
  }

  // ── evolution.proposed 发布（Sprint 12 A1 接线，2026-09-20） ──────────────
  // 背景：本主题此前**只有订阅方、没有生产发布方** —— agint.population.publishProposed
  //   注册了但生产调用点为 0，生产数据只剩 3 条 09-04 的历史探针。真正的提案源
  //   （生产 55 条）是这里的 propose()，所以发布方接在此处。
  //   取证与判据见 docs/known-limitations/event-bus-shadow-publish-gap.md。
  // 订阅方：agint-evolution-memory（影子写 evolution_log）/ agint-quality-eval /
  //   agint-trajectory（count-only 标定期）。
  // 红线：**直连路径完整保留** —— 落库与返回值不因发布失败而改变；
  //   bus 缺失或 publish 抛错只告警，不阻断 propose。
  async function publishProposed(rec) {
    const publish = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
    if (typeof publish !== 'function') {
      try {
        ctx.logger?.warn?.('evolve: evolution.proposed publish skipped', {
          proposalId: rec.id, reason: 'agint.eventBus.publish unavailable',
        });
      } catch { /* noop */ }
      return { published: false, reason: 'eventBus-unavailable' };
    }
    try {
      const result = await publish({
        topic: 'evolution.proposed',
        version: 1,
        source: 'agint-evolve',
        payload: {
          proposalId: rec.id,
          kind: rec.category || 'other',
          payload: rec,
          origin: 'agint-evolve',
        },
      });
      return { published: true, envelopeId: result?.envelopeId, deliveredTo: result?.deliveredTo ?? 0 };
    } catch (err) {
      try {
        ctx.logger?.warn?.('evolve: evolution.proposed publish failed', {
          proposalId: rec.id, error: err instanceof Error ? err.message : String(err ?? 'unknown'),
        });
      } catch { /* noop */ }
      return { published: false, reason: `publish-threw:${err?.message || err}` };
    }
  }

  /**
   * 提案状态落盘的**核心**（不碰队列）。
   *
   * 为什么从 setStatus 里拆出来：执行器成功落地后要写 `applied`，
   * 但它不该再走一次「入队/撤销队列」的同步 —— 那条路径会把它自己刚写的
   * 执行记录判成「不该有活跃 job」而撤掉。
   *   写状态（applyStatus）与对齐队列（syncExecutionQueue）是两件事，
   *   setStatus = 两者串联；finishExecution 只调前者。
   */
  /**
   * 当前判尺口径。取不到 ⇒ 空串 = 口径未知，**不猜**。
   *
   * 由神谕层提供（`agint.aestheticOracle.formulaVersion`，静态常量）。
   * ⛔ 不在这里 import scoring.js：evolve 与 oracle 是两个独立插件，
   *    跨插件源码 import 会在部署位（各自独立目录）直接 ENOENT。
   */
  function currentFormulaVersion() {
    try {
      const oracle = ctx.get('agint.aestheticOracle');
      const v = oracle && typeof oracle.formulaVersion === 'string' ? oracle.formulaVersion.trim() : '';
      return v;
    } catch {
      return '';
    }
  }

  async function applyStatus(id, status, note = '', opts = {}) {
    const t = await table();
    const rec = t.get(id);
    if (!rec) return null;
    if (!PROPOSAL_STATUSES.includes(status)) throw new Error(`agint-evolve: invalid status "${status}"`);
    const o = opts && typeof opts === 'object' ? opts : {};
    const updated = normalizeProposal({ ...rec, status, note: note ?? rec.note ?? '', updatedAt: nowIso() });
    if (typeof o.blocker === 'string') updated.blocker = o.blocker.trim();
    if (typeof o.unblockCondition === 'string') updated.unblockCondition = o.unblockCondition.trim();
    // 2026-10-27：显式改「能不能自动执行」。⛔ 只认布尔 —— 传字符串/数字一律
    // 当作没传（不猜）。人工把一条提案标成不可自动执行，是给它的兜底闸。
    if (typeof o.autoExecutable === 'boolean') updated.autoExecutable = o.autoExecutable;
    // 执行计划：显式传才改（同 blocker 的冻结语义）—— 判据在 validateExecPlan。
    if (typeof o.execMode === 'string' || typeof o.execAt === 'string') {
      const plan = validateExecPlan({
        execMode: typeof o.execMode === 'string' ? o.execMode : updated.execMode,
        execAt: typeof o.execAt === 'string' ? o.execAt : updated.execAt,
      });
      if (!plan.ok) throw new Error(`agint-evolve: ${plan.reason}`);
      updated.execMode = plan.mode;
      updated.execAt = plan.at;
    }
    // 落地即解除阻塞。applied 是事实（代码已经改了），再挂着 blocker 会让
    // 行内自相矛盾；但**不许静默丢**——原阻塞原因转写进 note，留审计痕迹。
    if (status === 'applied' && updated.blocker !== '') {
      const was = updated.blocker;
      updated.note = `${updated.note}${updated.note ? ' ｜ ' : ''}解除阻塞（原：${was}）`;
      updated.blocker = '';
      if (typeof o.unblockCondition !== 'string') updated.unblockCondition = '';
    }
    await t.put(id, updated);
    return updated;
  }

  // ---- service ----
  const svc = {
    dataSnapshot,

    /** Collect snapshot, detect findings, write reviews/<date>-周复盘.md. */
    async writeReview(opts = {}) {
      const snapshot = await dataSnapshot();
      const findings = findingsFromSnapshot(snapshot);
      const date = String(opts.date ?? new Date().toISOString().slice(0, 10));
      const markdown = buildReport({ date, snapshot, findings, notes: opts.notes });

      await mkdir(root, { recursive: true });
      const base = `${date}-周复盘.md`;
      let rel = base;
      let n = 2;
      while (await readMaybe(join(root, rel)) !== null) {
        rel = `${date}-周复盘-${n}.md`;
        n += 1;
      }
      await writeFile(join(root, rel), markdown, 'utf8');
      const info = await stat(join(root, rel));
      return { path: rel, bytes: info.size, findings, snapshotCollectedAt: snapshot.collectedAt };
    },

    async listReviews() {
      const files = await walk(root);
      const out = [];
      for (const rel of files) {
        const info = await stat(join(root, rel));
        out.push({ path: rel, size: info.size, mtime: info.mtime.toISOString() });
      }
      return out.sort((a, b) => b.path.localeCompare(a.path));
    },

    async readReview(p) {
      const { rel, abs } = clean(p);
      const content = await readMaybe(abs);
      return content === null ? null : { path: rel, content };
    },

    async propose(input) {
      const t = await table();
      const cur = currentFormulaVersion();
      // 2026-10-27：声明式互斥检查。⛔ 只认调用方**显式给的** conflictsWith ——
      // 自动判断「这两条建议互相矛盾」要上 LLM 且误报率高，本条不碰语义比对。
      // 校验口径：目标提案处于 applied / approved 才算「已生效、会打架」；
      // rejected / wontfix / proposed 三档不拦（还没生效，或者已被否）。
      const declared = Array.isArray(input.conflictsWith)
        ? input.conflictsWith.map((s) => String(s ?? '').trim()).filter(Boolean)
        : [];
      if (declared.length) {
        const live = declared
          .map((cid) => ({ id: cid, rec: t.get(cid) }))
          .filter((x) => x.rec && (x.rec.status === 'applied' || x.rec.status === 'approved'));
        if (live.length) {
          const named = live
            .map((x) => `${x.id.slice(0, 8)}（${x.rec.status}）「${String(x.rec.title ?? '').slice(0, 40)}」`)
            .join('；');
          throw new Error(
            `agint-evolve: 与已生效提案互斥，拒绝创建 —— ${named}。`
            + '如两者确实可共存，请在正文「关联」节写清如何并存，并去掉 conflictsWith 后重提。',
          );
        }
      }
      const rec = proposalSchema.parse({
        id: input.id ?? randomId(),
        title: input.title,
        body: input.body,
        category: input.category ?? 'other',
        status: 'proposed',
        source: input.source ?? '',
        note: input.note ?? '',
        // 2026-10-27：复核类提案显式声明「不可自动执行」（oracle 走这条）。
        // ⛔ 只认显式 false —— 少写一个字段 = 可执行（默认 true，向后兼容）。
        autoExecutable: input.autoExecutable === false ? false : true,
        // 成立条件快照：这条结论按哪一版判尺口径成立。空串 = oracle 未挂载，
        // 口径未知 —— 后续不据此判失效，但至少能看出「这条没记」。
        formulaVersion: cur,
        assumedBy: String(input.assumedBy ?? '').trim(),
        conflictsWith: declared,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      await t.put(rec.id, rec);
      // A1 接线：落库后发布 evolution.proposed（失败不影响返回值）
      await publishProposed(rec);
      // 刚创建 ⇒ 口径必然等于当前（或未知）⇒ staleSince 恒为空，仍带上以对齐输出面。
      return { ...rec, staleSince: '' };
    },

    async listProposals(filter = {}) {
      const t = await table();
      const cur = currentFormulaVersion();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.status && rec.status !== filter.status) continue;
        if (filter.category && rec.category !== filter.category) continue;
        // 2026-10-27：blocked 过滤 —— 回答「批准了但还没法动手的有哪些」，
        // 不靠调用方自己从 blocker 字符串反推。
        if (filter.blocked === true && !proposalBlocked(rec)) continue;
        if (filter.blocked === false && proposalBlocked(rec)) continue;
        // staleSince 是**派生值**，不进 schema、不落盘：它随当前口径变化，
        // 一旦写进存储行就会在下次口径变更时变成过期事实（与 createdAt 被
        // strip 那类坑同源，方向相反）。
        out.push({ ...normalizeProposal({ id, ...rec }), staleSince: proposalStaleSince(rec, cur) });
      }
      // 2026-10-27：createdAt 空值安全。schema 已补回该字段，但历史行可能真的没有
      // （2026-10-27 之前的写坏行），排序不该被一条脏数据整段掀翻。
      out.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      return out;
    },

    async getProposal(id) {
      const t = await table();
      const rec = t.get(id);
      if (!rec) return null;
      return { ...normalizeProposal({ ...rec }), staleSince: proposalStaleSince(rec, currentFormulaVersion()) };
    },

    /**
     * setStatus(id, status, note, opts)
     *
     * opts.blocker / opts.unblockCondition：只在**显式传字符串**时才改。
     * 不传 = 冻结现状 —— 否则每次改状态都会把上次写的阻塞原因洗成空，
     * 正是「状态变了但理由静默消失」那一族坑。
     * 传 '' = 明确清除（解锁后回到工作单）。
     *
     * opts.execMode / opts.execAt（2026-10-27）：批准时选执行方式。
     *   同样只在显式传时才改；execMode=immediate|scheduled 且提案处于 approved
     *   且没有 blocker ⇒ **自动入执行队列**，由 agint-executor 捡起来跑。
     *   opts.autoEnqueue === false 可以只写计划不入队（给"先批准、等会儿手动放行"用）。
     */
    async setStatus(id, status, note = '', opts = {}) {
      const rec = await applyStatus(id, status, note, opts);
      if (!rec) return null;
      // 2026-10-28：执行态必须跟着状态归位 —— 状态与执行态各说各话是最贵的不一致。
      //
      // 实机（提案 `846f4fbb`）：它被自动执行误结案成 applied（其实只落地了 3~4 个单元里的
      // 1 个），人工改判回 `approved` 之后 `execState` 仍停在 `succeeded`，
      // 面板照 `m['succeeded']` 显示「已落地」—— 与台账的 status 完全相反。
      // 读的人看到的标签说"做完了"，而台账说"没做完"，两边都不像在撒谎，
      // 这才是它比单纯的字段错误更难查的原因。
      //
      //    **兼职两种口径**：`succeeded` 只在 status=applied 时成立（一次成功 ⇒ 提案做完）；
      //    `partial` / `failed` / `running` 只在 status 属于 approved/applied 时有意义。
      // ⛔ 有活跃执行的提案不动：那边正在跑，队列是事实，不能抢在它前面归位。
      // ⛔ 归位发生在 `syncExecutionQueue` **之前**：execMode 还是 immediate 时再入队是合法的，
      //    队列优先，不该被归位逻辑抢掉（这条写反会让「重新批准」静默降级成什么都没排）。
      const execAliveStatus = rec.status === 'approved' || rec.status === 'applied';
      const staleExec = rec.execState === 'succeeded'
        ? rec.status !== 'applied'
        : (!execAliveStatus && ['partial', 'failed', 'running'].includes(rec.execState));
      if (staleExec) {
        const live = await activeJobsFor(id);
        if (live.length === 0) await markProposal(id, { execState: 'idle' });
      }
      // 计划写完立刻对齐队列：批准即执行就是在这里发生的。
      try {
        await syncExecutionQueue(rec, { autoEnqueue: opts?.autoEnqueue !== false });
      } catch (error) {
        // 入队失败不能把「状态已改」这件事一起吞掉：状态是事实，队列是可重试的。
        try {
          ctx.logger?.warn?.('evolve: syncExecutionQueue failed', {
            proposalId: id, error: error instanceof Error ? error.message : String(error ?? 'unknown'),
          });
        } catch { /* noop */ }
      }
      // 回读一次：syncExecutionQueue 可能改了 execState。
      return (await svc.getProposal(id)) ?? rec;
    },

    async removeProposal(id) {
      const t = await table();
      const ok = await t.delete(id);
      return Boolean(ok);
    },

    async stats() {
      const t = await table();
      let total = 0;
      const byStatus = {};
      const byCategory = {};
      for (const [, rec] of t.entries()) {
        total += 1;
        byStatus[rec.status] = (byStatus[rec.status] ?? 0) + 1;
        byCategory[rec.category] = (byCategory[rec.category] ?? 0) + 1;
      }
      return { total, byStatus, byCategory };
    },

    /**
     * Sprint 12 B3: baselineGate(channel, opts)
     *
     * Input:
     *   channel: string  —— 当前固定 'mount'，预留多通道扩展
     *   opts:
     *     since?: string (ISO) —— 只看此时间之后的最近一次；缺省 = 全部
     *     now?:   Date   —— 测试注入；缺省 = new Date()
     *
     * Output:
     *   { frozen: boolean, lastRunAt: string|null, since: string|null, source: string }
     *
     * 副作用：
     *   - 读 baseline_history 表（filter by channel + since）
     *   - 不写任何字段 —— "只读 + 写 status" 中的只读部分
     *
     * 缺数据时返回 { frozen:false, lastRunAt:null, since, source:'empty' }，
     * 让 driver dispatcher 与 cron 调用方都有稳定空值语义。
     */
    async baselineGate(channel = 'mount', opts = {}) {
      const t = await historyTable();
      const since = typeof opts.since === 'string' ? opts.since : null;
      let latest = null;
      for (const [id, rec] of t.entries()) {
        if (rec.channel !== channel) continue;
        if (since && rec.ranAt < since) continue;
        if (!latest || rec.ranAt > latest.ranAt) latest = { id, ...rec };
      }
      if (!latest) {
        return { frozen: false, lastRunAt: null, since, source: 'empty' };
      }
      return {
        frozen: latest.frozen === true,
        lastRunAt: latest.ranAt,
        since,
        source: latest.source ?? 'cron:baseline-regression-suite',
      };
    },

    /**
     * Sprint 12 B3: 由 `agint-cron` 的 `baseline-regression-suite` job 调用，
     * 写一行 baseline_history。返回写入的记录 id。
     *
     * Input:
     *   channel:    string        —— 'mount'（预留扩展）
     *   passRate:   number 0..1
     *   passed:     int
     *   total:      int
     *   source?:    string        —— 默认 'cron:baseline-regression-suite'
     *
     * 副作用：
     *   - 写 baseline_history 一行（id = ranAt ISO 字符串）
     *   - 不动 mutation / 不动 policy
     */
    async recordBaselineRun(input) {
      const channel = String(input?.channel ?? 'mount');
      const passRate = Number(input?.passRate ?? 0);
      const passed = Number(input?.passed ?? 0);
      const total = Number(input?.total ?? 0);
      const source = String(input?.source ?? 'cron:baseline-regression-suite');
      const ranAt = nowIso();
      const rec = baselineHistorySchema.parse({
        id: ranAt,
        channel,
        passRate,
        passed,
        total,
        frozen: passRate < 0.95,
        source,
        ranAt,
      });
      const t = await historyTable();
      await t.put(rec.id, rec);
      return { id: rec.id, ...rec };
    },

    /**
     * Sprint 12 B3: 列出 baseline_history 全部行，按 ranAt 倒序。
     * 调试 / 报告 / 测试用。
     */
    async listBaselineHistory(filter = {}) {
      const t = await historyTable();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.channel && rec.channel !== filter.channel) continue;
        out.push({ id, ...rec });
      }
      out.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
      return out;
    },

    // ── 执行队列（2026-10-27）─────────────────────────────────────────
    //
    // 「批准即执行」的存取层。谁来跑不在这里 —— 由 agint-executor 的 tick 调
    // `claimDueExecutions()` 捡到期任务，跑完把结果交回 `finishExecution()`。
    // ⛔ 分工是刻意的：本插件管**事实**（谁批准了、什么时候该跑、跑到哪一步），
    //    执行器管**动作**（起 LLM、写仓库）。把 LLM 调用塞进数据层，周报和面板
    //    就会跟着一个长跑任务一起卡住。

    /**
     * 手动入队（面板「立即执行」/ 工具 evolve_executions run-now）。
     * force=true 时不看 autoEnqueueBlocker（用于「上周被上限顺延，今天手动放行」），
     * 但 blocker 与状态仍会被执行器的 tick 再复核一次 —— 不是"绕过门禁"的通道。
     */
    async enqueueExecution(id, opts = {}) {
      const t = await table();
      const rec = t.get(id);
      if (!rec) return { enqueued: false, reason: 'proposal-not-found' };
      const normalized = normalizeProposal({ ...rec });
      // 手动入队允许临时改计划：显式给了 execMode 就按它走。
      let plan = null;
      if (typeof opts.execMode === 'string' || typeof opts.execAt === 'string') {
        plan = validateExecPlan({
          execMode: typeof opts.execMode === 'string' ? opts.execMode : normalized.execMode,
          execAt: typeof opts.execAt === 'string' ? opts.execAt : normalized.execAt,
        });
        if (!plan.ok) return { enqueued: false, reason: plan.reason };
        await markProposal(id, { execMode: plan.mode, execAt: plan.at });
      }
      const target = await svc.getProposal(id);
      const out = await enqueueOne(target, {
        by: opts.by ?? 'manual',
        force: opts.force === true,
      });
      if (out.enqueued) execWake();
      return out;
    },

    /** 到期的执行行 → 置 running 并返回（执行器的 claim 动作）。 */
    async claimDueExecutions(opts = {}) {
      const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
      const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Number(opts.limit)) : 1;
      const et = await executionTable();
      const due = [];
      for (const [id, row] of et.entries()) {
        if (!row) continue;
        if (!isJobDue({ id, ...row }, now)) continue;
        due.push({ id, ...row });
      }
      due.sort((a, b) => String(a.dueAt ?? '').localeCompare(String(b.dueAt ?? '')));
      const claimed = [];
      for (const row of due) {
        if (claimed.length >= limit) break;
        const ts = new Date(now).toISOString();
        const next = executionSchema.parse({
          ...row,
          state: 'running',
          attempts: (Number(row.attempts) || 0) + 1,
          startedAt: ts,
          updatedAt: ts,
          log: [row.log, `${ts} running（第 ${(Number(row.attempts) || 0) + 1} 次）`].filter(Boolean).join('\n').slice(-4000),
        });
        await et.put(row.id, next);
        await markProposal(row.proposalId, {
          execState: 'running',
          execStartedAt: ts,
          execAttempts: next.attempts,
          execError: '',
        });
        claimed.push(next);
      }
      return claimed;
    },

    /**
     * 一次执行的终局。ok=true 时**同时**把提案标 applied（带落地证据）——
     * 「执行成功」与「提案已落地」在自动执行这条路径上必须是同一刻，
     * 否则面板会同时显示「已批准待执行」和「已落地」。
     */
    async finishExecution(execId, patch = {}) {
      const et = await executionTable();
      const job = et.get(execId);
      if (!job) return null;
      const ok = patch.ok === true;
      const wanted = patch.state;
      const state = ok
        ? 'succeeded'
        : (wanted === 'deferred' || wanted === 'cancelled' ? wanted : 'failed');
      const ts = nowIso();
      const detail = patch.error || patch.reason || '';
      const next = executionSchema.parse({
        ...job,
        state,
        ok,
        mutationId: patch.mutationId ?? job.mutationId ?? '',
        commitPath: patch.commitPath ?? job.commitPath ?? '',
        policyDecision: patch.policyDecision ?? job.policyDecision ?? '',
        reason: patch.reason ?? job.reason ?? '',
        error: patch.error ?? job.error ?? '',
        finishedAt: ts,
        updatedAt: ts,
        log: [job.log, `${ts} ${state}${detail ? ` ${detail}` : ''}`].filter(Boolean).join('\n').slice(-4000),
      });
      await et.put(execId, next);

      // ── 部分落地（2026-10-28，提案 `846f4fbb` 实证）──────────────────
      //
      // 「job 成功」≠「提案做完」。一次自动执行的原子单元是一个文件的一次编辑，
      // 而提案横跨多文件是常态 —— driver v0.9.0 起会把 `scope`（unitsApplied/unitsTotal/
      // remainingUnits）从返回值里带出来，执行器据此打 `partial=true`。
      //
      // ⛔ 这里**不**走 applyStatus('applied')：
      //    2026-10-28 23:31 那次就是这样把 846f4fbb 结案的 —— 3 个单元只落地 1 个
      //    （`agint-evolve` 的替身收窄了），却记成 `status=applied · execError=''`；
      //    台账一结案，`agint-input-gateway` 的替身、共用模块、真调断言全部失去入口。
      //    剩下两种之前的选项都不成立：报失败会把已落地的那份说成没做；报成功是撒谎。
      //
      // ⇒ 提案 status 保持 `approved`（仍然是要做的事），execState 打到 `partial`，
      //    execError 里写明「落地了哪个、还差哪些」，面板一眼能看见欠账。
      if (ok && patch.partial === true) {
        const rec2 = await table().then((t) => t.get(job.proposalId));
        const units = patch.unitsTotal ? `${patch.unitsApplied ?? 1}/${patch.unitsTotal}` : '多单元';
        const evidence = `部分落地（${units} 个原子单元，job 已成功但提案未完）：`
          + `已落地 ${patch.commitPath || '（无路径）'}`
          + `${patch.policyDecision ? ` · policy=${patch.policyDecision}` : ''}`
          + `${patch.mutationId ? ` · mutation=${patch.mutationId}` : ''}`
          + ` · 剩余单元 ${Array.isArray(patch.remainingUnits) && patch.remainingUnits.length
            ? patch.remainingUnits.join('、')
            : '（提案要求新建资产，或 units 未上报）'}`
          + ` —— agint-executor 于 ${ts}`;
        const note2 = rec2?.note ? `${rec2.note} ｜ ${evidence}` : evidence;
        await markProposal(job.proposalId, {
          note: note2,
          execState: 'partial',
          execError: (patch.reason || `部分落地 ${units} 个单元，剩余单元见 note`).slice(0, 500),
          execAttempts: next.attempts,
          execFinishedAt: ts,
        });
        // ⛔ 不同"撤别的活跃 job"分支：partial 不是「已落地」，别的排队的执行
        //   正是用来补剩余单元的，掐掉它们等于把拆出来的子任务一起杀掉。
        return next;
      }

      if (ok) {
        const rec = await table().then((t) => t.get(job.proposalId));
        const evidence = `自动执行落地：${patch.commitPath || '（无路径）'}`
          + `${patch.policyDecision ? ` · policy=${patch.policyDecision}` : ''}`
          + `${patch.mutationId ? ` · mutation=${patch.mutationId}` : ''}`
          + ` —— agint-executor 于 ${ts}`;
        const note = rec?.note ? `${rec.note} ｜ ${evidence}` : evidence;
        await applyStatus(job.proposalId, 'applied', note, {});
        await markProposal(job.proposalId, {
          execState: 'succeeded',
          execError: '',
          execAttempts: next.attempts,
          execFinishedAt: ts,
        });
        // 同一提案若还排着别的执行，一并撤掉（一次落地就够，不重复改同一处）。
        const others = (await activeJobsFor(job.proposalId)).filter((j) => j.id !== execId);
        if (others.length) await cancelJobs(others, '同一提案已落地');
      } else if (state === 'failed') {
        await markProposal(job.proposalId, {
          execState: 'failed',
          execError: (patch.error || patch.reason || '未知原因').slice(0, 500),
          execAttempts: next.attempts,
          execFinishedAt: ts,
        });
      } else if (state === 'deferred') {
        await markProposal(job.proposalId, {
          execState: 'deferred',
          execError: (patch.reason || '').slice(0, 500),
        });
      } else if (state === 'cancelled') {
        await markProposal(job.proposalId, { execState: 'cancelled' });
      }
      return next;
    },

    /**
     * 重新排队（失败重试 / 周上限顺延）。dueAt 决定什么时候再被 claim；
     * deferred=true 表示「不是失败，是等条件」，面板按 supply 显示。
     */
    async requeueExecution(execId, opts = {}) {
      const et = await executionTable();
      const job = et.get(execId);
      if (!job) return null;
      const ts = nowIso();
      const deferred = opts.deferred === true;
      const state = deferred ? 'deferred' : 'queued';
      const dueAt = typeof opts.dueAt === 'string' && opts.dueAt !== ''
        ? opts.dueAt
        : new Date(Date.now()).toISOString();
      const next = executionSchema.parse({
        ...job,
        state,
        dueAt,
        reason: opts.reason ?? job.reason ?? '',
        error: deferred ? '' : (opts.error ?? job.error ?? ''),
        finishedAt: '',
        updatedAt: ts,
        log: [job.log, `${ts} ${state} → ${dueAt}${opts.reason ? ` ${opts.reason}` : ''}`].filter(Boolean).join('\n').slice(-4000),
      });
      await et.put(execId, next);
      await markProposal(job.proposalId, {
        execState: state,
        execError: deferred ? (opts.reason ?? '') : (opts.error ?? ''),
      });
      return next;
    },

    /**
     * 撤销执行。参数可以是 execution id，也可以是 proposal id
     * （面板拿到的是提案 id，工具拿到的是执行 id —— 两种都得认，不然必有一边点不动）。
     */
    async cancelExecution(idOrExecId, reason = '手动撤销') {
      const et = await executionTable();
      const direct = et.get(idOrExecId);
      if (direct) {
        const [done] = await cancelJobs([{ id: idOrExecId, ...direct }], reason);
        if (done) await markProposal(direct.proposalId, { execState: 'cancelled' });
        return done ? [done] : [];
      }
      const jobs = await activeJobsFor(idOrExecId);
      if (!jobs.length) return [];
      const done = await cancelJobs(jobs, reason);
      await markProposal(idOrExecId, { execState: 'cancelled' });
      return done;
    },

    async listExecutions(filter = {}) {
      const et = await executionTable();
      const since = typeof filter.since === 'string' ? filter.since : null;
      const limit = Number.isFinite(Number(filter.limit)) ? Math.max(1, Number(filter.limit)) : 200;
      const out = [];
      for (const [id, row] of et.entries()) {
        if (!row) continue;
        if (filter.proposalId && row.proposalId !== filter.proposalId) continue;
        if (filter.state && row.state !== filter.state) continue;
        if (since && String(row.updatedAt ?? '') < since) continue;
        out.push({ id, ...row, summary: describeExecution({ id, ...row }) });
      }
      out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
      return out.slice(0, limit);
    },

    /** 执行队列体检：排队/在跑/本周落地数 —— 执行器与面板共用一套口径。 */
    async executionStats(opts = {}) {
      const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
      const rows = await svc.listExecutions({ limit: 1000 });
      const byState = {};
      for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
      // 自然周口径（见 execution.js startOfWeek 的注释）。
      const week = weeklyUsage(rows, now, Math.max(1, now - startOfWeek(now)));
      return {
        total: rows.length,
        byState,
        queued: rows.filter((r) => r.state === 'queued' || r.state === 'deferred').length,
        running: byState.running ?? 0,
        lastWeekCommits: week.count,
        weekSince: week.since,
        weekOf: new Date(startOfWeek(now)).toISOString(),
        latest: rows[0] ?? null,
      };
    },

    /**
     * 面板/工具用的展示口径（一句话）。⛔ 不在 UI 里各自拼字符串：
     * 「失败：x」和「x」两种写法会让同一个状态看起来像两件事。
     */
    describeExecution(job) {
      return describeExecution(job);
    },

    _statuses: PROPOSAL_STATUSES,
    _categories: PROPOSAL_CATEGORIES,
    _execModes: EXEC_MODES,
    _execStates: EXEC_STATES,
  };

  ctx.provide('agint.evolve', svc);
}

export { Config, apply, inject, name };
