/**
 * agint-upstream-watch 单元测试。
 *
 * 全部离线：不碰网络、不碰 dsh 安装位、不碰真实存储。
 * 需要联网的验收（真实拉 tarball 比对）在 `docs/upstream-watch.md` §7 里作为手工项。
 *
 * ⛔ 每个关键判据都配**阴性对照**（negative control）：只证明「该绿的绿了」不够，
 *    还要证明「该红的会红」。否则判据写错了也看不出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  normalizeTag, parseVersion, compareVersion, classifyLevel,
  preStage, preStageChange, pickLatest,
} from '../lib/version.js';
import { extractTextFiles, extractApiSurface } from '../lib/tarball.js';
import { extractApiSymbols, diffSurface } from '../lib/depface.js';
import { parseReleaseBody, summarizeFacts } from '../lib/facts.js';
import { extractJson, validateVerdict } from '../lib/judge.js';

// ── 测试夹具：手写最小 tar 条目 ────────────────────────────────────────────
function tarEntry(name, content, typeflag = '0') {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('000644 \0', 100, 8);
  header.write('0000000 \0', 108, 8);
  header.write('0000000 \0', 116, 8);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  header.write('00000000000\0', 136, 12);
  header.write('        ', 148, 8);
  header.write(typeflag, 156, 1);
  header.write('ustar  \0', 257, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, pad]);
}

function makeTgz(entries) {
  const body = Buffer.concat([
    ...entries.map(([n, c]) => tarEntry(n, c)),
    Buffer.alloc(1024, 0), // 结束块
  ]);
  return gzipSync(body);
}

// ── version.js ─────────────────────────────────────────────────────────────

test('normalizeTag 剥 dsh-v 前缀', () => {
  assert.equal(normalizeTag('dsh-v0.2.2-alpha.2'), '0.2.2-alpha.2');
  assert.equal(normalizeTag('v1.2.3'), '1.2.3');
  assert.equal(normalizeTag('0.2.1-rc.3'), '0.2.1-rc.3');
});

test('parseVersion：合法/非法分明，非法返回 null 而非 0.0.0', () => {
  const v = parseVersion('0.2.2-alpha.2');
  assert.deepEqual([v.major, v.minor, v.patch], [0, 2, 2]);
  assert.deepEqual(v.pre, ['alpha', 2]);
  assert.equal(v.isPrerelease, true);

  // 阴性对照：解析失败不能伪造成 0.0.0
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('1.2.3.4'), null);
});

test('compareVersion 遵循 semver §11', () => {
  assert.equal(compareVersion('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersion('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersion('1.0.0', '1.0.0-alpha'), 1);
  assert.equal(compareVersion('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersion('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  // 数字段 < 字符串段
  assert.equal(compareVersion('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersion('0.2.1', '0.2.2'), -1);
});

test('compareVersion 解析失败要抛，不能静默返回 0', () => {
  assert.throws(() => compareVersion('bad', '1.0.0'), /无法解析/);
  assert.throws(() => compareVersion('1.0.0', 'bad'), /无法解析/);
});

test('classifyLevel 分档', () => {
  assert.equal(classifyLevel('0.2.1-rc.3', '0.2.2-alpha.2'), 'patch');
  assert.equal(classifyLevel('0.2.1-rc.3', '0.2.1-rc.4'), 'prerelease');
  assert.equal(classifyLevel('0.2.1', '0.3.0'), 'minor');
  assert.equal(classifyLevel('0.2.1', '1.0.0'), 'major');
  assert.equal(classifyLevel('1.0.0', '1.0.0'), 'same');
  assert.equal(classifyLevel('1.0.0', '0.9.0'), 'downgrade');
  assert.equal(classifyLevel('bad', '1.0.0'), 'unknown');
});

test('preStageChange 抓得到「版本前进但阶段倒退」', () => {
  // 2026-10-28 实况：本机 rc.3，最新 alpha.2 —— 版本号涨了，成熟度退了
  assert.equal(preStageChange('0.2.1-rc.3', '0.2.2-alpha.2'), 'regressed');
  assert.equal(preStage('0.2.2-alpha.2'), 'alpha');
  assert.equal(preStage('0.2.1-rc.3'), 'rc');
  // 阴性对照：同阶段不算倒退
  assert.equal(preStageChange('0.2.1-rc.3', '0.2.1-rc.4'), 'same');
  // 预发布 → 正式版是前进
  assert.equal(preStageChange('0.2.1-rc.3', '0.2.1'), 'advanced');
});

test('pickLatest 按 semver 而非字符串排序', () => {
  // 字符串序会把 0.2.1-alpha 排在 0.2.1 后面；semver 认为正式版更大
  assert.equal(pickLatest(['0.2.1-alpha.5', '0.2.1', '0.2.1-rc.4']), '0.2.1');
  assert.equal(pickLatest([]), null);
});

// ── tarball.js ─────────────────────────────────────────────────────────────

test('extractTextFiles 能取出文件内容', () => {
  const gz = makeTgz([
    ['package/lib/types/a.d.ts', 'export declare const A = 1;'],
    ['package/lib/index.js', 'export const B = 2;'],
  ]);
  const all = extractTextFiles(gz, () => true);
  assert.equal(all.size, 2);
  assert.match(all.get('package/lib/types/a.d.ts'), /export declare const A/);
});

test('extractTextFiles 的 filter 生效（不匹配的不解码）', () => {
  const gz = makeTgz([
    ['package/lib/types/a.d.ts', 'AAA'],
    ['package/readme.md', 'BBB'],
  ]);
  const onlyDts = extractTextFiles(gz, (p) => p.endsWith('.d.ts'));
  assert.equal(onlyDts.size, 1);
  assert.ok(onlyDts.has('package/lib/types/a.d.ts'));
});

test('extractApiSurface 只取类型定义/入口/package.json', () => {
  const gz = makeTgz([
    ['package/lib/types/x.d.ts', 'export declare const X = 1;'],
    ['package/lib/other/deep.js', 'ignore me'],
    ['package/lib/index.js', 'export {};'],
    ['package/package.json', '{}'],
    ['package/README.md', 'docs'],
  ]);
  const got = extractApiSurface(gz);
  assert.equal(got.size, 3, `实际: ${[...got.keys()].join(',')}`);
  assert.ok(got.has('package/lib/types/x.d.ts'));
  assert.ok(got.has('package/lib/index.js'));
  assert.ok(!got.has('package/lib/other/deep.js'));
});

test('阴性对照：坏数据不抛，返回空', () => {
  assert.equal(extractApiSurface(Buffer.from('not gzip')).size, 0);
  assert.equal(extractApiSurface(Buffer.alloc(0)).size, 0);
});

// ── depface.js：符号提取与比对 ─────────────────────────────────────────────

test('extractApiSymbols 抽 decl / ref / member 三类', () => {
  const dts = [
    'export declare function foo(a: string): void;',
    'export interface Svc {',
    '  register(def: Def): void;',
    '  readonly count?: number;',
    '}',
    'export { bar, baz as qux };',
  ].join('\n');
  const syms = extractApiSymbols(dts);
  assert.equal(syms.get('foo').kind, 'decl');
  assert.equal(syms.get('Svc').kind, 'decl');
  assert.equal(syms.get('Svc.register').kind, 'member');
  assert.equal(syms.get('bar').kind, 'ref');
  assert.equal(syms.get('qux').kind, 'ref', 'as 之后的名字才是导出名');
});

test('extractApiSymbols 支持跨行 export 块', () => {
  const dts = [
    'export {',
    '  type Alpha,',
    '  Beta,',
    '  gamma as Delta,',
    "} from './x.ts';",
  ].join('\n');
  const syms = extractApiSymbols(dts);
  assert.ok(syms.has('Alpha'));
  assert.ok(syms.has('Beta'));
  assert.ok(syms.has('Delta'));
  assert.ok(!syms.has('gamma'), '别名后不该留原名');
});

test('extractApiSymbols 抹掉 const 的初始化值', () => {
  const a = extractApiSymbols('export declare const CODE = "ABORTED";');
  const b = extractApiSymbols('export declare const CODE = "OTHER";');
  assert.equal(a.get('CODE').sig, b.get('CODE').sig, '值变化不算签名变化');
});

test('diffSurface：导出被删 ⇒ breaking', () => {
  const oldF = new Map([['lib/types/i.d.ts', 'export declare function gone(): void;\nexport declare function keep(): void;']]);
  const newF = new Map([['lib/types/i.d.ts', 'export declare function keep(): void;']]);
  const d = diffSurface(oldF, newF);
  assert.equal(d.verdict, 'breaking');
  assert.deepEqual(d.removedSymbols, ['gone']);
});

test('diffSurface：新增可选参 ⇒ additive（不是 breaking）', () => {
  // 2026-10-28 的真实形状：register(def) → register(def, options?)
  const oldF = new Map([['lib/types/i.d.ts', [
    'export interface Tools {',
    '  register(definition: ToolDefinition): () => void;',
    '}',
  ].join('\n')]]);
  const newF = new Map([['lib/types/i.d.ts', [
    'export interface Tools {',
    '  register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void;',
    '}',
  ].join('\n')]]);
  const d = diffSurface(oldF, newF);
  assert.equal(d.verdict, 'additive');
  assert.equal(d.changedSignatures.length, 0, '变宽不能进 changedSignatures');
  assert.equal(d.widenedSignatures.length, 1);
  assert.equal(d.widenedSignatures[0].name, 'Tools.register');
});

test('diffSurface：签名收窄 ⇒ breaking', () => {
  const oldF = new Map([['lib/types/i.d.ts', 'export interface T {\n  run(a: string, b?: number): void;\n}']]);
  const newF = new Map([['lib/types/i.d.ts', 'export interface T {\n  run(a: string): void;\n}']]);
  const d = diffSurface(oldF, newF);
  assert.equal(d.verdict, 'breaking');
  assert.equal(d.changedSignatures[0].name, 'T.run');
});

test('diffSurface：ref 与 decl 混用不算变化（阴性对照）', () => {
  // 同一个符号：旧版声明式，新版汇总再导出。语义相同，不能报 breaking
  const oldF = new Map([['lib/types/a.d.ts', 'export declare const TOOL_ABORTED = "ABORTED";']]);
  const newF = new Map([['lib/index.js', 'export { TOOL_ABORTED };']]);
  const d = diffSurface(oldF, newF);
  assert.equal(d.verdict, 'compatible');
  assert.equal(d.changedSignatures.length, 0);
});

test('diffSurface：任一侧为空 ⇒ unknown，不是 compatible', () => {
  assert.equal(diffSurface(new Map(), new Map([['a.d.ts', 'export const A=1;']])).verdict, 'unknown');
  assert.equal(diffSurface(new Map([['a.d.ts', 'export const A=1;']]), new Map()).verdict, 'unknown');
});

// ── facts.js ───────────────────────────────────────────────────────────────

test('parseReleaseBody 只算中文段，不重复计数', () => {
  const body = [
    '<h3 id="cn-x">新增功能</h3>',
    '- 条目一 新增能力',
    '- 条目二 修复问题',
    '<h3 id="en-x">New Features</h3>',
    '- entry one',
    '- entry two',
  ].join('\n');
  const r = parseReleaseBody(body);
  assert.equal(r.entryCount, 2, '英文段必须被切掉');
  assert.equal(r.sectionCount, 1);
});

test('parseReleaseBody：单小节平铺也能按内容打标', () => {
  // 0.2.2-alpha.2 的真实形状：一个 h3 装下所有条目
  const body = [
    '<h3 id="cn-x">新增功能</h3>',
    '- 新增实验性插件 A',
    '- 修复关闭应用时权限意外变化',
    '- DSH 最低 Node.js 版本提高至 24.9',
  ].join('\n');
  const r = parseReleaseBody(body);
  assert.equal(r.entryCount, 3);
  assert.equal(r.sections.feature, 3, '分节统计会全归一类 —— 这正是它不可当主指标的原因');
  assert.equal(r.breakingHits, 1);
  assert.ok(r.tagCounts.breaking >= 1);
  assert.ok(r.tagCounts.feature >= 1);
  assert.ok(r.tagCounts.fix >= 1);
});

test('summarizeFacts 只陈述数字，不下判断', () => {
  const facts = {
    installedVersion: '0.2.1-rc.3',
    targetVersion: '0.2.2-alpha.2',
    level: 'patch',
    preStageChange: 'regressed',
    body: { entryCount: 116, breakingHits: 7, tagCounts: { breaking: 7, feature: 60 } },
    impactSummary: { breaking: 0, elsewhere: 1, additive: 2, unknown: 0 },
  };
  const s = summarizeFacts(facts);
  assert.match(s, /0\.2\.1-rc\.3/);
  assert.match(s, /发布阶段倒退/);
  assert.match(s, /影响 AGINT 0 个包/);
  assert.doesNotMatch(s, /建议|严重|必须/, '事实摘要里不许出现判断词');
});

// ── judge.js ───────────────────────────────────────────────────────────────

test('extractJson 支持裸对象 / fenced / 文本夹杂', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('前置说明 {"a":1} 后置'), { a: 1 });
  assert.equal(extractJson('没有 json'), null);
  assert.equal(extractJson(null), null);
});

test('validateVerdict 接受合法结论', () => {
  const ok = {
    verdict: 'gap',
    confidence: 0.8,
    headline: '上游提供了 AGINT 自建的能力',
    rationale: 'facts 显示 dsh-tools 新增 X，而 AGINT 仍在自建',
    proposals: [{ title: 't', body: 'b', category: 'service' }],
  };
  assert.equal(validateVerdict(ok), null);
});

test('validateVerdict 拒绝不合规结论（阴性对照）', () => {
  const base = {
    verdict: 'gap', confidence: 0.8, headline: 'h', rationale: 'r', proposals: [],
  };
  assert.match(validateVerdict({ ...base, verdict: 'maybe' }), /verdict/);
  assert.match(validateVerdict({ ...base, headline: '' }), /headline/);
  assert.match(validateVerdict({ ...base, confidence: 1.5 }), /confidence/);
  assert.match(validateVerdict({ ...base, proposals: 'nope' }), /proposals/);
  assert.match(validateVerdict({ ...base, proposals: [{}] }), /title/);
  assert.match(
    validateVerdict({ ...base, proposals: [{ title: 't', body: 'b', category: 'nope' }] }),
    /category/,
  );
  assert.match(validateVerdict(null), /not an object/);
});

test('validateVerdict 允许空提案（宁可空不凑数）', () => {
  const ok = {
    verdict: 'no-impact', confidence: 0.9, headline: 'h', rationale: 'r', proposals: [],
  };
  assert.equal(validateVerdict(ok), null);
});
