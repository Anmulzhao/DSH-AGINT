#!/usr/bin/env node
/**
 * bin/validate-contract-schema.mjs —— Evolution Contract v1.0 schema 校验器
 *
 * ★ 为什么手写而不引 ajv：
 *   设计 §附录 C 修订说明第 3 条 / §4.2.1 —— `eval/scenarios/README.md:297`
 *   定下零依赖纪律「避免引入 yaml npm 依赖（AGINT 仓不引入第三方运行时依赖）」。
 *   Contract 由 driver **运行时**读写 ⇒ 校验器也必须是零依赖的。
 *   只实现需要的 JSON Schema 子集（type / required / enum / items /
 *   additionalProperties / minimum / maximum / minLength / minItems / format）。
 *
 * ★ 光有 JSON Schema 不够：设计里有三条规则 Schema 表达不了，必须写代码：
 *   R1 benchmarkSet 禁止 FROZEN —— 枚举里排除只能让校验失败，说不出
 *      「为什么」（Frozen 只用于发版裁决，反复观察会失去冻结性质，§4.2.1 修正表）
 *   R2 NO_EVIDENCE 纪律 —— outcome 写了数值却没有取数来源 = 用 0 冒充「无改进」，
 *      这是教训 §3.1 的同型错误（读空表得出错误结论）
 *   R3 hypothesisLock 防篡改 —— 按 §4.2.4 的公式重算并比对
 *
 * 用法：
 *   node bin/validate-contract-schema.mjs <contract.json>    校验文件
 *   node bin/validate-contract-schema.mjs --fixtures         跑内置用例自测（≥12 case）
 *   node bin/validate-contract-schema.mjs <file> --json      CI 消费
 *
 * 退出码：0 = 通过 / 1 = 校验失败 / 2 = 脚本自身出错（schema 读不到等）
 *
 * 零依赖：只用 node:fs / node:path / node:url + 本仓 bin/lib/canonical-json.mjs。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from './lib/canonical-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMA_PATH = join(REPO_ROOT, 'docs', 'specs', 'evolution-contract-v1.schema.json');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const FIXTURES = argv.includes('--fixtures');
const lockArgRaw = argv.find((a) => a.startsWith('--lock='));
const lockArg = lockArgRaw ? lockArgRaw.slice('--lock='.length) : null;
const target = argv.find((a) => !a.startsWith('--'));

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// ── JSON Schema 子集实现 ────────────────────────────────────────────────────
/** 以 '_' 开头的键是注解（设计 §4.2.1 示例里的 _comment），不参与校验。 */
const isAnnotation = (k) => k.startsWith('_');

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // string | number | boolean | object | undefined
}

function typeMatches(v, expected) {
  const actual = typeOf(v);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function typeName(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  // type
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => typeMatches(value, t))) {
      errors.push({
        path,
        rule: 'TYPE',
        message: `类型应为 ${allowed.join(' | ')}，实际 ${typeName(value)}`,
      });
      return; // 类型都不对，后续约束无意义
    }
  }

  // enum
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push({
      path,
      rule: 'ENUM',
      message: `值 "${String(value)}" 不在允许集合 [${schema.enum.join(', ')}]`,
    });
  }

  // 字符串
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, rule: 'MIN_LENGTH', message: `长度 < ${schema.minLength}` });
    }
    if (schema.format === 'date-time' && value !== '' && !DATE_TIME_RE.test(value)) {
      errors.push({ path, rule: 'FORMAT', message: `应为 ISO-8601 时间，实际 "${value}"` });
    }
  }

  // 数字
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, rule: 'MINIMUM', message: `< ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, rule: 'MAXIMUM', message: `> ${schema.maximum}` });
    }
  }

  // 数组
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, rule: 'MIN_ITEMS', message: `元素数 < ${schema.minItems}` });
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors));
    }
  }

  // 对象
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required) {
      for (const k of schema.required) {
        if (!(k in value)) {
          errors.push({ path: path ? `${path}.${k}` : k, rule: 'REQUIRED', message: '必填字段缺失' });
        }
      }
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (isAnnotation(k)) continue;
      if (props[k]) {
        validateNode(v, props[k], path ? `${path}.${k}` : k, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: path ? `${path}.${k}` : k,
          rule: 'ADDITIONAL_PROPERTIES',
          message: `未在 schema 中声明的字段（注解键需以 _ 开头）`,
        });
      }
    }
  }
}

/**
 * 按设计 §4.2.4 的公式计算 hypothesisLock。
 *
 * ⚠️ 锁定值**不在 Contract 本体里** —— 设计 §4.2.6 把它的归宿定为独立的
 * `contract_locks` 表（key: contractId, value: {hypothesisLock, lockedAt, lockEventId}）。
 * 所以校验时锁定值由**外部**传入（--lock 或函数参数），schema 里不声明这个字段。
 */
export function computeHypothesisLock(contract) {
  return canonicalHash({
    contractId: contract?.identity?.contractId,
    hypothesis: contract?.hypothesis,
    createdAt: contract?.identity?.createdAt,
  });
}

// ── 设计专属语义规则（JSON Schema 表达不了的部分）────────────────────────────
function semanticRules(contract, errors, warnings, opts = {}) {
  // R1：benchmarkSet 禁止 FROZEN（给出「为什么」，而不是干巴巴的枚举失败）
  if (contract?.evaluationPlan?.benchmarkSet === 'FROZEN') {
    errors.push({
      path: 'evaluationPlan.benchmarkSet',
      rule: 'BENCHMARK_SET_FROZEN',
      message:
        'benchmarkSet 不得为 FROZEN —— Frozen Set 只用于发版裁决，' +
        '用于单期进化筛选会被反复观察而失去「冻结」性质（设计 §4.2.1 修正表）',
    });
  }

  // R2：NO_EVIDENCE 纪律 —— 有数值却没取数来源 = 用 0 冒充「无改进」
  const outcome = contract?.outcome;
  if (outcome) {
    const primary = outcome.dataSources?.primary;
    const hasNumbers = (outcome.actualDeltas || []).some(
      (d) => typeof d?.delta === 'number' && d.delta !== null,
    );
    const noSource =
      !outcome.dataSources ||
      !primary ||
      primary === '' ||
      primary === 'NO_EVIDENCE' ||
      primary === 'EVIDENCE_CONFLICT';
    if (hasNumbers && noSource) {
      errors.push({
        path: 'outcome.actualDeltas',
        rule: 'NO_EVIDENCE_VIOLATION',
        message:
          `actualDeltas 含数值，但 dataSources.primary = "${primary ?? '(缺失)'}" —— ` +
          '四源未命中时不得写数值（0 会被读成「无改进」，教训 §3.1 同型错误）',
      });
    }
    if (outcome.dataSources && !outcome.dataSources.queriedDomains) {
      warnings.push({
        path: 'outcome.dataSources.queriedDomains',
        rule: 'QUERIED_DOMAINS_MISSING',
        message: '未记录实际查询的存储域，outcome 无法自证取数口径（设计 §4.2.5 强制要求）',
      });
    }
  }

  // R3：hypothesisLock 防篡改（§4.2.4）。锁定值由外部传入（见 computeHypothesisLock 注释）。
  const expectedLock = opts.expectedHypothesisLock;
  if (typeof expectedLock === 'string' && expectedLock !== '') {
    const computed = computeHypothesisLock(contract);
    const got = expectedLock.replace(/^sha256:/, '');
    if (got !== computed) {
      errors.push({
        path: 'audit.hypothesisLock',
        rule: 'HYPOTHESIS_LOCK_MISMATCH',
        message:
          `hypothesis 锁定值与 §4.2.4 公式重算结果不一致 —— 假设可能在看到结果后被改写。` +
          `期望 ${computed.slice(0, 16)}… 实际 ${got.slice(0, 16)}…`,
      });
    }
  }

  // R4：predictedDelta 为 null 时应显式标注 NOT_PREDICTED（Phase 0 允许 null，但不许无声）
  if (contract?.hypothesis && contract.hypothesis.predictedDelta === null) {
    if (contract.hypothesis.predictedDeltaNote !== 'NOT_PREDICTED') {
      warnings.push({
        path: 'hypothesis.predictedDeltaNote',
        rule: 'PREDICTED_DELTA_UNMARKED',
        message: 'predictedDelta 为 null 时应标注 NOT_PREDICTED（设计 §4.2.3：不得用占位值或推算值填充）',
      });
    }
  }
}

/**
 * 校验一份 Contract。
 * @returns {{valid: boolean, errors: object[], warnings: object[]}}
 */
export function validateContract(contract, schema, opts = {}) {
  const errors = [];
  const warnings = [];
  validateNode(contract, schema, '', errors);
  semanticRules(contract, errors, warnings, opts);
  return { valid: errors.length === 0, errors, warnings };
}

export function loadSchema(p = SCHEMA_PATH) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ── 内置用例（--fixtures）───────────────────────────────────────────────────
function baseContract(overrides = {}) {
  const base = {
    contractVersion: '1.0',
    identity: {
      contractId: 'EVO-2026-001',
      parentVersion: null,
      candidateVersion: null,
      createdAt: '2026-10-02T04:15:00Z',
      createdBy: 'evolution-driver',
      _comment: '注解键不参与校验',
    },
    hypothesis: {
      summary: '改进 memory 检索',
      targetMetric: 'SUCCESS_RATE',
      predictedDelta: null,
      predictedDeltaNote: 'NOT_PREDICTED',
      confidenceLevel: null,
      reasoning: '检索排序调整应提升命中率',
      changedComponents: [
        { pluginName: 'agint-memory', filesChanged: ['lib/retrieval.js'], changeType: 'MODIFY' },
      ],
    },
    evaluationPlan: {
      benchmarkSet: 'EVOLUTION',
      sampleSize: 3,
      statisticalTest: 'T_TEST',
      significanceLevel: 0.05,
      effectSizeThreshold: 0.3,
    },
    budget: { maxTokens: 0, maxDuration: 0, sandboxRequired: true, deployBudgetCheck: true },
    audit: { contractHash: '', parentContractHash: '', eventBusIds: [], preimagePath: '', status: 'DRAFT' },
  };
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') {
      out[k] = deepMerge(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** @returns {Array<{name, contract, expectValid, expectRule?}>} */
function fixtures() {
  return [
    {
      name: '1. 最小合法骨架（DRAFT 阶段）应通过',
      contract: baseContract(),
      expectValid: true,
    },
    {
      name: '2. 缺 identity ⇒ REQUIRED',
      contract: (() => {
        const c = baseContract();
        delete c.identity;
        return c;
      })(),
      expectValid: false,
      expectRule: 'REQUIRED',
    },
    {
      name: '3. contractId 为空串 ⇒ MIN_LENGTH',
      contract: baseContract({ identity: { contractId: '' } }),
      expectValid: false,
      expectRule: 'MIN_LENGTH',
    },
    {
      name: '4. targetMetric 不在枚举 ⇒ ENUM',
      contract: baseContract({ hypothesis: { targetMetric: 'VIBES' } }),
      expectValid: false,
      expectRule: 'ENUM',
    },
    {
      name: '5. ★ benchmarkSet = FROZEN 必须被拦（设计 §4.2.1 修正表）',
      contract: baseContract({ evaluationPlan: { benchmarkSet: 'FROZEN' } }),
      expectValid: false,
      expectRule: 'BENCHMARK_SET_FROZEN',
    },
    {
      name: '6. benchmarkSet = VALIDATION 应通过',
      contract: baseContract({ evaluationPlan: { benchmarkSet: 'VALIDATION' } }),
      expectValid: true,
    },
    {
      name: '7. sampleSize = 0 ⇒ MINIMUM',
      contract: baseContract({ evaluationPlan: { sampleSize: 0 } }),
      expectValid: false,
      expectRule: 'MINIMUM',
    },
    {
      name: '8. significanceLevel = 1.5 ⇒ MAXIMUM',
      contract: baseContract({ evaluationPlan: { significanceLevel: 1.5 } }),
      expectValid: false,
      expectRule: 'MAXIMUM',
    },
    {
      name: '9. audit.status 非法值 ⇒ ENUM',
      contract: baseContract({ audit: { status: 'VIBING' } }),
      expectValid: false,
      expectRule: 'ENUM',
    },
    {
      name: '10. audit.status = TAMPERED 是合法终态',
      contract: baseContract({ audit: { status: 'TAMPERED' } }),
      expectValid: true,
    },
    {
      name: '11. createdAt 非 ISO-8601 ⇒ FORMAT',
      contract: baseContract({ identity: { createdAt: '2026/10/02 04:15' } }),
      expectValid: false,
      expectRule: 'FORMAT',
    },
    {
      name: '12. ★ predictedDelta=null 且标注 NOT_PREDICTED ⇒ 通过（Phase 0 允许）',
      contract: baseContract({
        hypothesis: { predictedDelta: null, predictedDeltaNote: 'NOT_PREDICTED' },
      }),
      expectValid: true,
    },
    {
      name: '13. ★ outcome 有数值但 dataSources.primary 缺失 ⇒ NO_EVIDENCE_VIOLATION',
      contract: baseContract({
        outcome: {
          actualDeltas: [{ metric: 'SUCCESS_RATE', baseline: 0.5, candidate: 0.6, delta: 0.1 }],
        },
      }),
      expectValid: false,
      expectRule: 'NO_EVIDENCE_VIOLATION',
    },
    {
      name: '14. ★ outcome 四源全空标 NO_EVIDENCE 且无数值 ⇒ 通过',
      contract: baseContract({
        outcome: {
          actualDeltas: [],
          dataSources: { primary: 'NO_EVIDENCE', queriedDomains: [], mutatorStatsReliable: false },
        },
      }),
      expectValid: true,
    },
    {
      name: '15. ★ outcome 有数值且有 primary 来源 ⇒ 通过',
      contract: baseContract({
        outcome: {
          actualDeltas: [{ metric: 'SUCCESS_RATE', baseline: 0.5, candidate: 0.6, delta: 0.1 }],
          dataSources: { primary: 'event_bus', queriedDomains: ['agint_event_bus'] },
        },
      }),
      expectValid: true,
    },
    {
      name: '16. 未声明的顶层字段 ⇒ ADDITIONAL_PROPERTIES',
      contract: baseContract({ surpriseField: 1 }),
      expectValid: false,
      expectRule: 'ADDITIONAL_PROPERTIES',
    },
    {
      name: '17. 注解键（_ 开头）不受 ADDITIONAL_PROPERTIES 限制',
      contract: baseContract({ _note: '任意注解' }),
      expectValid: true,
    },
    {
      name: '18. changeType 非法 ⇒ ENUM（嵌套数组项）',
      contract: baseContract({
        hypothesis: {
          changedComponents: [{ pluginName: 'p', filesChanged: [], changeType: 'TWEAK' }],
        },
      }),
      expectValid: false,
      expectRule: 'ENUM',
    },
    // ── 防事后编造（设计 §4.2.4）：锁定值按公式重算比对 ──────────────────
    {
      name: '19. ★ hypothesisLock 与 §4.2.4 公式一致 ⇒ 通过',
      contract: baseContract(),
      expectValid: true,
      // 锁定值取自 contract_locks 表（设计 §4.2.6），这里按公式现场算出等价物
      lockFrom: (c) => computeHypothesisLock(c),
    },
    {
      name: '20. ★ 锁定后偷偷改 hypothesis ⇒ HYPOTHESIS_LOCK_MISMATCH',
      contract: (() => {
        const c = baseContract();
        // 偷改假设（看到结果后编造预测 —— 正是本机制要防的）
        c.hypothesis.summary = '改成事后看起来对的假设';
        return c;
      })(),
      expectValid: false,
      expectRule: 'HYPOTHESIS_LOCK_MISMATCH',
      // 锁定值仍是「原假设」上算的
      lockFrom: () => computeHypothesisLock(baseContract()),
    },
  ];
}

function runFixtures() {
  const schema = loadSchema();
  const cases = fixtures();
  let pass = 0;
  const failures = [];
  const rows = [];

  for (const c of cases) {
    const opts = c.lockFrom ? { expectedHypothesisLock: c.lockFrom(c.contract) } : {};
    const r = validateContract(c.contract, schema, opts);
    let ok = r.valid === c.expectValid;
    if (ok && c.expectRule) {
      ok = r.errors.some((e) => e.rule === c.expectRule);
    }
    rows.push({
      name: c.name,
      expectValid: c.expectValid,
      expectRule: c.expectRule ?? null,
      actualValid: r.valid,
      actualRules: r.errors.map((e) => e.rule),
      ok,
    });
    if (ok) pass++;
    else failures.push(c.name);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ total: cases.length, pass, failures, rows }, null, 2));
  } else {
    console.log(`[validate-contract-schema] 内置用例 ${cases.length} 个`);
    for (const r of rows) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
      if (!r.ok) {
        console.log(
          `      期望 valid=${r.expectValid}${r.expectRule ? ` rule=${r.expectRule}` : ''}` +
            ` · 实际 valid=${r.actualValid} rules=[${r.actualRules.join(', ')}]`,
        );
      }
    }
    console.log(`\n=== ${pass} passed, ${cases.length - pass} failed (of ${cases.length}) ===`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  if (FIXTURES) return runFixtures();

  if (!target) {
    console.error('用法：node bin/validate-contract-schema.mjs <contract.json> [--json] [--lock=<hex>]');
    console.error('      node bin/validate-contract-schema.mjs --fixtures');
    process.exit(2);
  }
  const abs = resolve(process.cwd(), target);
  if (!existsSync(abs)) {
    console.error(`[validate-contract-schema] 文件不存在：${abs}`);
    process.exit(2);
  }

  let schema;
  try {
    schema = loadSchema();
  } catch (e) {
    console.error(`[validate-contract-schema] 读不到 schema ${SCHEMA_PATH}: ${e?.message || e}`);
    process.exit(2);
  }
  let contract;
  try {
    contract = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error(`[validate-contract-schema] Contract JSON 解析失败：${e.message}`);
    process.exit(2);
  }

  const r = validateContract(contract, schema, { expectedHypothesisLock: lockArg });

  if (AS_JSON) {
    console.log(JSON.stringify({ file: abs, ...r }, null, 2));
  } else {
    console.log(`[validate-contract-schema] ${abs}`);
    if (r.valid) console.log('  ✓ 通过');
    else {
      console.log(`  ✗ ${r.errors.length} 处错误:`);
      for (const e of r.errors) console.log(`     [${e.rule}] ${e.path || '(root)'}: ${e.message}`);
    }
    if (r.warnings.length > 0) {
      console.log(`  ⚠️ ${r.warnings.length} 处提示:`);
      for (const w of r.warnings) console.log(`     [${w.rule}] ${w.path}: ${w.message}`);
    }
  }
  process.exit(r.valid ? 0 : 1);
}

// 被 import 时（单测）不执行主流程，否则 process.exit 会把测试进程一起带走。
// ⛔ 两侧必须同形式：Windows 路径 vs file:/// URL 比不出相等，会静默假绿。
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
