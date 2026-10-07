/**
 * cron 运行状态记账：失败不许落成 ok（2026-10-07 假绿事故）。
 *
 * 为什么需要测这个：生产存储 DSH_HOME/storages/agint_cron.json 的
 * cron_state['skill-autocreate-aggregate'] 同一��记录里写着
 *   lastResult = 'ok'
 *   lastError  = "EPERM: operation not permitted, rename ...agint_skill_autocreate.json"
 * 而 cron_health 报 healthy。根因：runOne 的 catch 分支只写 job.lastError，
 * 不清上一次成功留下的 job.lastResult；落盘时两个字段各写各的，
 * 读侧 list() 的 lastOk 又先判 lastResult —— 于是一轮真实失败被记成成功。
 *
 * 这里盯的是**行为**，不是字符串：把 runOne / persistJobState 从模块里
 * 源码提取出来，用 new Function 构造自包含环境后真跑一遍。
 * 断言常量或断言源码文本都证明不了本 bug —— 本 bug 就是「文本看着对，跑起来错」。
 *
 * 四条判据（每条都有正例 + 负例，防"永远有信号"的反向失明）：
 *   1. action 成功 → lastResult 有值、lastError 为 null、落盘 lastResult='ok'
 *   2. action 抛错 → lastResult 必须被清成 null（回归点，删掉这行本测试变红）
 *   3. 落盘时 lastError 优先：失败轮 lastResult 落 'error' 而非 'ok'
 *   4. list() 的 lastOk 错误优先：有 lastError 一律 false
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CRON_LIB = join(HERE, '..', 'lib', 'index.js');
const src = readFileSync(CRON_LIB, 'utf8');

/**
 * 从源码里提取一个具名函数，跳过注释与字符串字面量再配平花括号。
 * 跳过是必需的：函数体内的注释会随修复不断增补，里面出现一个 `{`
 * 就会让朴素的配平计数提前归零，测试报"找不到函数"而不是报真 bug。
 */
function extractFunction(source, header) {
  const start = source.indexOf(header);
  assert.ok(start > 0, `找不到 ${header} —— 改它之前先确认签名没变`);
  const bodyStart = source.indexOf('{', start);
  assert.ok(bodyStart > 0, `${header} 找不到函数体起点`);

  let depth = 0;
  let i = bodyStart;
  let inLine = false;
  let inBlock = false;
  let quote = null;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (c === '\n') inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
      i++;
      continue;
    }
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
    i++;
  }
  throw new Error(`${header} 花括号配平失败 —— 源码可能被改坏`);
}

const runOneSrc = extractFunction(src, 'async function runOne(');
const persistSrc = extractFunction(src, 'async function persistJobState(');
const listBodySrc = extractFunction(src, 'list() {');

// 摘要走真实现（照抄 summary-channel.test.mjs 的提取法）——桩摘要会让
// "成功轮摘要照常落盘" 这条判据变成自证，测不出 persistJobState 有没有接线。
const SUMMARY_MAX_BYTES = 2000;
const PREVIEW_MAX = 10;
const summarizeResult = new Function(
  'SUMMARY_MAX_BYTES', 'PREVIEW_MAX', `return (${extractFunction(src, 'function summarizeResult(')});`,
)(SUMMARY_MAX_BYTES, PREVIEW_MAX);

const silentConsole = { error() {}, log() {}, info() {}, warn() {} };

/** 造一个能真跑起来的 runOne：services / persistJobState / console 都是注入的。 */
function makeRunOne({ onPersist } = {}) {
  const persistJobState = new Function('stateTable', 'summarizeResult', `return (${persistSrc});`)(
    async () => ({ put: async () => {} }),
    summarizeResult,
  );
  return new Function('services', 'persistJobState', 'console', `return (${runOneSrc});`)(
    () => ({}),
    onPersist || persistJobState,
    silentConsole,
  );
}

const mkJob = (action) => ({
  id: 'probe-job',
  action,
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  lastResultSummary: null,
});

describe('cron runOne · 失败必须清掉 lastResult', () => {
  test('负例：action 抛错后 lastResult 不得残留上一轮的成功值', async () => {
    const job = mkJob(async () => { throw new Error('EPERM: rename denied'); });
    // 预置一次"上一轮成功"——本 bug 的触发条件正是这个残留值
    job.lastResult = { ok: true, startedAt: '2026-10-06T21:00:00.000Z', result: { skipped: false } };

    await makeRunOne()(job);

    assert.equal(job.lastError?.message, 'EPERM: rename denied', '失败必须留下 lastError');
    assert.equal(
      job.lastResult, null,
      '失败后 lastResult 必须是 null；留在这里就会让落盘写出 lastResult=ok + lastError=EPERM',
    );
    assert.equal(job.lastResultSummary, null, '失败轮不得留上一轮的结果摘要');
    assert.equal(job.running, false, 'finally 必须复位 running');
  });

  test('正例：action 成功时 lastResult 有值、lastError 被清空', async () => {
    const job = mkJob(async () => ({ scanned: 3, candidatesCreated: 1 }));
    job.lastError = { message: '上一次失败残留' };

    await makeRunOne()(job);

    assert.equal(job.lastError, null, '成功必须清掉上一轮的 lastError');
    assert.equal(job.lastResult?.ok, true, '成功必须写 lastResult');
    assert.equal(job.lastResult?.result.candidatesCreated, 1, 'lastResult 必须带上真实返回值');
  });
});

describe('cron persistJobState · lastError 优先于 lastResult', () => {
  const buildPersist = () =>
    new Function('stateTable', 'summarizeResult', `return (${persistSrc});`);
  const capture = () => {
    const writes = [];
    return { writes, table: async () => ({ put: async (k, v) => writes.push(v) }) };
  };

  test('失败轮落 lastResult=\'error\'，绝不落 \'ok\'', async () => {
    const { writes, table } = capture();
    const persist = buildPersist()(table, summarizeResult);

    await persist({
      id: 'skill-autocreate-aggregate',
      lastRunAt: 1_757_202_936_425,
      // 内存里两者意外并存（存量脏数据 hydrate 进来的形状）
      lastResult: { ok: true, restored: true },
      lastError: { message: 'EPERM: operation not permitted, rename ...' },
      lastResultSummary: '{"stale":true}',
    });

    assert.equal(writes.length, 1, 'persistJobState 必须写且只写一条');
    assert.equal(
      writes[0].lastResult, 'error',
      '有 lastError 时 lastResult 必须落 error；落 ok 就是本 bug 的落盘形态',
    );
    assert.match(writes[0].lastError, /^EPERM/, 'lastError 原文必须落盘，便于事后取证');
    assert.equal(writes[0].lastResultSummary, null, '失败轮不得落上一轮的摘要');
  });

  test('成功轮仍落 lastResult=\'ok\'，摘要照搬（不回退）', async () => {
    const { writes, table } = capture();
    const persist = buildPersist()(table, summarizeResult);

    await persist({
      id: 'oracle-daily',
      lastRunAt: 1_757_202_936_425,
      lastResult: { ok: true, result: { score: 98.8 } },
      lastError: null,
      lastResultSummary: null,
    });

    assert.equal(writes[0].lastResult, 'ok', '成功轮行为不变');
    assert.equal(writes[0].lastError, null);
    assert.equal(JSON.parse(writes[0].lastResultSummary).score, 98.8, '成功轮摘要照常落盘');
  });

  test('从未跑过的 job 落 lastResult=null（不凭空造 error）', async () => {
    const { writes, table } = capture();
    const persist = buildPersist()(table, summarizeResult);

    await persist({ id: 'never-run', lastRunAt: null, lastResult: null, lastError: null, lastResultSummary: null });

    assert.equal(writes[0].lastResult, null, '没跑过就是 null，不许写 error');
    assert.equal(writes[0].lastError, null);
  });
});

describe('cron list() · lastOk 错误优先', () => {
  test('lastError 与 lastResult 并存时 lastOk 必须是 false', () => {
    // 判据落在读侧出口：即便内存里两者并存（存量 hydrate 路径），lastOk 也不许报 true
    assert.match(
      listBodySrc,
      /lastOk:\s*j\.lastError\s*\?\s*false\s*:/,
      'list() 的 lastOk 必须先判 lastError —— 先判 lastResult 会被残留成功值盖住',
    );
  });
});
