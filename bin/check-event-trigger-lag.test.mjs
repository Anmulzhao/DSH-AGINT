/**
 * bin/check-event-trigger-lag.test.mjs —— 终态滞后门禁自测
 *
 * 不读生产存储、不连 3080：全部走导出的纯函数 + 本地临时目录。
 * 锁住四个最容易骗人的点：新旧两种落盘形状、per-record 布局、
 * 时间邻近口径、窗口内零事件不假绿。
 *
 * ⚠️ 2026-11-12 新增：生产事件总线切到 per-record 布局后，旧 single JSON
 *    冻结在迁移水位线。只认旧文件的 check 会「最近 24h 读到 0 条」静默假绿，
 *    故下面专门有一条 main() 端到端用例钉住这个回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectEvents, collectRecordDir, mergeEvents, evaluateLag, parseArgs,
  busStoragePath, recordDirPath, main, loadActivation, ACTIVATION_FILE,
  RECORD_SUBDIR, TRIGGER_TOPIC, TERMINAL_TOPICS, DEFAULT_WINDOW_MIN,
} from './check-event-trigger-lag.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const trigger = (ms) => ({ topic: TRIGGER_TOPIC, occurredAt: at(ms), ts: T0 + ms, payload: { hostEvent: 'skills/change' } });
const done = (ms) => ({ topic: 'curator.run-completed', occurredAt: at(ms), ts: T0 + ms, payload: { dryRun: false } });
const failed = (ms) => ({ topic: 'curator.run-failed', occurredAt: at(ms), ts: T0 + ms, payload: { error: 'EPERM' } });

const withTmp = (fn) => {
  const dir = mkdtempSync(join(HERE, '.lag-test-'));
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const captureMain = (args) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { rc: main(args), lines, text: lines.join('\n') }; }
  finally { console.log = orig; }
};
const writeRecord = (dir, name, envelope) => writeFileSync(
  join(dir, RECORD_SUBDIR, name),
  JSON.stringify({ version: 1, record: { envelope, deliveries: {} } }),
);

test('collectEvents 兼容新旧两种落盘形状（envelope 优先 + 顶层兜底）', () => {
  const raw = {
    tables: {
      events: {
        a: { envelope: { topic: TRIGGER_TOPIC, occurredAt: at(0), payload: {} }, deliveries: {} },
        b: { topic: 'curator.run-completed', occurredAt: at(1000), payload: { dryRun: false } },
      },
    },
  };
  const out = collectEvents(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].topic, TRIGGER_TOPIC);
  assert.equal(out[1].topic, 'curator.run-completed');
  assert.equal(out[0].ts, T0);
});

test('collectEvents 丢弃无 topic / 无时间 / 时间不可解析的脏行，并按时间排序', () => {
  const raw = {
    events: [
      { topic: TRIGGER_TOPIC, occurredAt: at(5000) },
      { topic: TRIGGER_TOPIC },
      { occurredAt: at(0) },
      { topic: 'x.y', occurredAt: 'not-a-date' },
      { topic: 'curator.run-completed', occurredAt: at(1000) },
      null,
      'junk',
    ],
  };
  const out = collectEvents(raw);
  assert.deepEqual(out.map((e) => e.ts), [T0 + 1000, T0 + 5000]);
});

test('collectRecordDir 读 per-record 形状 {version,record}，坏文件计入 errors', () => withTmp((dir) => {
  mkdirSync(join(dir, RECORD_SUBDIR));
  writeRecord(dir, 'a.json', { id: 'a', topic: TRIGGER_TOPIC, occurredAt: at(0), payload: {} });
  writeRecord(dir, 'b.json', { id: 'b', topic: 'curator.run-completed', occurredAt: at(1000), payload: { dryRun: false } });
  writeFileSync(join(dir, RECORD_SUBDIR, 'bad.json'), '{not json');
  const r = collectRecordDir(dir);
  assert.equal(r.available, true);
  assert.equal(r.fileCount, 3);
  assert.equal(r.errors, 1, '单个坏文件要显形，不能静默吞掉');
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].id, 'a');
  assert.equal(r.events[0].topic, TRIGGER_TOPIC);
  assert.equal(r.events[1].ts, T0 + 1000);
}));

test('collectRecordDir 目录不存在 → available:false，不抛异常', () => {
  const r = collectRecordDir(join(HERE, `.lag-missing-${Date.now()}`));
  assert.equal(r.available, false);
  assert.deepEqual(r.events, []);
  assert.ok(r.error);
});

test('mergeEvents 按 envelope.id 去重；无 id 的行一律保留（防漏报假绿）', () => {
  const merged = mergeEvents(
    [{ ...trigger(0), id: 'evt-1' }, { ...done(1000), id: 'evt-2' }],
    [{ ...trigger(0), id: 'evt-1' }],
  );
  assert.equal(merged.length, 2, '迁移重叠的同一条事件只算一次');
  assert.deepEqual(merged.map((e) => e.id), ['evt-1', 'evt-2']);
  assert.equal(
    mergeEvents([trigger(0)], [trigger(0)]).length,
    2,
    '同毫秒同 payload 但取不到 id 时宁可重复计数，也不能误合并 ⇒ 漏报就是假绿',
  );
});

test('窗口内 0 条触发 → NO_TRIGGER_EVENTS，verified=false（不判绿也不判红）', () => {
  const r = evaluateLag([done(1000)], { since: T0, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'NO_TRIGGER_EVENTS');
  assert.equal(r.verified, false);
  assert.equal(r.triggerCount, 0);
  assert.ok(r.attribution.includes('不证明因果关系'), '必须显式写出时间邻近口径，防假绿');
});

test('触发 + 窗口内成功终态 → OK，lagMs 如实', () => {
  const r = evaluateLag([trigger(0), done(90_000)], { since: T0, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'OK');
  assert.equal(r.verified, true);
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].terminalTopic, 'curator.run-completed');
  assert.equal(r.matched[0].lagMs, 90_000);
  assert.equal(r.missing.length, 0);
});

test('触发 + 失败终态也算有终态（§4.2：失败不能静默断链）', () => {
  const r = evaluateLag([trigger(0), failed(60_000)], { since: T0, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'OK');
  assert.equal(r.failedTerminalCount, 1);
  assert.equal(r.matched[0].terminalTopic, 'curator.run-failed');
  assert.ok(TERMINAL_TOPICS.includes('curator.run-failed'));
});

test('终态超出 windowMin → TERMINAL_MISSING，不拿窗口外的记录冒充', () => {
  const r = evaluateLag(
    [trigger(0), done(DEFAULT_WINDOW_MIN * 60_000 + 1)],
    { since: T0, now: T0 + 3600_000 },
  );
  assert.equal(r.verdict, 'TERMINAL_MISSING');
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].triggerAt, at(0));
  assert.equal(r.matched.length, 0);
});

test('终态早于触发 → 不算配对（不能拿上一次周策展顶数）', () => {
  const r = evaluateLag([done(-60_000), trigger(0)], { since: T0 - 3600_000, now: T0 + 3600_000 });
  assert.equal(r.verdict, 'TERMINAL_MISSING');
});

test('部分缺失 → missing 明细逐条可查，matched 只列真配上的', () => {
  const r = evaluateLag(
    [trigger(0), done(60_000), trigger(600_000), trigger(1_200_000)],
    { since: T0, now: T0 + 3600_000 },
  );
  assert.equal(r.verdict, 'TERMINAL_MISSING');
  assert.equal(r.triggerCount, 3);
  assert.equal(r.matched.length, 1);
  assert.equal(r.missing.length, 2);
  assert.deepEqual(r.missing.map((m) => m.triggerAt), [at(600_000), at(1_200_000)]);
});

test('--since 过滤掉历史触发，只核启用之后的窗口', () => {
  const r = evaluateLag(
    [trigger(-86_400_000), done(-86_400_000 + 60_000)],
    { since: T0, now: T0 + 3600_000 },
  );
  assert.equal(r.verdict, 'NO_TRIGGER_EVENTS');
  assert.equal(r.triggerCount, 0);
});

test('parseArgs 支持 since / window-min / json / storage / record-dir', () => {
  const a = parseArgs([
    '--since', '2026-11-12T00:00:00Z', '--window-min', '60', '--json',
    '--storage', '/tmp/x.json', '--record-dir', '/tmp/rec',
  ]);
  assert.equal(a.since, Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(a.windowMin, 60);
  assert.equal(a.json, true);
  assert.equal(a.storage, '/tmp/x.json');
  assert.equal(a.recordDir, '/tmp/rec');
  assert.equal(parseArgs([]).windowMin, DEFAULT_WINDOW_MIN);
  assert.equal(parseArgs([]).recordDir, null);
});

test('busStoragePath / recordDirPath 显式路径直返', () => {
  assert.equal(busStoragePath('/x/a.json'), '/x/a.json');
  assert.equal(recordDirPath('/x/dir'), '/x/dir');
});

test('main 能看见「只在 per-record 目录里」的新触发（冻结旧 JSON 不得造成假绿）', () => withTmp((dir) => {
  const singlePath = join(dir, 'agint_event_bus.json');
  mkdirSync(join(dir, RECORD_SUBDIR));
  writeFileSync(singlePath, JSON.stringify({ tables: { events: {} } })); // 冻结快照：0 条
  writeRecord(dir, 'new.json', {
    id: 'new-1',
    topic: TRIGGER_TOPIC,
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    payload: { hostEvent: 'skills/change' },
  });
  const r = captureMain(['--storage', singlePath, '--record-dir', dir]);
  assert.equal(r.rc, 1, '必须判 TERMINAL_MISSING；只读旧 JSON 会误判 NO_TRIGGER_EVENTS 而假绿');
  assert.ok(r.text.includes('per-record=1'), '报告必须列出每个数据源的条数，让「看见了什么」可核对');
  assert.ok(r.text.includes('TERMINAL_MISSING'));
}));

test('main --json 报告带 sources / duplicatesMerged（双源重叠不制造假触发）', () => withTmp((dir) => {
  const singlePath = join(dir, 'agint_event_bus.json');
  mkdirSync(join(dir, RECORD_SUBDIR));
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const envelope = { id: 'same-1', topic: TRIGGER_TOPIC, occurredAt, payload: {} };
  writeFileSync(singlePath, JSON.stringify({
    tables: { events: { 'same-1': { envelope, deliveries: {} } } },
  }));
  writeRecord(dir, 'same-1.json', envelope); // 迁移重叠：同一 id 两处都有
  const r = captureMain(['--storage', singlePath, '--record-dir', dir, '--json']);
  assert.equal(r.rc, 1);
  const report = JSON.parse(r.text);
  assert.equal(report.triggerCount, 1, '同一条事件不能被算成两次触发');
  assert.equal(report.duplicatesMerged, 1);
  assert.equal(report.sources.length, 2);
  assert.equal(report.eventCount, 1);
}));

// ── 开关生效基线（2026-11-12 验收遗留 2）────────────────────────────────
// ⚠️ 这里最容易写出「过滤掉历史就宣布绿」的假绿。四条护栏必须全部钉住：
//    ① 不传 effectiveFrom ⇒ 旧行为一字不变；② 生效后仍缺 ⇒ 照红；
//    ③ 生效后 0 条 ⇒ NO_TRIGGER_EVENTS + verified=false；④ windowMin 不放宽。
const ACTIVATION_MS = T0 + 100_000;
const WINDOW = { since: T0 - 3600_000, now: T0 + 3600_000 };

test('不传 effectiveFrom 时行为完全不变（向后兼容，全量追责）', () => {
  const r = evaluateLag([trigger(0), done(60_000), trigger(200_000)], WINDOW);
  assert.equal(r.verdict, 'TERMINAL_MISSING');
  assert.equal(r.triggerCount, 2);
  assert.equal(r.missing.length, 1);
  assert.equal(r.effectiveFrom, null);
  assert.equal(r.preActivation.triggerCount, 0);
});

test('基线把生效前的历史触发分离为 preActivation，欠账数字如实保留', () => {
  // ⚠️ 终态放在 T0+31.7min：仍配得上生效后的 trigger(200_000)（窗口到
  //    T0+33.3min），但**配不上**生效前的 trigger(0)（窗口只到 T0+30min），
  //    ⇒ preActivation.missingCount 才能如实显形。配对仍是纯时间邻近口径，
  //    基线没有改它 —— 这正是「不放宽判据」要钉住的细节。
  const r = evaluateLag(
    [trigger(0), trigger(200_000), done(1_900_000)],
    { ...WINDOW, effectiveFrom: ACTIVATION_MS },
  );
  assert.equal(r.verdict, 'OK');
  assert.equal(r.verified, true);
  assert.equal(r.triggerCount, 1, '只有生效后的 1 条参与判绿');
  assert.equal(r.totalTriggerCount, 2, '总触发数不许被抹掉');
  assert.equal(r.matched.length, 1);
  assert.equal(r.missing.length, 0);
  assert.equal(r.preActivation.triggerCount, 1);
  assert.equal(r.preActivation.missingCount, 1, '历史欠账 1 条必须显形，不许静默吞掉');
  assert.equal(r.preActivation.firstTriggerAt, at(0));
  assert.equal(r.effectiveFrom, at(100_000));
  assert.equal(r.evaluatedSince, at(100_000));
});

test('生效后仍有触发缺终态 ⇒ 照常 TERMINAL_MISSING（基线不放宽判据）', () => {
  const r = evaluateLag(
    [trigger(0), trigger(200_000)],
    { ...WINDOW, effectiveFrom: ACTIVATION_MS },
  );
  assert.equal(r.verdict, 'TERMINAL_MISSING');
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].triggerAt, at(200_000));
  assert.equal(r.preActivation.missingCount, 1);
});

test('⛔ 生效后 0 条触发 ⇒ NO_TRIGGER_EVENTS + verified=false（过滤不得变全绿）', () => {
  const r = evaluateLag(
    [trigger(0), done(60_000)],
    { ...WINDOW, effectiveFrom: ACTIVATION_MS },
  );
  assert.equal(r.verdict, 'NO_TRIGGER_EVENTS');
  assert.equal(r.verified, false);
  assert.equal(r.triggerCount, 0);
  assert.equal(r.totalTriggerCount, 1);
  assert.equal(r.preActivation.triggerCount, 1);
});

test('基线不改变 windowMin：终态超窗仍判 TERMINAL_MISSING', () => {
  const r = evaluateLag(
    [trigger(200_000), done(200_000 + DEFAULT_WINDOW_MIN * 60_000 + 1)],
    { ...WINDOW, effectiveFrom: ACTIVATION_MS },
  );
  assert.equal(r.verdict, 'TERMINAL_MISSING');
  assert.equal(r.missing.length, 1);
});

test('parseArgs 支持 effective-from / activation-file / no-baseline', () => {
  const a = parseArgs([
    '--effective-from', '2026-11-12T04:15:38.852Z',
    '--activation-file', '/tmp/act.json', '--no-baseline',
  ]);
  assert.equal(a.effectiveFrom, Date.parse('2026-11-12T04:15:38.852Z'));
  assert.equal(a.activationFile, '/tmp/act.json');
  assert.equal(a.noBaseline, true);
  const d = parseArgs([]);
  assert.equal(d.effectiveFrom, null);
  assert.equal(d.activationFile, null);
  assert.equal(d.noBaseline, false);
});

test('loadActivation：合法可读，坏文件 / 不可解析时间 / 文件缺失一律返回 null', () => withTmp((dir) => {
  const p = join(dir, 'act.json');
  writeFileSync(p, JSON.stringify({ activatedAt: '2026-11-12T04:15:38.852Z' }));
  const r = loadActivation(p);
  assert.equal(r.at, Date.parse('2026-11-12T04:15:38.852Z'));
  assert.equal(r.path, p);
  writeFileSync(p, '{not json');
  assert.equal(loadActivation(p), null, '基线损坏必须退回严格口径，不能因此判绿');
  writeFileSync(p, JSON.stringify({ activatedAt: 'not-a-date' }));
  assert.equal(loadActivation(p), null);
  assert.equal(loadActivation(join(dir, 'missing.json')), null);
}));

test('默认基线文件落地且时间可核对（不许被悄悄前移）', () => {
  const r = loadActivation();
  assert.ok(r, `${ACTIVATION_FILE} 必须存在且可解析`);
  assert.equal(r.at, Date.parse('2026-11-12T04:15:38.852Z'));
  assert.ok(r.path.endsWith('docs/event-trigger-activation.json'));
});

test('main：带基线 → OK；--no-baseline 复现全量严格口径 → TERMINAL_MISSING', () => withTmp((dir) => {
  const singlePath = join(dir, 'agint_event_bus.json');
  const actPath = join(dir, 'activation.json');
  mkdirSync(join(dir, RECORD_SUBDIR));
  writeFileSync(singlePath, JSON.stringify({ tables: { events: {} } }));
  const base = Date.now() - 10 * 60_000;
  const oldTs = base - 60 * 60_000;
  const newTs = base + 60_000;
  writeFileSync(actPath, JSON.stringify({ activatedAt: new Date(base).toISOString() }));
  writeRecord(dir, 'old.json', {
    id: 'old', topic: TRIGGER_TOPIC, occurredAt: new Date(oldTs).toISOString(), payload: {},
  });
  writeRecord(dir, 'new.json', {
    id: 'new', topic: TRIGGER_TOPIC, occurredAt: new Date(newTs).toISOString(), payload: {},
  });
  writeRecord(dir, 'done.json', {
    id: 'done', topic: 'curator.run-completed',
    occurredAt: new Date(newTs + 30_000).toISOString(), payload: { dryRun: false },
  });

  const ok = captureMain([
    '--storage', singlePath, '--record-dir', dir,
    '--activation-file', actPath, '--json',
  ]);
  assert.equal(ok.rc, 0);
  const rep = JSON.parse(ok.text);
  assert.equal(rep.verdict, 'OK');
  assert.equal(rep.triggerCount, 1);
  assert.equal(rep.preActivation.triggerCount, 1);
  assert.equal(rep.preActivation.missingCount, 1, '历史欠账必须在报告里看得见');
  assert.equal(rep.activation.kind, 'file');

  const strict = captureMain([
    '--storage', singlePath, '--record-dir', dir, '--no-baseline', '--json',
  ]);
  assert.equal(strict.rc, 1);
  const srep = JSON.parse(strict.text);
  assert.equal(srep.verdict, 'TERMINAL_MISSING');
  assert.equal(srep.missing.length, 1);
  assert.equal(srep.activation, null);
}));

test('main：基线把所有触发都划到生效前 ⇒ 仍 verified=false，不判绿', () => withTmp((dir) => {
  const singlePath = join(dir, 'agint_event_bus.json');
  mkdirSync(join(dir, RECORD_SUBDIR));
  writeFileSync(singlePath, JSON.stringify({ tables: { events: {} } }));
  writeRecord(dir, 'old.json', {
    id: 'old', topic: TRIGGER_TOPIC,
    occurredAt: new Date(Date.now() - 60_000).toISOString(), payload: {},
  });
  const r = captureMain([
    '--storage', singlePath, '--record-dir', dir,
    '--effective-from', new Date(Date.now() + 3600_000).toISOString(), '--json',
  ]);
  const rep = JSON.parse(r.text);
  assert.equal(rep.verdict, 'NO_TRIGGER_EVENTS');
  assert.equal(rep.verified, false);
  assert.equal(rep.triggerCount, 0);
  assert.equal(rep.preActivation.triggerCount, 1);
}));
