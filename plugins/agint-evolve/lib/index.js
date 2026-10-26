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

const spec = defineDomain({
  name: 'agint_evolve',
  version: 2,
  tables: {
    proposal: { valueSchema: proposalSchema },
    baseline_history: { valueSchema: baselineHistorySchema },
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
  return {
    ...rec,
    blocker: typeof rec.blocker === 'string' ? rec.blocker : '',
    unblockCondition: typeof rec.unblockCondition === 'string' ? rec.unblockCondition : '',
  };
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

  // ---- service ----
  ctx.provide('agint.evolve', {
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
      const rec = proposalSchema.parse({
        id: input.id ?? randomId(),
        title: input.title,
        body: input.body,
        category: input.category ?? 'other',
        status: 'proposed',
        source: input.source ?? '',
        note: input.note ?? '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      await t.put(rec.id, rec);
      // A1 接线：落库后发布 evolution.proposed（失败不影响返回值）
      await publishProposed(rec);
      return { ...rec };
    },

    async listProposals(filter = {}) {
      const t = await table();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.status && rec.status !== filter.status) continue;
        if (filter.category && rec.category !== filter.category) continue;
        // 2026-10-27：blocked 过滤 —— 回答「批准了但还没法动手的有哪些」，
        // 不靠调用方自己从 blocker 字符串反推。
        if (filter.blocked === true && !proposalBlocked(rec)) continue;
        if (filter.blocked === false && proposalBlocked(rec)) continue;
        out.push(normalizeProposal({ id, ...rec }));
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return out;
    },

    async getProposal(id) {
      const t = await table();
      const rec = t.get(id);
      return rec ? normalizeProposal({ ...rec }) : null;
    },

    /**
     * setStatus(id, status, note, opts)
     *
     * opts.blocker / opts.unblockCondition：只在**显式传字符串**时才改。
     * 不传 = 冻结现状 —— 否则每次改状态都会把上次写的阻塞原因洗成空，
     * 正是「状态变了但理由静默消失」那一族坑。
     * 传 '' = 明确清除（解锁后回到工作单）。
     */
    async setStatus(id, status, note = '', opts = {}) {
      const t = await table();
      const rec = t.get(id);
      if (!rec) return null;
      if (!PROPOSAL_STATUSES.includes(status)) throw new Error(`agint-evolve: invalid status "${status}"`);
      const updated = normalizeProposal({ ...rec, status, note: note ?? rec.note ?? '', updatedAt: nowIso() });
      const o = opts && typeof opts === 'object' ? opts : {};
      if (typeof o.blocker === 'string') updated.blocker = o.blocker.trim();
      if (typeof o.unblockCondition === 'string') updated.unblockCondition = o.unblockCondition.trim();
      // 落地即解除阻塞。applied 是事实（代码已经改了），再挂着 blocker 会让
      // 行内自相矛盾；但**不许静默丢**——原阻塞原因转写进 note，留审计痕迹。
      if (status === 'applied' && updated.blocker !== '') {
        const was = updated.blocker;
        updated.note = `${updated.note}${updated.note ? ' ｜ ' : ''}解除阻塞（原：${was}）`;
        updated.blocker = '';
        if (typeof o.unblockCondition !== 'string') updated.unblockCondition = '';
      }
      await t.put(id, updated);
      return { ...updated };
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

    _statuses: PROPOSAL_STATUSES,
    _categories: PROPOSAL_CATEGORIES,
  });
}

export { Config, apply, inject, name };
