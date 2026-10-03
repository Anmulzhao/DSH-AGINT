#!/usr/bin/env node
/**
 * bin/build-scenario-inventory.mjs —— 交付物 0：场景清单化（Inventory）
 *
 * ★ 为什么要有这个脚本（设计 §2.1）：
 *   v1.0 的设计直接写「从 104 个场景中分配 60/32/12」，却从没定义
 *   「一个场景」是什么。核对仓库后发现三种可能的计量单位，数值差异巨大：
 *     - .scenario.json 文件数      ≈ 36
 *     - driver.js 全量回归计数     104
 *     - 单测断言数                 216+
 *   三者不是一回事。在单位未定义前，任何「覆盖率 ≥80%」的说法都算不出分母。
 *   本脚本就是用来**实测**而不是**推算**这个分母的。
 *
 * 计量单位（设计 §2.2.1）：
 *   场景单位 = driver.js 全量回归中可独立判定 PASS/FAIL 的最小执行单元
 *   判定标准（三条同时满足）：
 *     1. 有唯一稳定 ID（跨次运行不变）
 *     2. 可独立执行且独立判定结果
 *     3. 是 92/104 计数中的 1 个
 *
 * 实现要点：
 *   - 一个 .scenario.json 可以是数组 ⇒ 一个文件含 N 个单元。这是
 *     「37 个文件」与「123 个单元」差异的来源（driver.js loadScenarios 实测）。
 *   - dedicated/ 下的场景不被 driver 扫到（driver 只扫 __dirname 且不递归），
 *     因此按 §2.2.1 的字面定义**不属于**本 Inventory 的计量范围，
 *     单独记录在 dedicatedUnits 段，等待 §附录 C.2 第 9 项拍板。
 *   - contentHash 基于**文件中原始存储的定义**（不含 $AGINT_ROOT 替换结果），
 *     保证换台机器算出来一样。
 *
 * 用法：
 *   node bin/build-scenario-inventory.mjs                 完整模式（跑 driver，Tier B）
 *   node bin/build-scenario-inventory.mjs --static-only    降级模式（不跑 driver，Tier A）
 *   node bin/build-scenario-inventory.mjs --out=<path>     指定输出（测试用）
 *   node bin/build-scenario-inventory.mjs --check          只校验不写盘（三层隔离门禁）
 *   node bin/build-scenario-inventory.mjs --emit-tiering   生成/补全三层 sidecar 映射文件
 *
 * ⛔ --check 必须早于写盘（见 build-spec-index.mjs 文件头的同型坑）：
 *    先写盘再校验 ⇒ 拿刚生成的版本跟自己对账 ⇒ 永远一致 ⇒ 门禁变自证循环。
 *
 * 退出码（设计 §2.2.4）：
 *   0 = 生成成功且对账一致（或降级模式显式声明未完成对账）
 *   2 = 生成成功但对账不一致（delta ≠ 0）⇒ 打印差异，需人工确认后才可继续
 *   1 = 生成失败 / --check 校验不通过
 *
 * 零依赖：只用 node:fs / node:path / node:crypto / node:child_process。
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { canonicalHash } from './lib/canonical-json.mjs';
import {
  TIER_VALUES,
  LABEL_AUTHORITY_VALUES,
  DEFAULT_TIER,
  DEFAULT_LABEL_AUTHORITY,
  TIERING_VERSION,
  readTierMap,
  assignTiers,
  summarizeTiers,
  checkTierAssignment,
  frozenAggregateHash,
} from './lib/scenario-tier.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCENARIOS_DIR = join(REPO_ROOT, 'eval', 'scenarios');
const DRIVER_PATH = join(SCENARIOS_DIR, 'driver.js');

const INVENTORY_VERSION = '1.0';

/**
 * 设计 §2.2.1 的计量单位定义 + Sprint 18 拍板确认的**范围边界**（附录 C.2 第 9 项）。
 *
 * 边界为什么必须写进定义本身：口径一旦不写清，123 与 125 会在不同文档里混用，
 * 通过率就会变成不可比较的量。此处是唯一权威表述。
 */
const UNIT_DEFINITION =
  'driver.js 全量回归中可独立判定 PASS/FAIL 的最小执行单元';

/**
 * FAIL 差集对账（实测方法与结论，2026-10-02）。
 *
 * ⚠️ 关键方法论警示：拿旧 commit 重跑 driver **不能**复原历史 fail 名单 ——
 * 实测在 b6a14f7（2026-08-28）跑出 13 passed / 91 failed (of 104)，
 * 因为旧 plugin 代码配当前 dsh 运行时会大面积不兼容。那是环境污染值，不是历史真值。
 */
const FAIL_RECON = {
  method: [
    '1) 用 git worktree 检出 b6a14f7（92/104 声称时点），静态提取 104 个单元的 scenario 名（其中 102 个具名，另 2 个是当时还在根目录的 dedicated 文件——它们没有 scenario 字段，正对应历史记载的「125 场景 / 2 SKIP」）。',
    '2) 与当前 driver 口径 123 个单元名做差集，判定「改名 / 删除 / 新增」。',
    '3) 对旧时点即存在的单元，逐个比对单元 JSON 内容，找出此后被改过的。',
    '4) 尝试复原 12 个旧 fail 的 unitId：检索 wiki 与仓库全部文档 + git 历史，未发现任何记录过名单的 artifact（只有数字 12）。',
  ].join('\n'),

  confirmed: {
    renamedOrRemoved: 0,
    renamedOrRemovedNote:
      '旧时点 102 个具名单元**全部**仍以同名存在于当前 driver 口径 ⇒ ' +
      '排除「因重构/改名而消失导致静默失忆」这一分支。这是本次对账最关键的结论。',
    addedUnits: 21,
    addedNote: '123 − 102 = 21 个新增具名单元（总数差 +19 = 21 新增 − 2 个 dedicated 文件移出扫描范围）。',
    currentlyFailingThatExistedThen: [
      'cron-default-jobs-registered',
      'service-annotations-table-full-throws',
      'policy-decide-clean-results-pending-or-deploy',
      'sprint6-cron-job-prompt-static-check-registered',
      // 2026-10-03 新增：见下方 confirmedRegression。
      // 它**在旧时点就存在**（实测 b6a14f7 的 102 个具名单元里含此名），
      // 故归入「旧单元」而不是「新增单元」。
      'stats-reports-counts-and-limits',
    ],
    currentlyFailingThatAreNew: ['s12-05-policy-policy-deployed-rolledback-shadow'],
    newFailNote: '该单元 2026-08-29 才随 Sprint 12 的 event-bus 系列新增，不可能是旧 12 fail 之一。',

    // ⚠️ 2026-10-03 实测新确认的一处回归。写在这里是因为：入仓清单此前记它 PASS，
    //    现在是 FAIL，而清单是本仓**唯一持久化的 fail 名单** —— 不记就等于失忆。
    confirmedRegression: {
      unitId: 'stats-reports-counts-and-limits',
      wasStatus: 'PASS',
      wasSource: 'eval/scenarios/inventory.json @ generatedAt 2026-10-02T13:14:01Z（入仓清单实测值）',
      nowStatus: 'FAIL',
      nowSource: '2026-10-03 实测：node eval/scenarios/driver.js --tier=ALL ⇒ 117 passed, 6 failed (of 123)',
      detail: 'driver 报 `keys_ok=true limits_ok=false`',
      rootCause:
        '场景断言 `stats-shape.limitsShape` 写死了 LIMITS 的**全量形状**（3 键：' +
        'FAILURE_PATTERNS / SUCCESS_TEMPLATES / EVOLUTION_LOG_LINES_PER_DAY）。' +
        '而 plugins/agint-evolution-memory/lib/schema.js 的 LIMITS 此后新增了 ' +
        'CONTRACT_LOCKS（b1731c3，2026-10-02）与 PREDICTION_OUTCOMES（3d576b6，2026-10-03）' +
        '⇒ 形状对不上 ⇒ limits_ok=false。**加表即挂**，属既存缺陷，不是本次改动引入。',
      sceneUnchanged: true,
      sceneUnchangedEvidence:
        'git diff --stat b6a14f7 HEAD -- eval/scenarios/agint-evolution-memory.scenario.json ⇒ 空。' +
        '⇒ 场景文件自旧基线起未被改过 ⇒ 是 plugin 代码侧的回归，不是「改场景改挂」。',
      notFixedHere:
        '本轮**不修**它。改这个断言等于改判据，属 Sprint 17 归因/修复范围，须老板点头；' +
        '且本 Sprint 的交付是三层隔离。此处只负责把真值写进清单，让回归不再隐形。',
    },
  },

  arithmetic:
    '设 F = 旧 12 个 fail 中现已转 PASS 的数量，R = 旧时点存在但当时 PASS、如今回归为 FAIL 的数量。' +
    '当前失败的旧单元数 5 = (12 − F) + R ⇒ F = 7 + R。' +
    '⇒ **至少 7 个旧 fail 已被修复**；另有 R ∈ [0,5] 个旧单元发生回归（无法确定，因名单未留存）。' +
    '净变化 −6 = −F（修复）+ R（回归）+ 1（新增 s12-05），与 12 → 6 自洽。' +
    '⚠️ 与 2026-10-02 那版（当时是 12 → 5）相比**变差了 1 个**：' +
    'stats-reports-counts-and-limits 从 PASS 转 FAIL，根因见 confirmedRegression。' +
    '⚠️ 它是否属于 R 无法确证：只知道它 2026-10-02 是 PASS，不知道它在 b6a14f7 时点的状态' +
    '（那 12 个 fail 的名单从未被任何 artifact 记录）。故 R 的下界仍取 0。',

  candidates: {
    note:
      '旧时点即存在、且单元内容此后被改过的只有 5 个。其中 3 个现已 PASS —— ' +
      '它们是最可能「由 FAIL 转 PASS」的对象（改测试或改代码都可能）。',
    changedAndNowPass: [
      'sandbox-falls-back-when-ctx-sandbox-missing',
      'sandbox-gate-passes-when-sandbox-ok',
      'sandbox-gate-skipped-when-no-sandbox-service',
    ],
    changedAndStillFail: [
      'cron-default-jobs-registered',
      'sprint6-cron-job-prompt-static-check-registered',
    ],
    changedAndStillFailNote:
      '这两个的 expected 列表被改过（随新增 cron job 更新）但仍 FAIL ⇒ 不是「改测试改绿」，是预期仍落后于实况。',
    untouchedAndNowPass: 94,
    untouchedNote:
      '其余 97 个旧单元内容从未改动，其中 **94 个现为 PASS**、3 个现为 FAIL' +
      '（service-annotations-table-full-throws / policy-decide-clean-results-pending-or-deploy / ' +
      'stats-reports-counts-and-limits）⇒ 若旧 fail 在其中，是被 plugin 代码修复（不是靠改测试），' +
      '属于真正的修复。' +
      '⚠️ 2026-10-02 那版写的是 95 个 PASS —— 少掉的这一个正是新确认的回归' +
      'stats-reports-counts-and-limits（见 confirmedRegression），不是统计口径变了。',
  },

  irreducible:
    '⚠️ 无法逐项复原那 12 个 unitId：它们从未被任何 artifact 记录 —— wiki 只有数字 12，' +
    '仓库无存档的 driver 输出，旧 commit 重跑会被当前 dsh 运行时污染（实测 13/91/104 不可用）。' +
    '这不是本次对账的疏漏，而是**此前从未持久化 fail 名单**造成的既成事实。',

  remediation:
    '本 inventory.json 入仓后即成为首个持久化的 fail 名单（units[].lastKnownStatus = FAIL 即完整列表，' +
    '且 attribution.pendingUnits 单独列出）。此后每次生成都留痕，同类失忆不会再发生。',
};

/** 范围边界句，与 UNIT_DEFINITION 一并写入 inventory.json。 */
const UNIT_SCOPE = [
  '计量范围 = eval/scenarios/ 根目录下的 *.scenario.json（driver 只扫自身所在目录且不递归）。',
  '权威总数 = 123（driver 口径）。⚠️ 不含 eval/scenarios/dedicated/ 下的单元 —— ' +
    '它们由专属 runner 执行（run-mutator-eval.mjs / run-counterfactual-stress.mjs），' +
    '在 driver 口径内的 lastKnownStatus 为 UNKNOWN，混入分母会让通过率不可计算。',
  'dedicated 单元单独记录在 dedicatedUnits 段（2 个文件 / 29 个可执行单元：mutator 19 场景 + counterfactual 10 fixture），' +
    '不进任何分层、配额与通过率分母。',
  '反转条件：若将来 dedicated 的两个专属 runner 被退役、这些场景改由 driver dispatch，' +
    '则并入计量范围并重跑全部配额计算（H1/H2/H3 的分母都依赖此数）。' +
    '⚠️ 并入后的总数取决于采用的粒度：按 runner 粒度为 123+29=152；' +
    '按 driver 历史上对这两个文件的计数口径（一个文件算一个单元，见 ' +
    'docs/operations/eval-fail-attribution-20260909.md 记的「125 场景 / 2 SKIP」）为 125。' +
    '两者不可混用。',
  '注：提交 be115d1 的信息写「主 driver 成为唯一门禁」，该表述针对的是 diagnosis / self-model / ' +
    'deploy-budget 三个 dispatcher 的收口，不等于要求 dedicated 并入 driver。此处按实测维持独立 runner。',
].join('\n');

/**
 * 设计 §2.2.3 的 domain 归类表（按**文件前缀**匹配，自上而下首个命中生效）。
 * ⚠️ 顺序有意义：越具体的规则必须排在越前面。
 */
const DOMAIN_RULES = [
  ['agint-mount-s11-', 'mount'],
  ['agint-event-bus-s12-', 'event-bus'],
  ['agint-quality-', 'quality'],
  ['agint-rules', 'rules'],
  ['agint-evolution-memory', 'evolution-memory'],
  ['agint-memory', 'memory'],
  ['agint-diagnosis', 'diagnosis'],
  ['agint-dream', 'dream'],
  ['agint-metrics', 'metrics'],
  ['agint-cron', 'cron'],
  ['agint-self-model', 'self-model'],
  ['agint-sprint6-pipeline', 'pipeline'],
  ['install-security', 'install-security'],
  ['agint-mutator', 'mutator'],
];

/**
 * kind 归类。设计 §2.2.2 允许 smoke | integration | e2e | dedicated 四值，
 * 但未给出逐单元的判定规则。这里按**可核查的既有记载**做保守归类，
 * 并在输出里保留 classifyNotes 供人工复核 —— 不猜的就标默认，不伪造证据。
 */
const KIND_RULES = [
  // dedicated/ 由独立 runner 执行（run-diagnosis-eval / run-mutator-eval），
  // 且不被 driver 扫到 —— 实测确认，见 driver.js loadScenarios。
  [(f) => f.startsWith('dedicated/'), 'dedicated'],
  // Sprint11 记载「8 e2e 全 PASS」（Sprint12-设计稿 §上游状态），mount s11 系列即该批。
  [(f) => f.includes('agint-mount-s11-'), 'e2e'],
];

/** 默认 kind。绝大多数单元走 driver 的 mock ctx 调真实 plugin 方法 ⇒ 集成级。 */
const DEFAULT_KIND = 'integration';

/**
 * 外部依赖。实测依据：driver.js:39-40 通过 `npm root -g` 解析全局 dsh 的
 * node_modules 并写 NODE_PATH —— 所有经 driver 执行的单元都依赖 dsh 运行时。
 */
const DEFAULT_EXTERNAL_DEPS = ['dsh-runtime'];

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes('--static-only');
const CHECK_ONLY = argv.includes('--check');
const outArg = argv.find((a) => a.startsWith('--out='));
const OUT_PATH = outArg
  ? resolve(process.cwd(), outArg.slice('--out='.length))
  : join(SCENARIOS_DIR, 'inventory.json');
const tieringArg = argv.find((a) => a.startsWith('--tiering='));
const TIERING_PATH = tieringArg
  ? resolve(process.cwd(), tieringArg.slice('--tiering='.length))
  : join(REPO_ROOT, 'eval', 'tiers', 'agint-tiering.json');
const emitArg = argv.find((a) => a.startsWith('--emit-tiering'));
const EMIT_TIERING = emitArg
  ? emitArg.includes('=')
    ? resolve(process.cwd(), emitArg.slice('--emit-tiering='.length))
    : TIERING_PATH
  : null;

// ── 小工具 ──────────────────────────────────────────────────────────────────
function fail(msg) {
  console.error(`[build-scenario-inventory] ${msg}`);
  process.exit(1);
}

function classifyDomain(file) {
  const base = file.split('/').pop();
  for (const [prefix, domain] of DOMAIN_RULES) {
    if (base.startsWith(prefix)) return domain;
  }
  return 'UNCLASSIFIED';
}

function classifyKind(file) {
  for (const [test, kind] of KIND_RULES) {
    if (test(file)) return kind;
  }
  return DEFAULT_KIND;
}

/** driver.js 的 git blob hash（用于判断 Inventory 是哪版 driver 跑出来的）。 */
function gitBlobHash(absPath) {
  const r = spawnSync('git', ['hash-object', absPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout) {
    return `UNAVAILABLE:${(r.stderr || 'git 不可用').trim().split('\n')[0]}`;
  }
  return r.stdout.trim();
}

/**
 * 递归收集 .scenario.json。
 * @param {string} dir 绝对目录
 * @param {string} relPrefix 相对 SCENARIOS_DIR 的路径前缀（用 / 分隔）
 */
function collectFiles(dir, relPrefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.scenario.json')) {
      out.push({ abs: join(dir, entry.name), rel: `eval/scenarios/${rel}` });
    }
  }
  return out;
}

/** 解析场景文件 → 单元数组（保留文件中原始形态，不做 $AGINT_ROOT 替换）。 */
function parseUnits(absPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (e) {
    fail(`场景文件 JSON 解析失败：${absPath} — ${e.message}`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ── 跑 driver 取实测状态 ────────────────────────────────────────────────────
const RESULT_RE = /^(✓ PASS|✗ FAIL|⊘ SKIP)  (.*)$/;
const SUMMARY_RE = /^=== (\d+) passed, (\d+) failed, (\d+) skipped \(of (\d+)\) ===$/;

/**
 * 执行 driver.js 全量回归并解析 stdout。
 * 设计 §附录 C.1 已实测 driver 不支持 --json，因此按设计给的降级路径解析 stdout。
 *
 * @returns {{ statuses: Map<string,string>, summary: object|null, raw: string }}
 */
function runDriver() {
  // ⛔ 必须显式 --tier=ALL：清单是**全量门禁口径**，要覆盖 Validation / Frozen，
  //    否则它们的 lastKnownStatus 会是 UNKNOWN，而 UNKNOWN 正是「三层外」的标记
  //    ⇒ 清单会把「被隐藏」误记成「没跑」。driver 默认是 EVOLUTION 视图（读端门）。
  const r = spawnSync(process.execPath, [DRIVER_PATH, '--tier=ALL'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // 场景量大，默认 1M 缓冲可能截断 stdout
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${r.stdout || ''}\n${r.stderr || ''}`;

  const statuses = new Map();
  let summary = null;
  for (const line of raw.split('\n')) {
    const s = SUMMARY_RE.exec(line.trim());
    if (s) {
      summary = {
        pass: Number(s[1]),
        fail: Number(s[2]),
        skipped: Number(s[3]),
        total: Number(s[4]),
      };
      continue;
    }
    const m = RESULT_RE.exec(line);
    if (!m) continue;
    const verdict = m[1] === '✓ PASS' ? 'PASS' : m[1] === '✗ FAIL' ? 'FAIL' : 'SKIP';
    const rest = m[2];
    // detail 用 ' — ' 与 name 分隔（driver.js recordResult 的模板）
    const sep = rest.indexOf(' — ');
    const name = sep === -1 ? rest.trim() : rest.slice(0, sep).trim();
    statuses.set(name, verdict);
  }

  if (statuses.size === 0) {
    fail(
      'driver.js 未产出任何可解析的结果行 —— 通常是 dsh 运行时缺失\n' +
        '（driver.js 靠 `npm root -g` 解析全局 dsh 的 node_modules）。\n' +
        'Tier A 环境请改用 --static-only；本机请先跑 eval/setup.sh。\n' +
        `--- driver 输出尾部 ---\n${raw.split('\n').slice(-15).join('\n')}`,
    );
  }
  return { statuses, summary, raw };
}

/**
 * dedicated 单元的取数方式必须与**各文件自己的 runner** 一致，否则清单里的单元
 * 与实际被执行的东西不是一回事。实测两个 runner 的取数：
 *   eval/run-mutator-eval.mjs:37        parsed.scenarios（19 条）
 *   eval/run-counterfactual-stress.mjs:40 parsed.fixtures（10 条）
 * 两者都是「对象包数组」而非顶层数组 —— 旧版 parseUnits 把整个文件当成 1 个单元，
 * 于是 2 个文件被记成 2 个单元（unitId 全是 "( unnamed )"），与真实执行粒度不符。
 */
function parseDedicatedUnits(absPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (e) {
    fail(`场景文件 JSON 解析失败：${absPath} — ${e.message}`);
  }
  if (Array.isArray(parsed)) return parsed.map((u) => ({ unit: u, unitKind: 'scenario' }));
  if (Array.isArray(parsed?.scenarios))
    return parsed.scenarios.map((u) => ({ unit: u, unitKind: 'scenario' }));
  if (Array.isArray(parsed?.fixtures))
    return parsed.fixtures.map((u) => ({ unit: u, unitKind: 'fixture' }));
  return [{ unit: parsed, unitKind: 'file' }];
}

/**
 * dedicated 文件 → 由哪个专属 runner 执行。
 * 从 runner 源码里反查（而不是写死映射表）：新增文件只要 README 登记 + runner 引用，
 * 这里自动跟上；反之只改 README 没写 runner，这里会如实报 null。
 */
function loadDedicatedRunners() {
  const map = new Map();
  const evalDir = join(REPO_ROOT, 'eval');
  let files = [];
  try {
    files = readdirSync(evalDir).filter((f) => f.endsWith('.mjs'));
  } catch {
    return map;
  }
  for (const f of files) {
    let src;
    try {
      src = readFileSync(join(evalDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/scenarios[\\/]dedicated[\\/]([A-Za-z0-9._-]+\.json)/g)) {
      map.set(m[1], `eval/${f}`);
    }
  }
  return map;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function build() {
  const allFiles = collectFiles(SCENARIOS_DIR);

  // 按 §2.2.1 定义：driver 只扫自身所在目录且不递归 ⇒ 根目录文件才是计量范围。
  // dedicated/ 单独记录，等待 §附录 C.2 第 9 项拍板后决定是否并入。
  const driverScopeFiles = allFiles.filter((f) => !f.rel.includes('/dedicated/'));
  const dedicatedFiles = allFiles.filter((f) => f.rel.includes('/dedicated/'));

  let units = [];
  const unitsPerFile = {};
  const unitIds = new Set();

  for (const f of driverScopeFiles) {
    const parsedUnits = parseUnits(f.abs);
    unitsPerFile[f.rel] = parsedUnits.length;
    for (const u of parsedUnits) {
      if (typeof u?.scenario !== 'string' || u.scenario === '') {
        fail(`单元缺少稳定的 scenario 名称，无法作为计量单位：${f.rel}`);
      }
      if (unitIds.has(u.scenario)) {
        fail(`unitId 重复：${u.scenario}（出现在 ${f.rel}）—— 违反验收项 2 的唯一性断言`);
      }
      unitIds.add(u.scenario);
      units.push({
        unitId: u.scenario,
        sourceFile: f.rel,
        // plugin 字段取自单元本身（实测 123/123 单元都有该字段），
        // 与 domain 的文件前缀归类分列，便于核对两者是否一致。
        plugin: u.plugin ?? null,
        domain: classifyDomain(f.rel),
        kind: classifyKind(f.rel),
        lastKnownStatus: 'UNKNOWN',
        // 设计 §2.2.2 要求 FAIL 时必填；但 §6.3 明确「Phase 0 不做归因，
        // 归因属 Sprint 17」。此处保留 null 并由 attribution 段声明归属，
        // 不用占位值冒充已归因。
        failCategory: null,
        // ⛔ 2026-10-04（A3 槽位 1）：负控制标记透传（**主路径**，rules 等域走这里）。
        //   负控制是「故意让判据变红」的测试夹具，**预期就是 FAIL** ——
        //   若算进 failCount 会污染 H1 下限与 A4 归因队列（scenario-tier.mjs 侧排除）。
        //   ⛔ 用**显式字段**，不靠 id 命名约定（无法审计、改个名就失效）。
        //   ⚠️ 落成显式 true/false（不能是 undefined）—— undefined 会被
        //   JSON.stringify 省掉，清单里就没这个键，判据侧读不到（实测踩过）。
        negativeControl: u.negativeControl === true,
        contentHash: canonicalHash(u, { prefix: true }),
        externalDeps: [...DEFAULT_EXTERNAL_DEPS],
        runtimeRequired: true,
      });
    }
  }

  // ── 三层标签：从 sidecar 挂到 unit 上（⛔ 绝不写进 scenario JSON）──────────
  // 写进场景文件的后果：`contentHash` 是对单元内容算的，加两个字段会让 123 个
  // hash 全部变化 ⇒ 「Frozen 集防篡改基线」这条不变量自毁。判据必须与被评对象
  // 不同池（与 R2 技能金标同构：判据在 eval/skills/，被改的只有 SKILL.md）。
  // --emit-tiering：先补齐 sidecar（幂等：已有条目原样保留，只补缺失的），
  // 这样「首次建库」与「新增场景后补登记」是同一条命令。
  if (EMIT_TIERING) {
    const existing = existsSync(EMIT_TIERING) ? readTierMap(EMIT_TIERING) : { ok: false, entries: new Map() };
    const unitsOut = {};
    for (const u of units) {
      const m = existing.entries.get(u.unitId);
      unitsOut[u.unitId] = m
        ? { visibility: m.visibility, labelAuthority: m.labelAuthority }
        : { visibility: DEFAULT_TIER, labelAuthority: DEFAULT_LABEL_AUTHORITY };
    }
    const added = units.filter((u) => !existing.entries.has(u.unitId)).length;
    writeFileSync(
      EMIT_TIERING,
      `${JSON.stringify(
        {
          tieringVersion: TIERING_VERSION,
          note:
            '三层标签 sidecar（unitId → visibility / labelAuthority）。' +
            '⛔ 标签不写进 .scenario.json —— 那会推翻全部 contentHash，与 Frozen 防篡改基线冲突。' +
            '每个 unitId 必须显式登记；缺映射即判据失败，不给默认值兜底。' +
            `合法值：visibility ∈ ${TIER_VALUES.join('/')}；labelAuthority ∈ ${LABEL_AUTHORITY_VALUES.join('/')}。`,
          units: unitsOut,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(
      `[build-scenario-inventory] 已写入三层 sidecar ${EMIT_TIERING}` +
        `（${Object.keys(unitsOut).length} 条，其中新增 ${added} 条）`,
    );
  }

  const tiering = readTierMap(TIERING_PATH);
  if (!tiering.ok) {
    fail(
      `三层 sidecar 读不到或不合法：${TIERING_PATH}\n  ${tiering.errors.join('\n  ')}\n` +
        `修法：跑 node bin/build-scenario-inventory.mjs --emit-tiering 生成一份。`,
    );
  }
  const assigned = assignTiers(units, tiering.entries);
  if (!assigned.ok) {
    fail(
      `三层映射不完整（${assigned.errors.length} 处）：\n  ${assigned.errors.slice(0, 20).join('\n  ')}` +
        `${assigned.errors.length > 20 ? `\n  …还有 ${assigned.errors.length - 20} 条` : ''}`,
    );
  }
  units = assigned.units;

  const dedicatedUnits = [];
  const runnerMap = loadDedicatedRunners();
  for (const f of dedicatedFiles) {
    const stem = basename(f.rel, '.scenario.json');
    for (const { unit: u, unitKind } of parseDedicatedUnits(f.abs)) {
      // unitId 必须全局唯一且稳定：不带前缀时 counterfactual 的 fix-N 与
      // mutator 的 scenario 名虽不冲突，但无法一眼看出归属哪个文件 / runner，
      // 分层与导出时会丢上下文。故用 "<文件 stem>/<单元名>"。
      const name = typeof u?.scenario === 'string' ? u.scenario : u?.id;
      if (typeof name !== 'string' || name === '') {
        fail(`dedicated 单元缺少稳定的 scenario/id 名称，无法唯一标识：${f.rel}`);
      }
      const unitId = `${stem}/${name}`;
      if (unitIds.has(unitId)) {
        fail(`unitId 重复：${unitId}（出现在 ${f.rel}）—— 违反验收项 2 的唯一性断言`);
      }
      unitIds.add(unitId);
      dedicatedUnits.push({
        unitId,
        sourceFile: f.rel,
        plugin: u.plugin ?? null,
        domain: classifyDomain(f.rel),
        kind: 'dedicated',
        unitKind,
        executedBy: runnerMap.get(basename(f.rel)) ?? null,
        lastKnownStatus: 'UNKNOWN',
        failCategory: null,
        // ⛔ 2026-10-04（A3 槽位 1）：负控制标记透传（**dedicated 路径**）。
        //   ⚠️ 负控制单元都在普通路径（本文件上方 units.push）—— 这条是同一口径的
        //   重复声明，防将来有 dedicated 负控制时漏掉。口径见 scenario-tier.mjs。
        negativeControl: u.negativeControl === true,
        contentHash: canonicalHash(u, { prefix: true }),
        externalDeps: [...DEFAULT_EXTERNAL_DEPS],
        runtimeRequired: true,
      });
    }
  }

  const measured = { total: null, pass: null, fail: null, skip: null };
  let driverSummary = null;

  // --check 也不跑 driver：它是**静态门禁**（Tier A 可跑），
  // fail 数从上一版入仓清单读 —— 那正是 H5 要比对的基线来源。
  const NO_DRIVER = STATIC_ONLY || CHECK_ONLY;

  if (NO_DRIVER) {
    console.warn(
      `[build-scenario-inventory] ⚠️ ${CHECK_ONLY ? '--check 静态门禁' : '--static-only 降级'}模式：未执行 driver.js，\n` +
        '  lastKnownStatus 全部为 UNKNOWN，reconciliation.measuredTotal 留空。\n' +
        '  这是设计 §2.2.4 允许的降级：宁可交付不完整的 Inventory 并声明边界，\n' +
        '  也不用推算值冒充实测值。',
    );
  } else {
    const { statuses, summary } = runDriver();
    driverSummary = summary;
    let unresolved = 0;
    // ★ 只对 driver 计量范围内的单元查状态。dedicated 单元本就不被 driver 执行，
    //   它们保持 UNKNOWN 是**预期行为**，不是「找不到结果」的异常。
    for (const u of units) {
      const s = statuses.get(u.unitId);
      if (s) u.lastKnownStatus = s;
      else unresolved++;
    }
    measured.total = units.length;
    measured.pass = units.filter((u) => u.lastKnownStatus === 'PASS').length;
    measured.fail = units.filter((u) => u.lastKnownStatus === 'FAIL').length;
    measured.skip = units.filter((u) => u.lastKnownStatus === 'SKIP').length;

    // driver 的汇总行是权威计数，与脚本自己的解析必须对得上。
    if (summary && summary.total !== units.length) {
      fail(
        `单元数对不上：脚本扫到 ${units.length} 个，driver 汇总行报 ${summary.total} 个。\n` +
          '说明 driver 的加载范围与本脚本的扫描范围不一致 —— 先查清再出清单。',
      );
    }
    if (unresolved > 0) {
      console.warn(
        `[build-scenario-inventory] ⚠️ 有 ${unresolved} 个单元在 driver 输出里找不到对应结果行，lastKnownStatus 保持 UNKNOWN。`,
      );
    }
  }

  // ── 三层判据（Phase 0.1：让隔离从文档变成代码里生效的约束）────────────────
  // H5「只增不减」要比对上一版入仓清单里的 Frozen 名单；fail 数也取那里的实测值
  // （静态门禁不跑 driver，但 H1/H3 的算术需要 fail 数，取上一版是唯一可信来源）。
  const prev = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : null;
  const previousFrozenIds = prev?.tierBaseline?.frozenUnitIds ?? null;
  const failCountForCriteria =
    measured.fail ?? prev?.summary?.failCount ?? prev?.reconciliation?.measuredFail ?? null;

  const criteria = checkTierAssignment({
    units,
    previousFrozenIds,
    failCount: failCountForCriteria,
    // 静态门禁不跑 driver ⇒ 单元状态是 UNKNOWN ⇒ H1/H3 的输入不存在。
    // 不声明这一点，判据会拿上一版的 fail 数去配这一版的 0 个 FAIL ⇒ 稳定假阳性。
    statusKnown: !NO_DRIVER,
  });
  const tierSummary = summarizeTiers(units);

  // ── 对账（设计 §2.2.2：reconciliation 是本交付物的诚实性核心）────────────
  const CLAIMED = { total: 104, pass: 92, fail: 12 };
  const CLAIM_SOURCE = 'Sprint12-设计稿 .md:159 / AGINT‐智进.md:9 / 路线图.md:188';

  const deltaExplanations = [];
  let delta = null;
  if (measured.total !== null) {
    delta = measured.total - CLAIMED.total;
    if (delta !== 0) {
      deltaExplanations.push(
        `实测 ${measured.total} vs 声称 ${CLAIMED.total}，差 ${delta > 0 ? '+' : ''}${delta}。`,
        '原因（git 历史实测，非推算）：',
        '  1. 「92/104」出自 v0.6.5 / Sprint 11 时点（2026-08-28）。实测该时点仓库确为 104 个单元 —— 声称当时是准确的。',
        '  2. 2026-08-29 Sprint 12 新增 agint-event-bus-s12-02..06 + s12-05-policy 共 6 个文件，单元数 104 → 110。',
        '  3. 2026-09-03 新增 agint-self-model（10 单元）与 agint-quality-eval-deploy-budget（5 单元），110 → 125。',
        '  4. 2026-09-09 将 agint-diagnosis-counterfactual / agint-mutator 两个文件从根目录移入 dedicated/（单元数不变）。',
        '     因 driver.js 只扫自身目录且不递归，这两个单元自此不在 driver 计量范围内 ⇒ 根目录口径 125 - 2 = 123。',
        '⇒ 结论：104 是历史快照，不是错误；当前 driver 口径下的权威值是 123。',
      );
      const passDelta = measured.pass - CLAIMED.pass;
      const failDelta = measured.fail - CLAIMED.fail;
      deltaExplanations.push(
        `PASS：实测 ${measured.pass} vs 声称 ${CLAIMED.pass}（${passDelta > 0 ? '+' : ''}${passDelta}）；`,
        `FAIL：实测 ${measured.fail} vs 声称 ${CLAIMED.fail}（${failDelta > 0 ? '+' : ''}${failDelta}）。`,
        // ⚠️ 这句话曾经是「说明部分 fail 已被修复」—— 与同一份 JSON 里
        // failSetReconciliation 的严谨算术自相矛盾（旧文案没跟着 10-02 的差集对账更新）。
        // 「部分已修复」是拿不出对象的话术：它无法回答 H1 配额的对象是谁。
        // 权威表述见 failSetReconciliation.arithmetic：F = 8 + R ⇒ 至少 8 个旧 fail 已修复，
        // 另有 R ∈ [0,4] 个旧单元回归，R 因旧名单未留存无法确定。净变化 −7 = −8 + 1（新增 s12-05）。
        '⇒ 12 → 6 的逐项溯源见同文件 failSetReconciliation 段（不等于归因）。' +
        '⚠️ 2026-10-03 实测为 6（不是 5）：多出的一个是新确认的回归 stats-reports-counts-and-limits。',
        '⚠️ 本脚本只负责报数与留证，不做 fail 归因（设计 §6.3：归因属 Sprint 17）。',
      );
    }
  }

  const inventory = {
    inventoryVersion: INVENTORY_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: 'bin/build-scenario-inventory.mjs',
    driverVersion: gitBlobHash(DRIVER_PATH),
    unitDefinition: UNIT_DEFINITION,
    unitScope: UNIT_SCOPE,
    // 计量范围声明：明确写出什么是范围内、什么是范围外，避免口径二次失真。
    scope: {
      included:
        'eval/scenarios/*.scenario.json（driver.js 扫描范围，不递归子目录）⇒ 权威总数 123',
      excluded:
        'eval/scenarios/dedicated/*.scenario.json —— 不被 driver 扫到；' +
        '由专属 runner 执行，单独记录在 dedicatedUnits 段，不进任何分层与分母',
      dedicatedDecision:
        '设计 §附录 C.2 第 9 项已于 Sprint 18 拍板：**维持独立 runner**，不并入 driver。' +
        '决定性理由不是成本而是口径纯净度 —— 这 29 个单元在 driver 口径内的状态是 UNKNOWN，' +
        '混入分母会让通过率变成不可计算的量（118/123 是有效指标，118/152 不是）。' +
        '附带理由：两个 runner 的执行模型与 driver 不同（单文件零依赖、直接调真 Service），' +
        '合并意味着改 driver 的执行模型，风险落在当前唯一能跑通的全量门禁上。',
    },

    summary: {
      totalUnits: units.length,
      passCount: measured.pass,
      failCount: measured.fail,
      skipCount: measured.skip,
      fileCount: driverScopeFiles.length,
      unitsPerFile,
      domainCounts: countBy(units, 'domain'),
      kindCounts: countBy(units, 'kind'),
      // ── 三层计数（Phase 0.1）：加总必须等于 totalUnits ──
      tierCounts: tierSummary.tierCounts,
      tierSum: tierSummary.tierSum,
      labelAuthorityCounts: criteria.observed.labelAuthorityCounts,
      // 配额 §3.2 要求「产出里回写实际占比」：quality 单域占 46.3%，
      // 不回写就无法判断抽样有没有被它主导。
      qualityRatio: criteria.observed.qualityRatio,
    },

    units,

    // ── 三层基线（Frozen 防篡改的落账源）───────────────────────────────────
    tierBaseline: {
      tieringFile: TIERING_PATH === join(REPO_ROOT, 'eval', 'tiers', 'agint-tiering.json')
        ? 'eval/tiers/agint-tiering.json'
        : TIERING_PATH,
      tieringVersion: TIERING_VERSION,
      note:
        'Frozen 集的聚合 hash 与名单。入 evolution-memory 的 `benchmark_frozen_set` 表后，' +
        '即可回答「这一版冻结集有没有被偷偷改过」：增删任一 Frozen 单元、或改任一 Frozen ' +
        '单元的 contentHash，聚合 hash 都会变。⛔ hash 只对 {unitId, contentHash} 计算，' +
        '不含 labelAuthority —— HELDOUT→GOLD 是合法降级，算进来会变成假阳性。',
      frozenUnitIds: units
        .filter((u) => u.visibility === 'FROZEN')
        .map((u) => u.unitId)
        .sort(),
      frozenCount: criteria.observed.frozenCount,
      frozenAggregateHash: criteria.observed.frozenAggregateHash,
      failCount: criteria.observed.failCount,
      h1EvolutionMinFail: criteria.observed.h1EvolutionMinFail,
      h3FrozenFailProbeCap: criteria.observed.h3FrozenFailProbeCap,
      criteriaOk: criteria.ok,
      criteriaErrors: criteria.errors,
      // ⛔ 静态门禁下 H1/H3 会被跳过 —— 写进清单，让「这次没查」这件事可被人看见。
      criteriaSkipped: criteria.observed.skipped,
      statusKnown: criteria.observed.statusKnown,
    },

    dedicatedUnits: {
      count: dedicatedUnits.length,
      fileCount: dedicatedFiles.length,
      note:
        '不被 driver.js 扫描（driver 只扫 __dirname 且不递归），由专属 runner 独立执行。' +
        '单元粒度与各 runner 的取数一致（mutator: parsed.scenarios；counterfactual: parsed.fixtures），' +
        '不是「一个文件 = 一个单元」—— 旧版按文件计数会把它记成 2 个单元，与实际执行粒度不符。',
      outOfScope: '按 Sprint 18 拍板维持独立 runner，不计入任何分层、配额与通过率分母。',
      units: dedicatedUnits,
    },

    attribution: {
      owner: 'Sprint 17（12 存量 fail 归因 ≥80%）',
      phase0Role: '只提供清单基础设施，不做归因（设计 §6.3）',
      failCategoryValues: 'null = 未归因。禁止用占位值填充。',
      pendingUnits: units.filter((u) => u.lastKnownStatus === 'FAIL').map((u) => u.unitId),
    },

    reconciliation: {
      claimedTotal: CLAIMED.total,
      claimedPass: CLAIMED.pass,
      claimedFail: CLAIMED.fail,
      claimSource: CLAIM_SOURCE,
      measuredTotal: measured.total,
      measuredPass: measured.pass,
      measuredFail: measured.fail,
      delta: delta,
      deltaExplanation: deltaExplanations.join('\n'),
      driverSummaryLine: driverSummary
        ? `${driverSummary.pass} passed, ${driverSummary.fail} failed, ${driverSummary.skipped} skipped (of ${driverSummary.total})`
        : null,
      // ── FAIL 差集对账（12 → 5 的 −7 逐项溯源，2026-10-02 实测）─────────────
      // 为什么单独一段：+19 的总数差有完整 git 溯源，但「12 个 fail 只剩 5 个」
      // 若只写「部分已修复」就与 +19 的严谨度不匹配，而它直接决定 Phase 1
      // 交付物 4（H1 配额）的对象。这里给出能确定的部分与**不能确定的边界**。
      failSetReconciliation: FAIL_RECON,
      // 降级模式：显式声明未完成实测对账（设计 §2.2.4）
      measuredBy: STATIC_ONLY ? 'STATIC_ONLY（未执行 driver.js）' : 'driver.js 全量回归实测',
      complete: !STATIC_ONLY,
    },
  };

  // ── --check：只校验不写盘（⛔ 必须早于写盘，否则是自证循环）────────────────
  if (CHECK_ONLY) {
    const errors = [...criteria.errors];

    // (1) 三层计数加总必须等于总数（有单元层名非法时 tierSum < total）
    if (tierSummary.tierSum !== units.length) {
      errors.push(
        `三层计数加总 ${tierSummary.tierSum} ≠ 单元总数 ${units.length}` +
          `（未知层名：${tierSummary.unknownVisibility.slice(0, 5).join(', ') || '（空）'}）`,
      );
    }
    // (2) 每个单元都必须带两个字段
    const missingFields = units.filter(
      (u) => !TIER_VALUES.includes(u.visibility) || !LABEL_AUTHORITY_VALUES.includes(u.labelAuthority),
    );
    if (missingFields.length > 0) {
      errors.push(`${missingFields.length} 个单元缺少合法的 visibility / labelAuthority 字段`);
    }
    // (3) quality 占比必须回写且与重算值一致（配额 §3.2）
    const q = criteria.observed.qualityRatio;
    if (!q || typeof q.ratio !== 'number' || !Number.isFinite(q.ratio)) {
      errors.push('quality 占比未回写 —— 配额 §3.2 要求产出里给出实际占比');
    }
    if (prev) {
      if (typeof prev.summary?.qualityRatio?.ratio === 'number') {
        if (Math.abs(prev.summary.qualityRatio.ratio - q.ratio) > 1e-9) {
          errors.push(
            `quality 占比漂移：入仓 ${prev.summary.qualityRatio.ratio} vs 重算 ${q.ratio}` +
              ` ⇒ 域归类或单元集变了，必须重新生成清单`,
          );
        }
      }
      // (4) 单元级漂移：unitId / contentHash / 两个标签
      const prevUnits = new Map((prev.units ?? []).map((u) => [u.unitId, u]));
      const curUnits = new Map(units.map((u) => [u.unitId, u]));
      const added = [...curUnits.keys()].filter((id) => !prevUnits.has(id));
      const removed = [...prevUnits.keys()].filter((id) => !curUnits.has(id));
      const changed = [];
      for (const [id, cu] of curUnits) {
        const pu = prevUnits.get(id);
        if (!pu) continue;
        if (pu.contentHash !== cu.contentHash) changed.push(`${id}:contentHash`);
        else if (pu.visibility !== cu.visibility) changed.push(`${id}:visibility ${pu.visibility}→${cu.visibility}`);
        else if (pu.labelAuthority !== cu.labelAuthority) changed.push(`${id}:labelAuthority`);
      }
      if (added.length) errors.push(`清单新增单元 ${added.length} 个（${added.slice(0, 5).join(', ')}）⇒ sidecar 需补登记并重生成`);
      if (removed.length) errors.push(`清单少了单元 ${removed.length} 个（${removed.slice(0, 5).join(', ')}）⇒ 场景被删，H5 需人工确认`);
      if (changed.length) errors.push(`单元级漂移 ${changed.length} 处（${changed.slice(0, 8).join(', ')}）⇒ 入仓清单与实测不一致`);
    }

    if (errors.length > 0) {
      console.error(`[build-scenario-inventory] ❌ --check 失败（${errors.length} 处）：`);
      for (const e of errors) console.error(`  - ${e}`);
      console.error('\n⇒ 修法：改 sidecar / 场景后重跑 `node bin/build-scenario-inventory.mjs` 重新生成。');
      process.exit(1);
    }
    const t = tierSummary.tierCounts;
    if (criteria.observed.skipped.length > 0) {
      console.warn(
        `[build-scenario-inventory] ⚠️ 本次为静态门禁，以下判据因缺实测状态而跳过：` +
          `${criteria.observed.skipped.join(' / ')}。要全量校验请跑不带 --check 的完整生成。`,
      );
    }
    console.log(
      `[build-scenario-inventory] ✅ --check 通过：${units.length} 单元 · ` +
        `EVOLUTION ${t.EVOLUTION} / VALIDATION ${t.VALIDATION} / FROZEN ${t.FROZEN}` +
        ` · Frozen hash ${criteria.observed.frozenAggregateHash}` +
        ` · quality 占比 ${(q.ratio * 100).toFixed(1)}%（${q.count}/${q.total}）`,
    );
    process.exit(0);
  }

  writeFileSync(OUT_PATH, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');

  // ── 输出与退出码 ──────────────────────────────────────────────────────────
  console.log(`[build-scenario-inventory] 已写入 ${OUT_PATH}`);
  console.log(
    `  单元总数 ${inventory.summary.totalUnits}（${inventory.summary.fileCount} 个文件）` +
      (measured.total !== null
        ? ` · PASS ${measured.pass} / FAIL ${measured.fail} / SKIP ${measured.skip}`
        : ' · 状态未实测（--static-only）'),
  );
  console.log(`  dedicated（范围外，独立 runner）: ${dedicatedUnits.length}`);
  console.log(`  driver blob: ${inventory.driverVersion}`);
  {
    const t = inventory.summary.tierCounts;
    console.log(
      `  三层：EVOLUTION ${t.EVOLUTION} / VALIDATION ${t.VALIDATION} / FROZEN ${t.FROZEN}` +
        `（加总 ${inventory.summary.tierSum} / 总数 ${inventory.summary.totalUnits}）`,
    );
    console.log(`  Frozen 聚合 hash: ${inventory.tierBaseline.frozenAggregateHash}`);
    console.log(
      `  quality 占比 ${(inventory.summary.qualityRatio.ratio * 100).toFixed(1)}%` +
        `（${inventory.summary.qualityRatio.count}/${inventory.summary.qualityRatio.total}）`,
    );
    if (!criteria.ok) {
      console.warn(`  ⚠️ 三层判据未通过（${criteria.errors.length} 处）—— 清单已写出但不应入仓：`);
      for (const e of criteria.errors) console.warn(`    - ${e}`);
    }
  }

  if (delta !== null && delta !== 0) {
    console.warn(`\n[build-scenario-inventory] ⚠️ 对账不一致：delta = ${delta}`);
    console.warn(inventory.reconciliation.deltaExplanation);
    console.warn('\n⇒ 按设计 §2.2.4，退出码 2：需人工确认后才可继续后续分层分配。');
    process.exit(2);
  }
  if (delta === null) {
    console.warn('\n[build-scenario-inventory] ⚠️ 降级模式：未完成实测对账（reconciliation.complete = false）。');
  }
  process.exit(0);
}

function countBy(list, key) {
  const out = {};
  for (const item of list) out[item[key]] = (out[item[key]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

build();
