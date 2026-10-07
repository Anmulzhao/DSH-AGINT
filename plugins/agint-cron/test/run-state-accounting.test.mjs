/**
 * cron 运行状态记账：失败不许落成 ok（2026-10-07 假绿事故）。
 *
 * 为什么需要测这个：生产存储 DSH_HOME/storages/agint_cron.json 的
 * cron_state['skill-autocreate-aggregate'] 同一条记录里写着
 *   lastResult = 'ok'
 *   lastError  = "EPERM: operation not permitted, rename ...agint_skill_autocreate.json"
 * 而 cron_health 报 healthy。根因：runOne 的 catch 分支只写 job.lastError，
 * 不清上一次成功留下的 job.lastResult；落盘时两个字段各写各的，
 * 读侧 list() 的 lastOk 又先判 lastResult —— 于是一轮真实失败被记成成功。
 *
 * 这里盯的是**行为**，不是字符串：把 runOne / persistJobState / health 从模块里
 * 源码提取出来，用 new Function 构造自包含环境后真跑一遍。
 * 断言常量或断言源码文本都证明不了本 bug —— 本 bug 就是「文本看着对，跑起来错」。
 *
 * 第一组判据（落盘记账，每条都有正例 + 负例，防"永远有信号"的反向失明）：
 *   1. action 成功 → lastResult 有值、lastError 为 null、落盘 lastResult='ok'
 *   2. action 抛错 → lastResult 必须被清成 null（回归点，删掉这行本测试变红）
 *   3. 落盘时 lastError 优先：失败轮 lastResult 落 'error' 而非 'ok'
 *   4. list() 的 lastOk 错误优先：有 lastError 一律 false
 *
 * 第二组判据（health() 的 failures 通道 —— 老板 2026-10-07 拍板「只报不拦」）：
 *   5. 上轮失败的 job 进 failures，**不进 issues** —— healthy 语义不许被改
 *   6. 每个 job 的 status 带自己的 lastError
 *   7. 工具面 render 必须消费 failures（接了不消费 = 新的观测侧假绿）
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
// `health() {…}` 是对象方法简写，提取出来不能直接当表达式求值 —— 加 `function ` 前缀
// 变成具名函数表达式，`return (function health(){…})` 才合法（方法简写会 SyntaxError）。
const healthSrc = 'function ' + extractFunction(src, 'health() {');
const toolsSrc = readFileSync(join(HERE, '..', 'lib', 'tools.js'), 'utf8');

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

/**
 * health() 依赖闭包里的 jobs / bootTime / nextFire，三样都注入。
 *
 * nextFire 是可控的：它返回 `lastRunAt + offsetMs`。
 *   offset = +3h ⇒ expected 在未来 ⇒ overdueMs = 0 ⇒ 不 stale
 *   offset = -3h ⇒ expected 在 3 小时前 ⇒ overdueMs 远大于 windowMs*0.5 ⇒ stale
 * jobs 上挂一个 __staleOffsetMs 就能逐 case 切换。
 */
const HOUR = 3_600_000;

function makeHealth(jobs) {
  return new Function('jobs', 'bootTime', 'nextFire', `return (${healthSrc});`)(
    jobs,
    Date.now() - 10 * HOUR,
    (_parsed, from) => new Date(from.getTime() + (jobs.__staleOffsetMs ?? 3 * HOUR)),
  );
}

describe('cron health() · failures 通道（只报不拦）', () => {
  test('上轮失败的 job 进 failures，且 healthy 仍为 true', () => {
    const jobs = [
      { id: 'ok-job', lastRunAt: Date.now() - 2 * HOUR, lastError: null },
      { id: 'bad-job', lastRunAt: Date.now() - 2 * HOUR, lastError: { message: 'EPERM: rename denied' } },
    ];
    const h = makeHealth(jobs)();

    assert.equal(h.failures.length, 1, '失败 job 必须被报出来');
    assert.equal(h.failures[0].id, 'bad-job');
    assert.match(h.failures[0].reason, /EPERM/, '失败原因原文必须透传，不能只剩一个 flag');
    assert.equal(
      h.healthy, true,
      'healthy 只看调度时效（issues），不许被失败判据改写——老板 2026-10-07 拍板「只报不拦」',
    );
  });

  test('失败 job 不进 issues（否则 healthy 会被连带改写）', () => {
    const jobs = [{ id: 'bad-job', lastRunAt: Date.now() - 2 * HOUR, lastError: { message: 'boom' } }];
    const h = makeHealth(jobs)();

    assert.equal(
      h.issues.length, 0,
      '失败不是调度问题，不许混进 issues——issues.length===0 直接决定 healthy',
    );
  });

  test('失败与逾期同时发生：issues 装逾期、failures 装失败，healthy=false 归因于逾期', () => {
    const jobs = [
      { id: 'bad-and-late', lastRunAt: Date.now() - 2 * HOUR, lastError: { message: 'boom' } },
    ];
    // nextFire 返回「比上次运行早 3 小时」⇒ overdueMs 远超 windowMs*0.5 ⇒ stale
    jobs.__staleOffsetMs = -3 * HOUR;
    const h = makeHealth(jobs)();

    assert.equal(h.failures.length, 1, '失败仍要报');
    assert.equal(h.failures[0].id, 'bad-and-late');
    assert.equal(h.issues.length, 1, '逾期照旧进 issues');
    assert.equal(h.healthy, false, '这次不健康的原因是逾期，不是失败');
  });

  test('每个 job 的 status 带自己的 lastError（工具面不必反查）', () => {
    const jobs = [
      { id: 'ok-job', lastRunAt: Date.now() - 2 * HOUR, lastError: null },
      { id: 'bad-job', lastRunAt: Date.now() - 2 * HOUR, lastError: { message: 'boom' } },
    ];
    const h = makeHealth(jobs)();

    const byId = Object.fromEntries(h.jobs.map((j) => [j.id, j]));
    assert.equal(byId['ok-job'].lastError, null, '成功 job 的 lastError 必须是 null 而不是 undefined');
    assert.equal(byId['bad-job'].lastError, 'boom');
  });

  test('正例：全成功时 failures 是空数组（不是 null、不是缺字段）', () => {
    const jobs = [{ id: 'ok-job', lastRunAt: Date.now() - 2 * HOUR, lastError: null }];
    const h = makeHealth(jobs)();

    assert.deepEqual(h.failures, [], '无失败时必须给空数组，工具面才能无条件 forEach');
  });
});

describe('cron_health 工具面 · 必须消费 failures', () => {
  test('render 读 failures 并渲染（接了不消费 = 新的观测侧假绿）', () => {
    assert.match(toolsSrc, /h\.failures/, 'render 必须读 h.failures，否则 health() 加的通道在工具面看不见');
    assert.match(toolsSrc, /h\.healthy/, 'render 必须继续显示 healthy（只报不拦口径的另一半）');
  });

  test('render 不许把 failures 并进 healthy 的措辞', () => {
    // 「healthy」与「N 个 job 上轮失败」要并排出现，但 healthy 的取值不许被 failures 决定
    assert.doesNotMatch(
      toolsSrc,
      /healthy[^\n]*\?\s*['"]healthy['"]\s*:\s*[^\n]*failures/,
      'healthy 的三元表达式里不得出现 failures —— 那等于「失败即不健康」，越过老板拍板的口径',
    );
  });
});
