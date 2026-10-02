// bin/lib/canonical-json.test.mjs — 规范化序列化（hash 确定性）的测试
//
// 这个文件存在的理由不是「覆盖率高」，而是设计 §6.4 点名的那条风险：
//   「hash 跨环境不一致（Windows 生成 / ubuntu 校验）— 概率中 / 影响高 —
//    出现假 FROZEN_TAMPERED 告警，门禁失去信任」
//
// 门禁一旦误报，人就会习惯性忽略它 —— 那时候它比不存在更糟（它让人以为
// 有人看着）。所以这里除了常规用例，还钉了一个 **golden hash 向量**：
// 固定输入 → 固定 64 hex。ubuntu 上跑出别的值，就是这个模块坏了，
// 不用等到 Sprint 19 做跨环境联调才发现。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(join(__dirname, 'canonical-json.mjs')).href);

// ── 1. 确定性核心 ──────────────────────────────────────────────────────────
test('key 插入顺序不同 ⇒ 序列化结果必须相同（这是本模块存在的唯一理由）', () => {
  const a = { z: 1, a: 2, m: 3 };
  const b = { m: 3, z: 1, a: 2 };
  assert.equal(m.canonicalStringify(a), m.canonicalStringify(b));
  assert.equal(m.canonicalHash(a), m.canonicalHash(b));
});

test('嵌套对象递归排序（不只是顶层）', () => {
  const a = { outer: { z: 1, a: { d: 4, b: 5 } }, x: 0 };
  const b = { x: 0, outer: { a: { b: 5, d: 4 }, z: 1 } };
  assert.equal(m.canonicalStringify(a), m.canonicalStringify(b));
});

test('数组保持顺序 —— 数组是有序结构，排序会改变语义', () => {
  assert.equal(m.canonicalStringify([3, 1, 2]), '[3,1,2]');
  assert.notEqual(m.canonicalStringify([3, 1, 2]), m.canonicalStringify([1, 2, 3]));
});

test('golden 向量：固定输入必须产出固定 hex（跨环境基线）', () => {
  const golden = {
    scenario: 'FROZEN-memory-disambiguation-01',
    plugin: 'agint-memory',
    domain: 'memory',
    kind: 'integration',
    tags: ['frozen', 'memory'],
    nested: { z: 1, a: { d: 4, b: 5 } },
    n: 1.0,
    cn: '中文内容',
  };
  assert.equal(
    m.canonicalHash(golden),
    '495eedb673defab9c2f913f4f87377c0db615168d59dd8cc819b0e25c555af3e',
    'golden hash 变了 = 序列化规则变了 = 所有已落盘的 frozen manifest 需要重新生成',
  );
  assert.equal(m.canonicalStringify(golden), '{"cn":"中文内容","domain":"memory","kind":"integration","n":1,"nested":{"a":{"b":5,"d":4},"z":1},"plugin":"agint-memory","scenario":"FROZEN-memory-disambiguation-01","tags":["frozen","memory"]}');
});

// ── 2. 数字与字符串 ────────────────────────────────────────────────────────
test('数字不补零：1.0 与 1 必须序列化成同一个 "1"', () => {
  assert.equal(m.canonicalStringify({ n: 1.0 }), '{"n":1}');
  assert.equal(m.canonicalStringify({ n: 1 }), '{"n":1}');
});

test('-0 归一为 0（否则 -0 与 0 会算出两个 hash，纯属噪音）', () => {
  assert.equal(m.canonicalStringify({ n: -0 }), '{"n":0}');
  assert.equal(m.canonicalHash({ n: -0 }), m.canonicalHash({ n: 0 }));
});

test('NaN / Infinity 必须抛错而不是静默变 null —— 那是 hash 碰撞，防篡改场景等于漏检', () => {
  assert.throws(() => m.canonicalStringify({ n: NaN }), TypeError);
  assert.throws(() => m.canonicalStringify({ n: Infinity }), TypeError);
});

test('bigint 必须抛错（JSON 无 bigint 表示，静默降级会丢精度）', () => {
  assert.throws(() => m.canonicalStringify({ n: 10n }), TypeError);
});

test('中文不被 \\u 转义，且两次调用一致', () => {
  const s = m.canonicalStringify({ 内容: '冻结场景' });
  assert.equal(s, '{"内容":"冻结场景"}');
  assert.ok(!s.includes('\\u'), '出现 \\u 转义说明实现改了转义策略，会破坏既有 hash');
});

test('码点序而非 UTF-16 码元序：代理对字符必须排在 U+FFFF 之后', () => {
  // 😀 = U+1F600（代理对 D83D DE00）。按码元序它会排在 U+FFFF 之前，
  // 按码点序应该在之后。这是设计 §3.2.6「按 Unicode 码点字典序」的实证。
  const emoji = '\u{1F600}';
  const high = '\uFFFF';
  const s = m.canonicalStringify({ [emoji]: 1, [high]: 2 });
  assert.ok(s.indexOf(high) < s.indexOf(emoji), `期望 U+FFFF 在前，实际：${s}`);
});

// ── 3. volatile 字段排除 ───────────────────────────────────────────────────
test('默认不排除任何字段 —— 防篡改用途静默丢字段 = 开后门', () => {
  const obj = { generatedAt: 'A', timestamp: 'B', keep: 'C' };
  assert.ok(m.canonicalStringify(obj).includes('generatedAt'));
  assert.ok(m.canonicalStringify(obj).includes('timestamp'));
});

test('excludeKeys 递归生效（嵌套层级也排除）', () => {
  const obj = { generatedAt: 'top', nested: { timestamp: 'deep', keep: 1 } };
  const s = m.canonicalStringify(obj, { excludeKeys: m.DEFAULT_VOLATILE_KEYS });
  assert.ok(!s.includes('generatedAt'));
  assert.ok(!s.includes('timestamp'));
  assert.ok(s.includes('keep'));
});

test('DEFAULT_VOLATILE_KEYS 不含 createdAt —— hypothesisLock 要把 createdAt 算进去（设计 §4.2.4）', () => {
  assert.ok(!m.DEFAULT_VOLATILE_KEYS.includes('createdAt'));
  const obj = { createdAt: '2026-10-02T00:00:00Z', h: 'x' };
  assert.ok(
    m.canonicalStringify(obj, { excludeKeys: m.DEFAULT_VOLATILE_KEYS }).includes('createdAt'),
  );
});

// ── 4. JSON 语义对齐 ───────────────────────────────────────────────────────
test('对象里 undefined 值省略；null 值保留（与 JSON.stringify 语义一致）', () => {
  assert.equal(m.canonicalStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(m.canonicalStringify({ a: null, b: 1 }), '{"a":null,"b":1}');
});

test('顶层 undefined / 数组槽位 undefined 走 null（不崩）', () => {
  assert.equal(m.canonicalStringify([undefined, 1]), '[null,1]');
});

// ── 5. 抗「同一份数据不同来路」─────────────────────────────────────────────
test('经过一次 JSON 往返（key 顺序被打乱）后 hash 仍一致', () => {
  const original = { b: { y: 1, x: [1, 2] }, a: '中文' };
  // 模拟「从文件读出来再 parse」—— parse 不保证保留写入顺序的语义一致性
  const roundTripped = JSON.parse(JSON.stringify({ a: '中文', b: { x: [1, 2], y: 1 } }));
  assert.equal(m.canonicalHash(original), m.canonicalHash(roundTripped));
});

// ── 6. 落盘无 BOM ──────────────────────────────────────────────────────────
test('writeJsonNoBom 落盘的文件无 BOM 且可被 JSON.parse 直接读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canonical-test-'));
  const p = join(dir, 'out.json');
  try {
    m.writeJsonNoBom(p, { 中文: '值', n: 1 });
    const text = readFileSync(p, 'utf8');
    assert.notEqual(text.charCodeAt(0), 0xfeff, '文件带 BOM —— 下游 JSON.parse 会直接拒收（教训 §4）');
    assert.deepEqual(JSON.parse(text), { 中文: '值', n: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7. prefix 与 textHash ──────────────────────────────────────────────────
test('canonicalHash 的 prefix 选项产出 frozen-manifest 要求的 sha256: 前缀', () => {
  const h = m.canonicalHash({ a: 1 }, { prefix: true });
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, `sha256:${m.canonicalHash({ a: 1 })}`);
});

test('textHash 与 canonicalHash 是两条独立通道（文件级 vs 结构级），不可混用', () => {
  const obj = { a: 1 };
  // 结构级 hash 不含缩进；文件级 hash 含缩进 —— 必须不相等，
  // 若相等说明有人把两条通道接反了。
  assert.notEqual(m.textHash(JSON.stringify(obj, null, 2)), m.canonicalHash(obj));
  assert.equal(m.textHash(JSON.stringify(obj)), m.canonicalHash(obj));
});
