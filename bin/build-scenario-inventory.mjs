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
 *
 * 退出码（设计 §2.2.4）：
 *   0 = 生成成功且对账一致（或降级模式显式声明未完成对账）
 *   2 = 生成成功但对账不一致（delta ≠ 0）⇒ 打印差异，需人工确认后才可继续
 *   1 = 生成失败
 *
 * 零依赖：只用 node:fs / node:path / node:crypto / node:child_process。
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { canonicalHash } from './lib/canonical-json.mjs';

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
    ],
    currentlyFailingThatAreNew: ['s12-05-policy-policy-deployed-rolledback-shadow'],
    newFailNote: '该单元 2026-08-29 才随 Sprint 12 的 event-bus 系列新增，不可能是旧 12 fail 之一。',
  },

  arithmetic:
    '设 F = 旧 12 个 fail 中现已转 PASS 的数量，R = 旧时点存在但当时 PASS、如今回归为 FAIL 的数量。' +
    '当前失败的旧单元数 4 = (12 − F) + R ⇒ F = 8 + R。' +
    '⇒ **至少 8 个旧 fail 已被修复**；另有 R ∈ [0,4] 个旧单元发生回归（无法确定，因名单未留存）。' +
    '净变化 −7 = −8（修复）+ 1（新增 s12-05），与 12 → 5 自洽。',

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
    untouchedAndNowPass: 95,
    untouchedNote:
      '其余 97 个旧单元内容从未改动，其中 95 个现为 PASS ⇒ 若旧 fail 在其中，' +
      '是被 plugin 代码修复（不是靠改测试），属于真正的修复。',
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
const outArg = argv.find((a) => a.startsWith('--out='));
const OUT_PATH = outArg
  ? resolve(process.cwd(), outArg.slice('--out='.length))
  : join(SCENARIOS_DIR, 'inventory.json');

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
  const r = spawnSync(process.execPath, [DRIVER_PATH], {
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

  const units = [];
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
        contentHash: canonicalHash(u, { prefix: true }),
        externalDeps: [...DEFAULT_EXTERNAL_DEPS],
        runtimeRequired: true,
      });
    }
  }

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
        contentHash: canonicalHash(u, { prefix: true }),
        externalDeps: [...DEFAULT_EXTERNAL_DEPS],
        runtimeRequired: true,
      });
    }
  }

  const measured = { total: null, pass: null, fail: null, skip: null };
  let driverSummary = null;

  if (STATIC_ONLY) {
    console.warn(
      '[build-scenario-inventory] ⚠️ --static-only 降级模式：未执行 driver.js，\n' +
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
        '⇒ 12 → 5 的逐项溯源见同文件 failSetReconciliation 段（不等于归因）。',
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
    },

    units,

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
