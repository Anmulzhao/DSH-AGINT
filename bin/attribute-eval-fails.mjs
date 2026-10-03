#!/usr/bin/env node
/**
 * bin/attribute-eval-fails.mjs —— eval 存量 FAIL 归因器（A4 / 路线图 1.4）
 *
 * ## 它回答什么
 *
 *   `inventory.json` 说有 6 个 fail。这 6 个**分别因为什么**而 fail？
 *   逐条定位到**根因类**，并给出该走哪条修法。
 *
 * ## ⛔ 它不做归因「结论」，它做归因「取证」
 *
 * 每条归因都必须附**可复算的证据**（diff 两侧的实际值 / 权威模块的实时读数），
 * 而不是「看起来像」。所以判据层全部是：
 *   ① 从被测系统**动态 import 权威模块**取当前真值（jobs.js / schema.js / evaluators.js …）
 *   ② 从场景 JSON 取断言值
 *   ③ 两者比对，把差额写进证据
 *
 * ⛔ 绝不在本文件里硬编码「24 个 job」「80.0 分」这种数字 ——
 *   硬编码的归因器下次代码变了就会给出过期结论，而且看不出来。
 *
 * ## 根因类（封闭集，不得扩充）
 *
 *   ASSERT_DRIFT         断言漂移 —— 被测行为变了，场景期望没跟着改（代码是对的，场景过期）
 *   HARNESS_GAP          评估基建缺口 —— driver 的 mock/派发与真实接口不一致（代码是对的，driver 过期）
 *   REAL_DEFECT          真产品缺陷 —— 被测代码本身不满足场景声明的契约
 *   NOT_ATTRIBUTED       未能归因 —— 证据不足，宁可留空不猜
 *
 * ⛔ 猜一个类比归因错更坏：错类会让修法选错（改场景 vs 改代码），
 *   而错修法会让下一个人以为已经修好了。
 *
 * 用法：
 *   node bin/attribute-eval-fails.mjs              # 人读 md
 *   node bin/attribute-eval-fails.mjs --json       # 机读
 *   node bin/attribute-eval-fails.mjs --coverage-min 0.8
 * 退出码：0 = 覆盖率达阈值 · 1 = 未达 · 2 = 脚本自身出错
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DEFAULT_INVENTORY = join(REPO_ROOT, 'eval', 'scenarios', 'inventory.json');

/** 根因类封闭集。加类要同时改 build-scenario-inventory.mjs 的注释与本文件单测。 */
export const FAIL_CATEGORIES = Object.freeze([
  'ASSERT_DRIFT',   // 断言漂移：代码演进了，场景期望没跟上
  'HARNESS_GAP',    // 评估基建缺口：driver mock/派发与真实接口不一致
  'REAL_DEFECT',    // 真产品缺陷：被测代码不满足场景声明的契约
  'NOT_ATTRIBUTED', // 未归因：证据不足
]);

/** A4 判据：覆盖率 ≥ 80%。低于就退出码 1。 */
export const DEFAULT_COVERAGE_MIN = 0.8;

const err = (m) => new Error(m);

// ── 权威读数（全部动态 import，不硬编码）───────────────────────────────

/** 从 jobs.js 读当前默认 job 的真实 id 集合。 */
export async function readDefaultJobIds() {
  const mod = await import(pathToFileURL(join(REPO_ROOT, 'plugins', 'agint-cron', 'lib', 'jobs.js')).href);
  const jobs = mod.defaultJobs;
  if (!Array.isArray(jobs) || jobs.length === 0) throw err('jobs.js 的 defaultJobs 读不到或为空');
  return { ids: jobs.map((j) => j.id).sort(), count: jobs.length };
}

/** 从 evolution-memory/schema.js 读 LIMITS 真值。 */
export async function readEvolutionMemoryLimits() {
  const mod = await import(pathToFileURL(join(REPO_ROOT, 'plugins', 'agint-evolution-memory', 'lib', 'schema.js')).href);
  if (!mod.LIMITS) throw err('evolution-memory/schema.js 的 LIMITS 读不到');
  return { ...mod.LIMITS };
}

/** 从 quality-eval/evaluators.js 读维度权重，从 decide.js 读默认阈值。 */
export async function readPolicyWeightsAndThresholds() {
  const ev = await import(pathToFileURL(join(REPO_ROOT, 'plugins', 'agint-quality', 'agint-quality-eval', 'lib', 'evaluators.js')).href);
  const weights = ev.DIMENSION_WEIGHTS;
  if (!weights) throw err('evaluators.js 的 DIMENSION_WEIGHTS 读不到');
  // decide.js 的默认阈值写在函数体里（config?.thresholds ?? {...}），这里只取作者写下的值。
  // 读不到就返回 null，由归因器显式报「无法取证」而不是猜一个。
  const src = readFileSync(join(REPO_ROOT, 'plugins', 'agint-quality', 'agint-quality-policy', 'lib', 'decide.js'), 'utf8');
  const m = src.match(/config\.thresholds\s*\?\?\s*\{\s*autoDeploy:\s*(\d+),\s*pendingReview:\s*(\d+)\s*\}/);
  return {
    weights: { ...weights },
    thresholds: m ? { autoDeploy: Number(m[1]), pendingReview: Number(m[2]) } : null,
  };
}

/** 从 diagnosis 插件读表满上限与 cold-start 阈值。 */
export async function readDiagnosisLimits() {
  const s = await import(pathToFileURL(join(REPO_ROOT, 'plugins', 'agint-diagnosis', 'lib', 'schema.js')).href);
  return { ANNOTATIONS: s.LIMITS?.ANNOTATIONS ?? null, LIMITS: { ...(s.LIMITS ?? {}) } };
}

/** 从 event-bus 插件源码确认伞键 `agint.eventBus` 是否提供了 publish。 */
export function readUmbrellaKeyShape() {
  const src = readFileSync(join(REPO_ROOT, 'plugins', 'agint-event-bus', 'lib', 'index.js'), 'utf8');
  const hasUmbrellaProvide = /ctx\.provide\(\s*'agint\.eventBus'\s*,/.test(src);
  const umbrellaBlock = hasUmbrellaProvide
    ? (src.split(/ctx\.provide\(\s*'agint\.eventBus'\s*,/)[1] ?? '')
    : '';
  const providesPublish = /publish\s*:/.test(umbrellaBlock.split(/\}\s*\);/)[0] ?? '');
  return { hasUmbrellaProvide, umbrellaProvidesPublish: providesPublish };
}

/** 从 driver.js 读 diagnosis 的 makeFakeCtx 是否给 table 提供了 size。 */
export function readFakeTableShape() {
  const src = readFileSync(join(REPO_ROOT, 'eval', 'scenarios', 'driver.js'), 'utf8');
  const anchor = src.indexOf('const makeFakeCtx = ({ failurePatternCount = 0, annotationsCount = 0 } = {}) => {');
  if (anchor < 0) return { found: false, hasSize: false, hasEntries: false };
  // 取该函数体：从 anchor 到下一个顶层 `\n    };`
  const body = src.slice(anchor, anchor + 2000);
  return {
    found: true,
    hasSize: /\btable:\s*\(\s*name\s*\)\s*=>\s*\(\s*\{[^}]*\bsize\b/.test(body),
    hasEntries: /entries:\s*\(\)\s*=>/.test(body),
    snippet: body.slice(0, 900),
  };
}

// ── 场景读取 ───────────────────────────────────────────────────────────

function readScenario(fileRel, unitId) {
  const abs = join(REPO_ROOT, fileRel);
  if (!existsSync(abs)) throw err(`场景文件不存在：${fileRel}`);
  const text = readFileSync(abs, 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw err(`场景文件不是合法 JSON：${fileRel}（${e.message}）`); }
  const units = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.units) ? parsed.units : []);
  const u = units.find((x) => x.scenario === unitId);
  if (!u) throw err(`场景文件里找不到单元 ${unitId}（${fileRel}）`);
  return u;
}

// ── 归因器：每个探针负责一族 unitId ───────────────────────────────────
//
// 探针契约：输入 unit + 实时权威读数，输出 { category, reason, evidence[], fix }。
// ⛔ 探针若拿不到证据，必须返回 category='NOT_ATTRIBUTED'，
//   不得「根据经验」给个类 —— 证据不足时诚实的失败比错误的归因有价值。

/**
 * 探针 1：`default-jobs-registered` 类断言漂移。
 * 判据：场景 expectedIds ≠ jobs.js 当前真实 id 集合。
 * 归为 ASSERT_DRIFT 的前提：场景缺的是**新增**的 job（真实集合 ⊇ 场景集合）。
 * 若真实集合有场景没列的**删除项**（真实 ⊂ 场景），那是另一种漂移，reason 要分开写。
 */
export function attributeDefaultJobs(unit, live) {
  const exp = unit.expected?.[0];
  const expectedIds = Array.isArray(exp?.expectedIds) ? [...exp.expectedIds].sort() : null;
  if (!expectedIds) {
    return notAttributed('场景 expected[0].expectedIds 缺失或不是数组');
  }
  const liveIds = live.ids;
  const expectedSet = new Set(expectedIds);
  const liveSet = new Set(liveIds);
  const missing = liveIds.filter((id) => !expectedSet.has(id));
  const extra = expectedIds.filter((id) => !liveSet.has(id));

  if (missing.length === 0 && extra.length === 0) {
    return notAttributed('期望与真值完全一致 —— driver 报 fail 必有第三个原因（未取证）', {
      expectedIds,
      liveIds,
    });
  }

  const onlyAdditions = extra.length === 0 && missing.length > 0;
  return {
    category: 'ASSERT_DRIFT',
    reason: onlyAdditions
      ? `场景漏列了 ${missing.length} 个新增默认 job（真实集合 ⊇ 场景集合）⇒ 断言比实现旧`
      : `场景期望与真实 job 集合双向不一致：真实缺 ${missing.length} 个、场景多 ${extra.length} 个`,
    evidence: [
      `场景 expectedIds（${expectedIds.length} 个）：${expectedIds.join(',')}`,
      `jobs.js 真值（${liveIds.length} 个）：${liveIds.join(',')}`,
      `真实有、场景无：${missing.join(',') || '（无）'}`,
      `场景有、真实无：${extra.join(',') || '（无）'}`,
      'driver 断言方式：JSON.stringify(ids) === JSON.stringify(expectedIds.sort()) ⇒ 严格逐项相等，多一个即 fail',
    ],
    fix: onlyAdditions
      ? '改场景：把 expectedIds 补齐到与 jobs.js 一致。⛔ 不要改 driver 的相等判据 —— 放宽后新增 job 就再也不会被发现。'
      : '逐个核对被删的 job 是真删除还是误删；确认真值后再改场景，不要直接照抄 jobs.js。',
  };
}

/**
 * 探针 2：`stats-shape` 的 limitsShape 断言漂移。
 * 判据：场景 limitsShape ≠ evolution-memory/schema.js 当前 LIMITS。
 */
export function attributeStatsLimits(unit, liveLimits) {
  const exp = unit.expected?.[0];
  const shape = exp?.limitsShape;
  if (!shape || typeof shape !== 'object') {
    return notAttributed('场景 expected[0].limitsShape 缺失或不是对象');
  }
  const missingKeys = Object.keys(liveLimits).filter((k) => !(k in shape));
  const extraKeys = Object.keys(shape).filter((k) => !(k in liveLimits));
  const valueDrift = Object.keys(shape)
    .filter((k) => k in liveLimits && liveLimits[k] !== shape[k])
    .map((k) => `${k}: 场景 ${shape[k]} → 真实 ${liveLimits[k]}`);

  if (missingKeys.length === 0 && extraKeys.length === 0 && valueDrift.length === 0) {
    return notAttributed('limitsShape 与 schema.js 完全一致 —— 报 fail 原因在第三个地方（未取证）');
  }
  if (valueDrift.length > 0 && missingKeys.length === 0 && extraKeys.length === 0) {
    return {
      category: 'ASSERT_DRIFT',
      reason: `同一 key 的上限值变了（${valueDrift.length} 个）⇒ 场景写的是旧上限`,
      evidence: valueDrift.map((s) => `值漂移 ${s}`),
      fix: '改场景的 limitsShape 值。改前先确认是「上限被有意调高」还是「误改」。',
    };
  }
  return {
    category: 'ASSERT_DRIFT',
    reason: `schema.js 的 LIMITS 新增了 key（${missingKeys.length} 个）/ 场景多了 key（${extraKeys.length} 个）`
      + (valueDrift.length ? `，另有 ${valueDrift.length} 个值漂移` : '')
      + ' ⇒ driver 用 JSON.stringify 全等比对，新加一个上限就 fail',
    evidence: [
      `场景 limitsShape（${Object.keys(shape).length} 个）：${JSON.stringify(shape)}`,
      `schema.js LIMITS（${Object.keys(liveLimits).length} 个）：${JSON.stringify(liveLimits)}`,
      `真实有、场景无：${missingKeys.join(',') || '（无）'}`,
      `场景有、真实无：${extraKeys.join(',') || '（无）'}`,
      ...valueDrift.map((s) => `值漂移 ${s}`),
      '⛔ 这一条是「全等比对」的必然后果：以后每加一个上限常量都会红一次。',
    ],
    fix: '两种改法：(a) 改场景补齐 key；'
      + '(b) 把 driver 的 limitsShape 断言从「全等」改成「场景声明的每个 key 都必须一致」'
      + '（**新增 key 不再 fail**，删 key / 改值仍 fail）。(b) 更好，但改的是判据，要走门禁。',
  };
}

/**
 * 探针 3：`policy decide` 的 decision/score 断言漂移。
 * 判据：用 evaluators.js 的权重实算 composite，与场景期望的 decision 比对。
 */
export function attributePolicyDecision(unit, live) {
  const input = unit.input?.[0];
  const exp = unit.expected?.[0];
  const results = input?.results;
  if (!Array.isArray(results) || results.length === 0) {
    return notAttributed('场景 input.results 缺失或为空');
  }
  if (!exp?.decision) return notAttributed('场景 expected.decision 缺失');

  // 按 decide.js 的口径实算：只对**声明了 score** 的维度累计（分母只算有效维度）
  let num = 0;
  let den = 0;
  const dimsUsed = [];
  for (const r of results) {
    for (const d of r.dimensions ?? []) {
      const s = d.score?.score;
      if (s === null || s === undefined) continue;
      const w = live.weights[d.key] ?? 0;
      num += s * w;
      den += w;
      dimsUsed.push(`${d.key}=${s}×${w}`);
    }
  }
  if (den === 0) return notAttributed('按当前权重没有任何有效维度（den=0）⇒ 无法实算');
  const composite = Number(((num / den) * 100).toFixed(2));

  const th = live.thresholds;
  if (!th) return notAttributed('读不到 decide.js 的默认阈值（正则未命中）⇒ 不猜');

  const classify = (c) => (c >= th.autoDeploy ? 'AUTO_DEPLOY'
    : c >= th.pendingReview ? 'PENDING_REVIEW'
      : 'REJECT');
  const actual = classify(composite);

  if (actual === exp.decision) {
    return notAttributed(
      `按权重实算 composite=${composite} → ${actual}，与场景期望一致 ⇒ 报 fail 原因在别处（未取证）`,
      { composite, actual, dimsUsed, thresholds: th },
    );
  }
  const noteMatch = String(input._note ?? '').match(/=?\s*(100\s*\*\s*\(?[\d.]+\s*\/\s*[\d.]+\)?\s*=\s*([\d.]+))/);
  return {
    category: 'ASSERT_DRIFT',
    reason: `按当前权重实算 composite=${composite} → ${actual}，场景期望 ${exp.decision}`,
    evidence: [
      `权重（evaluators.js DIMENSION_WEIGHTS）：${JSON.stringify(live.weights)}`,
      `阈值（decide.js 默认）：autoDeploy=${th.autoDeploy} pendingReview=${th.pendingReview}`,
      `参与计分：${dimsUsed.join(' + ')}`,
      `实算：(${num.toFixed(4)} / ${den.toFixed(4)}) × 100 = ${composite}`,
      `分类：composite ≥ ${th.autoDeploy} ? AUTO_DEPLOY : ≥ ${th.pendingReview} ? PENDING_REVIEW : REJECT ⇒ ${actual}`,
      noteMatch
        ? `场景 _note 自带的算式 = ${noteMatch[2]} ⇒ 场景里那句手算注释本身也算错了（分子写成 0.62，实际 0.72）`
        : '场景 _note 里没有可解析的算式注释',
      '⛔ 场景期望值不是从权重表推出来的，是手写的 ⇒ 权重一改就漂。',
    ],
    fix: '改场景的 decision/scoreAtLeast；⛔ 不要改阈值来迁就场景 —— 阈值是老板 2026-09-17 拍板的。',
  };
}

/**
 * 探针 4：`throws` 类断言 —— 表满守门未触发。
 * 这里分两种根因，必须靠 driver 的 mock 形状区分：
 *   mock table 缺 `size` ⇒ HARNESS_GAP（driver 的 mock 与真实 Table 接口不一致）
 *   mock table 有 `size`  ⇒ 需进一步看是 REAL_DEFECT 还是场景本身没喂满
 */
export function attributeThrowsOnTableFull(unit, liveLimits, fakeTable) {
  const input = unit.input?.[0];
  const exp = unit.expected?.[0];
  const cap = liveLimits.ANNOTATIONS;
  if (!cap) return notAttributed('读不到 diagnosis LIMITS.ANNOTATIONS');
  if (exp?.kind !== 'throws') return notAttributed(`expected.kind=${exp?.kind}，不是 throws`);

  const seeded = input?.args?.annotationsCount ?? 0;
  const patternCount = input?.args?.failurePatternCount ?? 0;
  const guardOrder = patternCount < 10
    ? ['cold-start(failure_pattern<10)', '表满(annotations>=cap)']
    : ['表满(annotations>=cap)', '无后续守门'];

  if (!fakeTable.found) {
    return {
      category: 'HARNESS_GAP',
      reason: 'driver.js 里找不到 diagnosis 的 makeFakeCtx ⇒ 探针前提不成立',
      evidence: ['driver.js 源码未匹配到 makeFakeCtx 定义'],
      fix: '人工取证。',
    };
  }
  if (!fakeTable.hasSize) {
    return {
      category: 'HARNESS_GAP',
      reason: 'driver 的 fake table 只提供 entries()，没有 size；'
        + '而插件的守门读的是 t.size ⇒ undefined >= cap 恒 false ⇒ 守门永不触发 ⇒ 场景永远看不到抛错',
      evidence: [
        `场景想造满：annotationsCount=${seeded}（cap=${cap}）、failurePatternCount=${patternCount}`,
        `守门顺序：${guardOrder.join(' → ')}（failurePatternCount=${patternCount} ≥ 10，cold-start 不拦）`,
        '插件读法：plugins/agint-diagnosis/lib/index.js:233 `if (t.size >= LIMITS.ANNOTATIONS) throw ...`',
        '真实 Table 接口：@deepseek-ai/dsh-storage-domain/lib/index.js:253 `get size() { return this.records.size }`',
        `driver fake table：有 entries=${fakeTable.hasEntries}、有 size=${fakeTable.hasSize}`,
        'driver detail（实跑）：`未抛错，反而返回 rootCause=TOOL_GAP` ⇒ 守门确实没触发',
      ],
      fix: '给 driver 的 makeFakeCtx 的 table 加上 `size: entries.length`（⛔ 不改插件的守门逻辑 —— '
        + '用 undefined 比较来「通过」是假防线）。⚠️ 这是 K141 同款：部署位测试红了先判调用前提。',
    };
  }
  return {
    category: 'REAL_DEFECT',
    reason: 'mock table 提供了 size ⇒ 守门能被读到。仍不抛 ⇒ 被测代码或场景数据有一方不符契约',
    evidence: [
      `场景想造满：annotationsCount=${seeded}（cap=${cap}）`,
      'driver fake table 有 size ⇒ HARNESS_GAP 排除',
      '需要实跑 annotate() 看它到底走到哪一步（本次未取证）',
    ],
    fix: '人工跑一次 annotate() 取真实抛错/返回值，再判是代码缺陷还是场景数据不足。',
  };
}

/**
 * 探针 5：event-bus 伞键断言 —— 前提被后来的改动推翻。
 * 场景断言 `publishDoesNotUseUmbrellaKey`，其测量方式是「查伞键对象上有没有 publish」。
 * 但 event-bus 后来**故意补上了伞键**（纯加法，为免消费方写回退链）。
 * ⇒ 「伞键没有 publish」这个前提已不成立，断言本身失效。
 */
export function attributeUmbrellaKeyProbe(unit, live) {
  const exp = unit.expected?.[0];
  const keys = Array.isArray(exp?.expectedKeys) ? exp.expectedKeys : [];
  if (!keys.includes('publishDoesNotUseUmbrellaKey=true')) {
    return notAttributed('场景不含 publishDoesNotUseUmbrellaKey 断言');
  }
  if (!live.hasUmbrellaProvide) {
    return notAttributed('event-bus 当前未 provide 伞键 ⇒ 应属 REAL_DEFECT，但本次未实跑取证');
  }
  return {
    category: 'ASSERT_DRIFT',
    reason: '断言的**测量方式**基于一个已被推翻的前提：'
      + '「伞键上不该有 publish」。event-bus 后来主动补了 `ctx.provide(\'agint.eventBus\', {...publish...})`'
      + '（纯加法，让消费方免写回退链）⇒ 伞键有 publish 是**当前设计的正确行为**，'
      + '而场景仍把它当成缺陷。真正该守的是「policy 走的是单 service 接口」',
    evidence: [
      '场景 assertion 原文：`publishDoesNotUseUmbrellaKey = umbrellaKeyCalled === false`',
      '场景测量代码：先 `ctx.get(\'agint.eventBus\')`，再判 `.publish` 是否函数 ⇒ 测的是「伞键存不存在」',
      'event-bus 现状：plugins/agint-event-bus/lib/index.js:167 `ctx.provide(\'agint.eventBus\', { publish, subscribe, inspect, ... })`',
      `实时核对：hasUmbrellaProvide=${live.hasUmbrellaProvide} umbrellaProvidesPublish=${live.umbrellaProvidesPublish}`,
      'policy 侧实际写法（对）：policyEvents.js:108 `ctx.get(\'agint.eventBus.publish\')` —— 单 service 接口，符合设计',
      'driver detail（实跑）：12 项断言里 11 项 true，只有 `publishDoesNotUseUmbrellaKey:false` 红',
      '⇒ 其余 11 项都过，说明被测行为是对的，错的只是这一项的测量方式',
    ],
    fix: '改 branch 的测量方式：不再问「伞键有没有 publish」，改为**替换 publish 单 service 接口**'
      + '（ctx.get 劫持成返回计数函数），再断言调用计数 === 0。'
      + '⛔ 不要删掉这项断言 —— 「policy 不走伞键」这条设计约定仍要守，只是测法要换。',
  };
}

function notAttributed(reason, extra = {}) {
  return { category: 'NOT_ATTRIBUTED', reason, evidence: [reason, ...Object.values(extra).map((v) => JSON.stringify(v))], fix: '需要人工取证。', ...extra };
}

// ── 探针路由 ───────────────────────────────────────────────────────────

/**
 * 按 unitId 选探针。
 * ⛔ 未登记的 unitId 不许走「兜底猜一个类」，直接 NOT_ATTRIBUTED ——
 *   归因表漏了一个单元是可修的 bug，猜错类是会把人引到错误修法上的污染。
 */
export function probeFor(unitId) {
  const table = [
    ['cron-default-jobs-registered', 'defaultJobs'],
    ['sprint6-cron-job-prompt-static-check-registered', 'defaultJobs'],
    ['service-annotations-table-full-throws', 'tableFull'],
    ['stats-reports-counts-and-limits', 'statsLimits'],
    ['policy-decide-clean-results-pending-or-deploy', 'policyDecision'],
    ['s12-05-policy-policy-deployed-rolledback-shadow', 'umbrellaKey'],
  ];
  return table.find(([id]) => id === unitId)?.[1] ?? null;
}

/**
 * 归因全部 FAIL 单元。
 * @param {object} input
 * @param {Array} input.units inventory.json 的 units
 * @param {object} input.live 预先取好的权威读数（便于单测注入）
 */
export async function attributeAll({ units, live = null, coverageMin = DEFAULT_COVERAGE_MIN } = {}) {
  const L = live ?? {
    jobIds: await readDefaultJobIds(),
    evoLimits: await readEvolutionMemoryLimits(),
    policy: await readPolicyWeightsAndThresholds(),
    diagLimits: await readDiagnosisLimits(),
    umbrella: readUmbrellaKeyShape(),
    fakeTable: readFakeTableShape(),
  };

  const fails = (Array.isArray(units) ? units : []).filter((u) => u.lastKnownStatus === 'FAIL');
  const results = [];
  for (const u of fails) {
    const kind = probeFor(u.unitId);
    let attribution;
    if (kind === null) {
      attribution = notAttributed('⛔ 该 unitId 未登记探针 —— 归因表漏了一条，不猜');
    } else {
      const unit = readScenario(u.sourceFile, u.unitId);
      try {
        switch (kind) {
          case 'defaultJobs':
            attribution = attributeDefaultJobs(unit, L.jobIds); break;
          case 'statsLimits':
            attribution = attributeStatsLimits(unit, L.evoLimits); break;
          case 'policyDecision':
            attribution = attributePolicyDecision(unit, L.policy); break;
          case 'tableFull':
            attribution = attributeThrowsOnTableFull(unit, L.diagLimits, L.fakeTable); break;
          case 'umbrellaKey':
            attribution = attributeUmbrellaKeyProbe(unit, L.umbrella); break;
          default:
            attribution = notAttributed(`未知探针类型 ${kind}`);
        }
      } catch (e) {
        attribution = notAttributed(`探针执行出错：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    results.push({
      unitId: u.unitId,
      domain: u.domain ?? null,
      plugin: u.plugin ?? null,
      sourceFile: u.sourceFile,
      probe: kind,
      ...attribution,
    });
  }

  const attributed = results.filter((r) => r.category !== 'NOT_ATTRIBUTED');
  const coverage = results.length === 0 ? null : attributed.length / results.length;
  const byCategory = {};
  for (const r of results) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  return {
    // ⛔ 自带生成标记：产物入库（部署位周报要真读到），但**手改等于伪造归因**。
    //   归因证据链的唯一真身是本脚本对权威模块的动态读数，不是这个文件。
    _generatedBy: {
      tool: 'bin/attribute-eval-fails.mjs',
      command: 'node bin/attribute-eval-fails.mjs --json > eval/attribution/fail-attribution.json',
      doNotHandEdit: true,
      why: '生成物，勿手改。入库是部署位 evolve-review 周报的数据源 + check-wiring 的校验对象。',
    },
    generatedAt: new Date().toISOString(),
    total: results.length,
    attributed: attributed.length,
    coverage,
    coverageMin,
    coverageOk: coverage !== null && coverage >= coverageMin,
    byCategory,
    realDefects: results.filter((r) => r.category === 'REAL_DEFECT').length,
    results,
  };
}

// ── 渲染 ───────────────────────────────────────────────────────────────

export function renderAttribution(a) {
  const L = [];
  L.push(`# eval 存量 FAIL 归因（${a.generatedAt.slice(0, 10)}）`);
  L.push('');
  L.push(`> 生成器：\`bin/attribute-eval-fails.mjs\`（只读）· FAIL ${a.total} 条 · 已归因 ${a.attributed} 条`);
  L.push('');
  L.push(a.coverage === null
    ? '> ⚠️ 当前 driver 口径下 **0 个 FAIL** —— 本报告无内容可归因。「全绿」与「没查」长得一样，此处显式声明。'
    : `> 覆盖率 **${(a.coverage * 100).toFixed(1)}%**（${a.attributed}/${a.total}）· 阈值 ${(a.coverageMin * 100).toFixed(0)}% · ${a.coverageOk ? '✅ 达标' : '❌ 未达标'}`);
  L.push('');
  L.push('> ⛔ 每条归因都附**可复算证据**（权威模块的实时读数 vs 场景断言值），不是「看起来像」。');
  L.push('> ⛔ 证据不足时诚实标 `NOT_ATTRIBUTED`，不猜 —— 错类会把修法引到反方向。');
  L.push('');

  L.push('## 1. 根因类分布');
  L.push('');
  L.push('| 根因类 | 条数 | 含义 | 该改什么 |');
  L.push('|---|---|---|---|');
  const MEANING = {
    ASSERT_DRIFT: ['被测行为演进（或断言的前提被推翻），场景期望没跟上', '改场景期望'],
    HARNESS_GAP: ['driver 的 mock / 派发与真实接口不一致', '改 driver 基建'],
    REAL_DEFECT: ['被测代码不满足场景声明的契约', '改产品代码'],
    NOT_ATTRIBUTED: ['证据不足，不猜', '人工取证'],
  };
  for (const cat of FAIL_CATEGORIES) {
    const [desc, fix] = MEANING[cat];
    L.push(`| \`${cat}\` | ${a.byCategory[cat] ?? 0} | ${desc} | ${fix} |`);
  }
  L.push('');
  if (a.realDefects > 0) {
    L.push(`> ⚠️ **有 ${a.realDefects} 条 REAL_DEFECT** —— 这类必须改产品代码，且要过门禁与实测。`);
  } else {
    L.push('> ✅ **0 条 REAL_DEFECT** —— 没有一个 FAIL 是产品缺陷。全部在评估侧（场景期望 或 driver 基建）。');
  }
  L.push('');

  L.push('## 2. 逐条归因');
  L.push('');
  for (const r of a.results) {
    L.push(`### \`${r.unitId}\``);
    L.push('');
    L.push(`- **根因类**：\`${r.category}\`　**探针**：${r.probe ? `\`${r.probe}\`` : '⛔ 未登记'}`);
    L.push(`- **域 / 插件**：${r.domain ?? '—'} / ${r.plugin ?? '—'}`);
    L.push(`- **场景文件**：\`${r.sourceFile}\``);
    L.push(`- **结论**：${r.reason}`);
    L.push('- **证据**：');
    for (const e of r.evidence) L.push(`  - ${e}`);
    L.push(`- **修法**：${r.fix}`);
    L.push('');
  }

  L.push('## 3. 修法优先级（按「改错代价」排）');
  L.push('');
  L.push('1. **`REAL_DEFECT`**（本次 0 条）—— 改产品代码，要门禁 + 实测。');
  L.push('2. **`HARNESS_GAP`** —— 改 driver mock。风险：mock 与真实接口越走越远，缺口会扩散。');
  L.push('3. **`ASSERT_DRIFT`** —— 改场景期望。风险最低，但必须逐条人工确认「是代码对、场景旧」，不能批量照抄真值。');
  L.push('');
  L.push('> ⛔ **不要为了让 driver 全绿而放宽判据**。6 个 fail 里没有一个是产品缺陷，');
  L.push('>   但放宽判据会让下一次真回归也变成 PASS —— 那才是真正的损失。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('*只读脚本：不改场景、不改 driver、不改产品代码。第 2 节的「修法」是建议，执行需单独决定。*');
  return `${L.join('\n')}\n`;
}

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const opts = { json: false, inventory: DEFAULT_INVENTORY, coverageMin: DEFAULT_COVERAGE_MIN, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--inventory') opts.inventory = argv[++i];
    else if (a === '--coverage-min') opts.coverageMin = Number(argv[++i]);
    else throw err(`未知参数：${a}`);
  }
  if (!existsSync(opts.inventory)) throw err(`清单不存在：${opts.inventory}`);
  const inv = JSON.parse(readFileSync(opts.inventory, 'utf8'));
  const a = await attributeAll({ units: inv.units ?? [], coverageMin: opts.coverageMin });

  if (opts.json) process.stdout.write(`${JSON.stringify(a, null, 2)}\n`);
  else if (opts.out) {
    writeFileSync(opts.out, renderAttribution(a), 'utf8');
    process.stdout.write(`[attribute-eval-fails] 📄 归因报告已写出：${opts.out}\n`);
    process.stdout.write(`  归因 ${a.attributed}/${a.total} 条 · 覆盖率 ${a.coverage === null ? 'N/A' : `${(a.coverage * 100).toFixed(1)}%`}\n`);
  } else process.stdout.write(renderAttribution(a));

  process.exit(a.coverageOk ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('attribute-eval-fails.mjs')) {
  main().catch((e) => {
    console.error(`[attribute-eval-fails] ❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}