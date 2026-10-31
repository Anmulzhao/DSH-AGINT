/**
 * agint-wiki: 工具 execute() **运行时返回值** vs output.schema 一致性守卫。
 *
 * 样板来源：plugins/agint-self-model/test/tool-output-conformance.test.mjs
 * （提案 1255b37a 后续动作第 1 条：「把本文件的模式抄给其余工具模块」）。
 * 样板写死的四条，本文件逐条对应：
 *   ① 每个模块配**该模块真实形状**的 fixture，不得用「对任何服务返回 []」的通用桩；
 *   ② 至少一条**否定对照**：同一 schema 下喂必然违规的值 → 违规数组非空 + assertConforms 抛错；
 *   ③ 正向用例必须走到**非空**分支；
 *   ④ 断言口径固定为 validateJsonSchemaValue(tool.output.schema, await tool.execute(...)) 返回空数组。
 *
 * 本模块的 fixture = **真服务 + 临时 wiki 根目录**：
 *   lib/index.js 的 `agint.wiki` 服务是纯文件系统实现（read/write/list/search/lint），
 *   给它一个空的临时 root 就能跑真逻辑 —— 不接生产存储、不碰生产 wiki 目录。
 *   真实形状的 .md 条目由本测试写进临时 root（这就是 ① 要的「该模块真实形状的 fixture」，
 *   不是通用桩）。
 *
 * Run with: node --test plugins/agint-wiki/test/tool-output-conformance.test.mjs
 *           （cwd = 仓库根 D:\DSH\project源码\DSH-AGINT）
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');
const toolsModule = require('../lib/tools.js');

const EXPECTED_TOOLS = ['wiki_write', 'wiki_read', 'wiki_search', 'wiki_list', 'wiki_lint'];

const tempRoots = [];
after(async () => {
  for (const r of tempRoots) await rm(r, { recursive: true, force: true });
});

/**
 * 起一个**真 Service**（lib/index.js apply），wiki root = 临时目录。
 * 写入的 .md 是真实知识条目的形状（正文 + ⚠️ 标记 + 内部链接），
 * 让 search / list / lint 三个读路径都走到**非空**分支（③：空分支会假绿）。
 */
async function makeWorld() {
  const root = await mkdtemp(join(tmpdir(), 'agint-wiki-conformance-'));
  tempRoots.push(root);

  await mkdir(join(root, 'industry'), { recursive: true });
  await writeFile(
    join(root, 'industry', 'solar.md'),
    '# 光伏\n\n组件价格持续下行，⚠️ 更正：此前口径已过时。\n见 [储能](storage.md)。\n',
    'utf8',
  );
  await writeFile(join(root, 'industry', 'storage.md'), '# 储能\n\n出货量增长。\n', 'utf8');
  await writeFile(join(root, 'README.md'), '# 索引\n\n见 [光伏](industry/solar.md)。\n', 'utf8');

  const provided = new Map();
  const ctx = {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => { provided.set(k, v); },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    on: () => () => {},
    logger: { warn() {}, error() {} },
  };
  plugin.apply(ctx, { root });
  const wiki = ctx.get('agint.wiki');
  assert.ok(wiki, 'agint.wiki 服务未注册 —— 下面的用例全是空转');
  return { root, wiki };
}

/** 捕获 tools.js 注册的 5 个工具（defineTool 产物）。tools.js 用**方括号**取服务。 */
function captureTools(wiki) {
  const registered = [];
  const ctx = { tools: { register: (t) => { registered.push(t); return () => {}; } }, 'agint.wiki': wiki };
  toolsModule.apply(ctx);
  return { tools: Object.fromEntries(registered.map((t) => [t.name, t])), registered };
}

/** host 第二道门的真调用口径：validateJsonSchemaValue 返回**违规数组**（空数组 = 通过）。 */
function violationsOf(tool, value, label) {
  return validateJsonSchemaValue(tool.output.schema, value, `value(${label})`);
}

function assertConforms(tool, value, label) {
  const violations = violationsOf(tool, value, label);
  assert.deepEqual(
    violations,
    [],
    `${label} 过不了 ${tool.name} 的 output schema：\n${violations.join('\n')}`,
  );
}

test('前提自检：5 个 wiki 工具都被捕获，且 output.schema 根是 object', async () => {
  const { wiki } = await makeWorld();
  const { tools, registered } = captureTools(wiki);
  assert.equal(registered.length, EXPECTED_TOOLS.length, `注册工具数 ${registered.length} ≠ 5`);
  for (const name of EXPECTED_TOOLS) assert.ok(tools[name], `缺工具 ${name}`);
  for (const name of EXPECTED_TOOLS) {
    assert.equal(tools[name].output.schema.type, 'object', `${name}.output.schema 根不是 object`);
  }
});

test('否定对照（通用口径）：裸返回数组过不了 object schema —— 护栏不是空转', async () => {
  const { wiki } = await makeWorld();
  const { tools } = captureTools(wiki);

  // 造一个与 wiki_write **同 schema** 的替身，但 execute 裸返回数组
  const bareTool = defineTool({
    name: 'nc_wiki_write_bare_array',
    description: 'negative control: execute() 裸返回数组',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { required: true, type: 'string' } } },
      render: () => [{ type: 'text', text: 'nc' }],
    },
    execute: () => [{ path: 'industry/solar.md' }],
  });

  const raw = await bareTool.execute({});
  assert.ok(Array.isArray(raw), '前提不成立：替身没有裸返回数组');

  const violations = violationsOf(bareTool, raw, 'nc-bare-array');
  assert.ok(violations.length > 0, '护栏空转：裸数组竟然过了 object schema');
  assert.ok(
    violations.some((v) => /must be an object/.test(v)),
    `违规信息里没有 host 的那句 "must be an object"：${JSON.stringify(violations)}`,
  );
  assert.throws(
    () => assertConforms(bareTool, raw, 'nc-bare-array'),
    /must be an object/,
    'assertConforms 对裸数组没有报错：断言被削弱了',
  );

  // 顺带坐实 wiki_write 自己的 schema 也是 object 根（替身与真工具同口径）
  assert.equal(tools.wiki_write.output.schema.type, 'object');
});

test('否定对照（本模块特有）：wiki_write 少 bytes 字段 ⇒ 必然违规', async () => {
  const { wiki } = await makeWorld();
  const { tools } = captureTools(wiki);
  const tool = tools.wiki_write;

  // wiki_write 的 output.schema 把 path/bytes 都列为 required（lib/tools.js:44-47）
  const bad = { path: 'industry/solar.md' };
  const violations = violationsOf(tool, bad, 'write-missing-bytes');
  assert.ok(violations.length > 0, '护栏空转：缺 required 字段竟然合规');
  assert.throws(
    () => assertConforms(tool, bad, 'write-missing-bytes'),
    /schema|bytes|required/i,
    'assertConforms 对缺 required 字段没有报错',
  );
});

test('正向：wiki_write 真写入临时 root，返回 {path, bytes} 过自己的 schema', async () => {
  const { wiki } = await makeWorld();
  const { tools } = captureTools(wiki);

  const value = await tools.wiki_write.execute({ path: 'industry/new-note.md', content: '# 新条目\n\n正文。\n' });
  assert.ok(value && !Array.isArray(value), '工具返回的不是对象');
  assert.equal(value.path, 'industry/new-note.md', 'path 不对：写路径没透传');
  assert.ok(value.bytes > 0, `bytes 非正（${value.bytes}），测不到真形状`);
  assertConforms(tools.wiki_write, value, 'wiki_write');
});

test('正向：wiki_read 读到刚写的条目（entry 非空分支）过自己的 schema', async () => {
  const { wiki } = await makeWorld();
  const { tools } = captureTools(wiki);

  await tools.wiki_write.execute({ path: 'industry/new-note.md', content: '# 新条目\n\n正文。\n' });
  const value = await tools.wiki_read.execute({ path: 'industry/new-note.md' });
  assert.ok(value.entry, 'entry 为空 —— 读路径没走到非空分支');
  assert.equal(value.entry.path, 'industry/new-note.md');
  assert.ok(value.entry.content.includes('新条目'), 'content 不对');
  assertConforms(tools.wiki_read, value, 'wiki_read');
});

test('正向：wiki_search 命中真实条目（results 非空）过自己的 schema', async () => {
  const { wiki } = await makeWorld();
  const { tools } = captureTools(wiki);

  const value = await tools.wiki_search.execute({ query: '光伏' });
  assert.ok(Array.isArray(value.results) && value.results.length > 0, 'results 为空 —— 没走到非空分支');
  const hit = value.results[0];
  assert.equal(typeof hit.path, 'string');
  assert.equal(typeof hit.snippet, 'string');
  assert.equal(typeof hit.line, 'number');
  assertConforms(tools.wiki_search, value, 'wiki_search');
});

test('正向：wiki_list 列出真实条目（entries 非空）过自己的 schema', async () => {
  const { wiki } = await makeWorld();
  const { tools } = captureTools(wiki);

  const value = await tools.wiki_list.execute({});
  assert.ok(Array.isArray(value.entries) && value.entries.length >= 3, `entries 数量异常：${value.entries?.length}`);
  const e = value.entries.find((x) => x.path === 'industry/solar.md');
  assert.ok(e, '没有列出 industry/solar.md');
  assert.ok(e.size > 0, 'size 非正，测不到真形状');
  assert.equal(typeof e.mtime, 'string');
  assertConforms(tools.wiki_list, value, 'wiki_list');
});

test('正向：wiki_lint 产出真实体检报告（report.checked > 0）过自己的 schema', async () => {
  const { wiki } = await makeWorld();
  const { tools } = captureTools(wiki);

  const value = await tools.wiki_lint.execute({});
  const r = value.report;
  assert.ok(r && typeof r === 'object', 'report 不是对象');
  assert.ok(r.checked >= 3, `checked=${r.checked}，没走到非空分支`);
  assert.ok(Array.isArray(r.brokenLinks), 'brokenLinks 不是数组');
  assert.ok(Array.isArray(r.contradictions), 'contradictions 不是数组');
  assert.ok(Array.isArray(r.warnings), 'warnings 不是数组');
  assert.ok(Array.isArray(r.orphans), 'orphans 不是数组');
  // 条目里有 ⚠️ 且带冲突词 ⇒ 真实形状下 contradictions 桶非空
  assert.ok(r.contradictions.length > 0, 'contradictions 为空：fixture 没走到判别分支');
  assertConforms(tools.wiki_lint, value, 'wiki_lint');
});
