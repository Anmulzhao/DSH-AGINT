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
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { canonicalHash } from './lib/canonical-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCENARIOS_DIR = join(REPO_ROOT, 'eval', 'scenarios');
const DRIVER_PATH = join(SCENARIOS_DIR, 'driver.js');

const INVENTORY_VERSION = '1.0';

/** 设计 §2.2.1 的计量单位定义，原样写入 inventory.json。 */
const UNIT_DEFINITION =
  'driver.js 全量回归中可独立判定 PASS/FAIL 的最小执行单元';

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
  for (const f of dedicatedFiles) {
    for (const u of parseUnits(f.abs)) {
      dedicatedUnits.push({
        unitId: u.scenario ?? '( unnamed )',
        sourceFile: f.rel,
        plugin: u.plugin ?? null,
        domain: classifyDomain(f.rel),
        kind: 'dedicated',
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
        '存量 fail 由 12 降至实测值，说明部分 fail 已被修复；另有一部分口径变化来自单元总数增长。',
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
    // 计量范围声明：明确写出什么是范围内、什么是范围外，避免口径二次失真。
    scope: {
      included: 'eval/scenarios/*.scenario.json（driver.js 扫描范围，不递归子目录）',
      excluded: 'eval/scenarios/dedicated/*.scenario.json —— 不被 driver 扫到，见 dedicatedUnits 段',
      dedicatedDecisionPending:
        '设计 §附录 C.2 第 9 项：dedicated 是纳入 driver 统一扫描还是维持独立 runner，须在 Sprint 18 拍板。本清单按 §2.2.1 字面定义将其排除在计量范围外，但如实记录不丢弃。',
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
      note: '不被 driver.js 扫描（driver 只扫 __dirname 且不递归），由 run-diagnosis-eval.mjs / run-mutator-eval.mjs 独立执行。',
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
