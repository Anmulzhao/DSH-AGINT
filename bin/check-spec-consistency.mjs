#!/usr/bin/env node
// bin/check-spec-consistency.mjs —— 协议一致性门禁（Phase 3 交付物一，Tier A）
//
// 防什么（四个方向都要查，缺一个就漏一个）：
//   ① 悬空引用：INDEX.json 里登记的 files 在磁盘上不存在
//   ② 孤儿规范：磁盘上的 docs/specs/*.{md,json} 没被登记
//   ③ hash 失真：规范文件改了但 INDEX.json 的 schemaHash 没更新
//   ④ 状态虚报：status=ACTIVE 却没 evidence，或 status 不在枚举内
//
// ⭐ 为什么要独立于 build-spec-index.mjs：生成器「改了会重新生成」，
//    门禁「不改也能查」。两者职责分离 —— 否则一个脚本既是运动员又是裁判。
//
// ⚠️ 本门禁【只读】。它发现问题但不修问题 —— 修需要人来判断
//    （比如该不该把某份规范升 ACTIVE），自动修会把失真固化。
//
// 退出码：0 = 通过；1 = 有 ERROR。WARN 不阻塞。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SPECS_DIR = join(REPO_ROOT, 'docs', 'specs');
const INDEX_PATH = join(SPECS_DIR, 'INDEX.json');
const MATRIX_PATH = join(SPECS_DIR, 'compatibility-matrix.json');

const STATUS_VALUES = new Set(['ACTIVE', 'DESIGN', 'BLOCKED', 'ARCHIVED']);

/** 不该被索引为「规范」的文件（索引自身、矩阵、依赖清单）。 */
const NON_SPEC_FILES = new Set(['INDEX.json', 'compatibility-matrix.json', 'dependency-inventory.json']);

const errors = [];
const warns = [];
const notes = [];

function err(msg) {
  errors.push(msg);
}
function warn(msg) {
  warns.push(msg);
}

if (!existsSync(INDEX_PATH)) {
  console.error('[check-spec-consistency] ❌ docs/specs/INDEX.json 不存在。');
  console.error('   修法：跑 `node bin/build-spec-index.mjs`');
  process.exit(1);
}

let index;
try {
  index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
} catch (e) {
  console.error(`[check-spec-consistency] ❌ INDEX.json 不是合法 JSON：${e.message}`);
  process.exit(1);
}

const specs = index.specs ?? [];

// ── 磁盘上的规范文件 ────────────────────────────────────────────────────────
const onDisk = existsSync(SPECS_DIR)
  ? readdirSync(SPECS_DIR)
      .filter((f) => /\.(md|json)$/.test(f) && !NON_SPEC_FILES.has(f))
      .sort()
  : [];

// ── ① 悬空引用 + ② 孤儿规范 ─────────────────────────────────────────────────
const indexedFiles = new Set();
for (const s of specs) {
  for (const f of s.files ?? []) {
    indexedFiles.add(f);
    if (!onDisk.includes(f)) {
      err(`① 悬空引用：INDEX.json 的 ${s.id}.files 里有 "${f}"，但 docs/specs/ 下不存在`);
    }
  }
}
for (const f of onDisk) {
  if (!indexedFiles.has(f)) {
    err(`② 孤儿规范：docs/specs/${f} 未被 INDEX.json 登记（新增规范忘了跑 build-spec-index）`);
  }
}

// ── ③ hash 失真 ────────────────────────────────────────────────────────────
// 判据从生成器 import，保证两处口径同源（K110：不要有两份同义实现）
const { computeSpecHashes } = await import('./lib/spec-hash.mjs');
const freshHashes = computeSpecHashes(SPECS_DIR);
for (const s of specs) {
  const machine = (s.files ?? []).filter((f) => f.endsWith('.schema.json'));
  if (machine.length === 0) continue;
  const actual = freshHashes[s.id];
  if (actual && s.schemaHash && s.schemaHash !== actual) {
    err(
      `③ hash 失真：${s.id}.schemaHash = ${s.schemaHash}，` +
        `但 ${machine[0]} 当前是 ${actual} ⇒ 规范改了、索引没重新生成`,
    );
  }
}

// ── ④ 状态虚报 ─────────────────────────────────────────────────────────────
for (const s of specs) {
  if (!STATUS_VALUES.has(s.status)) {
    err(`④ 状态非法：${s.id}.status = ${JSON.stringify(s.status)}，枚举 ${[...STATUS_VALUES].join('/')}`);
    continue;
  }
  if (s.status === 'ACTIVE' && !(s.evidence ?? []).length) {
    err(
      `④ 状态虚报：${s.id} 标 ACTIVE 但 evidence 为空。` +
        `ACTIVE 的判据是「有生产数据或运行时已挂载」，「文件存在」不算 —— 必须给出依据。`,
    );
  }
  if (s.status === 'ACTIVE' && !s.implementedBy) {
    err(`④ 状态虚报：${s.id} 标 ACTIVE 但 implementedBy 为空`);
  }
  // 悬空依赖
  for (const dep of s.dependencies ?? []) {
    if (!specs.some((x) => x.id === dep)) {
      err(`④ 悬空依赖：${s.id}.dependencies 里的 "${dep}" 未在本索引登记`);
    }
  }
  // 自依赖
  if ((s.dependencies ?? []).includes(s.id)) {
    err(`④ 自依赖：${s.id}.dependencies 含自己`);
  }
}

// ── 交叉检查：已识别未落地的 spec 不该同时出现在 specs[] ────────────────────
const pendingIds = new Set((index.pendingSpecs ?? []).map((p) => p.id));
for (const s of specs) {
  if (pendingIds.has(s.id)) {
    err(
      `结构冲突：${s.id} 同时出现在 specs[]（已落地登记）和 pendingSpecs[]（已识别未落地）。` +
        `一份规范不能既是已落地又是未落地。`,
    );
  }
}

// ── 兼容矩阵：每份已落地 spec 都必须有升级策略 ──────────────────────────────
if (existsSync(MATRIX_PATH)) {
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
  } catch (e) {
    err(`兼容矩阵不是合法 JSON：${e.message}`);
    matrix = null;
  }
  if (matrix) {
    const ruled = new Set((matrix.rules ?? []).map((r) => r.spec));
    for (const s of specs) {
      if (!ruled.has(s.id)) {
        err(
          `兼容矩阵缺 ${s.id} 的升级策略。` +
            `每份已落地规范都必须写清「升 major 的条件」—— 否则 Phase 2 改 schema 时没人知道约束。`,
        );
      }
    }
    // 矩阵里指向未登记 spec 的规则
    for (const r of matrix.rules ?? []) {
      if (!specs.some((x) => x.id === r.spec) && !pendingIds.has(r.spec)) {
        err(`兼容矩阵的 rules 里有 "${r.spec}"，但它既不在 specs[] 也不在 pendingSpecs[]`);
      }
    }
  }
} else {
  warn(`docs/specs/compatibility-matrix.json 不存在 —— 升级策略无声明载体（Phase 3 组 1-A 交付物）`);
}

// ── L0 frozen 不变量：不得被 spec 重定义 ────────────────────────────────────
const L0_PATH = join(REPO_ROOT, 'docs', 'l0-frozen-baseline.json');
if (existsSync(L0_PATH)) {
  const l0 = JSON.parse(readFileSync(L0_PATH, 'utf8'));
  const frozenEnumCount = Array.isArray(l0.units) ? l0.units.length : null;
  if (frozenEnumCount !== null) {
    // 只做存在性提示：完整的 FROZEN 枚举比对属 check-l0-frozen 的职责，不重复实现
    notes.push(`L0-frozen baseline 存在（${frozenEnumCount} 个 unit）—— 枚举级校验由 check-l0-frozen 负责`);
  }
} else {
  warn('docs/l0-frozen-baseline.json 不存在 —— 无法校验「spec 不得重定义 L0-frozen 字段」这条不变量');
}

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log('[check-spec-consistency] 协议一致性检查');
console.log(`  规范 ${specs.length} 份 · 磁盘文件 ${onDisk.length} 个 · 已识别未落地 ${pendingIds.size} 份`);

const byStatus = {};
for (const s of specs) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
console.log(
  `  status 分布：${Object.entries(byStatus)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ')}`,
);
if ((byStatus.ACTIVE ?? 0) === 0 && specs.length > 0) {
  notes.push(
    '⚠️ 当前无任何 ACTIVE 规范。' +
      '如实反映现状（三份规范都是「已定规范、未落地能力」），不是门禁失败。',
  );
}

for (const n of notes) console.log(`  · ${n}`);
if (warns.length > 0) {
  console.log(`\n  WARN ${warns.length} 处：`);
  for (const w of warns) console.log(`    ~ ${w}`);
}
if (errors.length > 0) {
  console.error(`\n  ❌ ERROR ${errors.length} 处：`);
  for (const e of errors) console.error(`    ✗ ${e}`);
  console.error('\n⇒ 修法：跑 `node bin/build-spec-index.mjs` 重新生成索引；' +
    '若 ERROR 是「孤儿规范」，说明新增规范忘了登记。');
  process.exit(1);
}
console.log('\n  ✅ 0 ERROR');
process.exit(0);
