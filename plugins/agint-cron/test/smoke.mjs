// agint-cron smoke: 一行可跑的最小验证（node test/smoke.mjs → 退出码 0）。
// 只测纯逻辑（cron 解析/调度 + 默认 job 编译 + 失效两维度判定），不依赖 dsh 运行时。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseCron, nextFire, lastFire } from '../lib/cron.js';
import { classifyInactivity, INACTIVE_PERIOD_FACTOR } from '../lib/staleness.js';
import { compileJobs, defaultJobs } from '../lib/jobs.js';

// cron 解析 + nextFire：Sun 03:00 (0 3 * * 0)，从一个已知基线往后推
const parsed = parseCron('0 3 * * 0');
assert.ok(parsed, 'parseCron 返回调度对象');
const next = nextFire(parsed, new Date('2026-08-20T00:00:00'));
assert.ok(next instanceof Date, 'nextFire 返回 Date');

// lastFire：给定时刻之前最近的一次匹配
const last = lastFire(parsed, new Date('2026-08-23T04:00:00'));
assert.ok(last instanceof Date, 'lastFire 返回 Date');

// 默认 job 编译为非空列表，且每个都有 id + 已解析的 schedule
const jobs = compileJobs();
assert.ok(Array.isArray(jobs) && jobs.length > 0, 'compileJobs 返回默认 job');
for (const j of jobs) {
  assert.ok(j.id && j.parsed, `job 含 id + parsed schedule: ${j.id}`);
}

// ── 失效两维度（提案 cdf41d63）────────────────────────────────────────────
// 判据分两路：跑过的 job 与从未跑过的 job，各自的阈值来源不同。
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-08T00:00:00Z');

// ① 每日 job（周期 1 天），上次跑完 1.2 天前 ⇒ 既不「久未活动」（1.2 < 2×1）
//    也不「过期未跑」（1.2 < 1.5×1）—— 两个维度的阈值不一样，必须分别验
{
  const period = DAY;
  const lastRunAt = NOW - 1.2 * DAY;
  const r = classifyInactivity({
    now: NOW,
    lastRunAt,
    bootTime: NOW - 10 * DAY,
    expectedNextRunAt: lastRunAt + period,
  });
  assert.equal(r.staleInactive, false, 'idle 1.2 天（周期 1 天）不该判久未活动');
  assert.equal(r.periodMs, period, '周期 = 相邻两次触发的间隔');
}

// ② 每周 job（周期 7 天），上次跑完 20 天前 ⇒ 久未活动（20 > 14）
{
  const period = 7 * DAY;
  const lastRunAt = NOW - 20 * DAY;
  const r = classifyInactivity({
    now: NOW,
    lastRunAt,
    bootTime: NOW - 30 * DAY,
    expectedNextRunAt: lastRunAt + period,
  });
  assert.equal(r.staleInactive, true, 'idle 20 天（周期 7 天）必须判久未活动');
  assert.equal(r.inactiveMs, 20 * DAY);
}

// ③ 从未运行的 job：从**宿主启动时刻**起算，用真实周期（不是固定 7 天兜底）
{
  const period = DAY; // 每日 job
  const bootTime = NOW - 3 * DAY;
  const r = classifyInactivity({
    now: NOW,
    lastRunAt: null,
    bootTime,
    expectedNextRunAt: bootTime + period,
  });
  assert.equal(r.staleInactive, true, '每日 job 从未运行、宿主已起 3 天 ⇒ 久未活动');
  assert.equal(r.periodMs, period, '从未运行的 job 也用真实周期');
}

// ④ 阈值本身：倍数改了判据就变了，别让常量漂移
assert.equal(INACTIVE_PERIOD_FACTOR, 2, '久未活动倍数 = 2 个调度周期');

// ── 存储度量 / 回收（2026-11-12 新增 job）────────────────────────────────
const jobById = new Map(defaultJobs.map((j) => [j.id, j]));
const storageGuard = jobById.get('storage-guard');
const storagePrune = jobById.get('storage-prune');
assert.ok(storageGuard && storagePrune, '两个存储 job 都必须注册');
assert.equal(storageGuard.schedule, '15 4 * * *', 'storage-guard 排期 daily 04:15');
assert.equal(storagePrune.schedule, '30 6 * * 0', 'storage-prune 排期 Sun 06:30（避 06:00 的 input-gateway-watchdog）');

/** 造一个临时存储根：1 个普通域 + 1 个事件域 */
async function makeFakeStorages() {
  const dir = await mkdtemp(join(tmpdir(), 'agint-storage-'));
  const storages = join(dir, 'storages');
  await mkdir(storages, { recursive: true });
  await writeFile(join(storages, 'agint_metrics.json'), JSON.stringify({
    unit: { name: 'agint_metrics', version: 1 },
    global: null,
    tables: { metric: { m1: { id: 'm1', key: 'k', value: 1 }, m2: { id: 'm2', key: 'k', value: 2 } } },
  }));
  await writeFile(join(storages, 'agint_event_bus.json'), JSON.stringify({
    unit: { name: 'agint_event_bus', version: 1 },
    global: null,
    tables: { events: { e1: { topic: 'a.b' }, e2: { topic: 'a.b' }, e3: { topic: 'c.d' } } },
  }));
  return { dir, storages };
}

const runStorageSuites = async () => {
  // ① storage-guard：能采到指标，且**首日 delta = 0**（预期语义，不是故障）
  {
    const { dir, storages } = await makeFakeStorages();
    try {
      const recorded = [];
      const res = await storageGuard.action({
        'agint.storage': { root: storages },
        'agint.metrics.record': async (m) => { recorded.push(m); return true; },
      });
      const byKey = new Map(recorded.map((m) => [m.key, m]));
      for (const key of [
        'storage.bytes.agint_metrics',
        'storage.rows.agint_metrics.metric',
        'storage.dailyDelta.bytes',
        'storage.dailyDelta.rows',
        'storage.writeAmplification',
        'storage.events.topTopic',
        'storage.backup.bytes',
      ]) {
        assert.ok(byKey.has(key), `storage-guard 必须产出指标 ${key}`);
      }
      assert.equal(recorded.length, res.summary.metrics, '写的指标数与产出数一致');
      // 首日：没有昨日快照 ⇒ delta 恒为 0，且必须标出「这是基线」
      assert.equal(byKey.get('storage.dailyDelta.bytes').value, 0, '首日 delta 字节 = 0');
      assert.equal(byKey.get('storage.dailyDelta.rows').value, 0, '首日 delta 行数 = 0');
      assert.equal(byKey.get('storage.dailyDelta.bytes').meta.baseline, true, '首日必须标 baseline=true');
      assert.equal(byKey.get('storage.writeAmplification').value, -1, '写入量取不到 ⇒ 写 -1 并注明');
      assert.equal(byKey.get('storage.events.topTopic').value, 2, '事件 Top-1 topic 条数 = 2');
      assert.equal(byKey.get('storage.rows.agint_metrics.metric').value, 2, '表行数 = 2');
      // 快照落在存储根的上一级（不放 storages/ 里，否则自己量自己）
      const snapPath = join(dir, 'agint_storage_guard.json');
      assert.ok(existsSync(snapPath), '快照文件必须落盘');
      const snap = JSON.parse(await readFile(snapPath, 'utf8'));
      assert.equal(snap.snapshots.length, 1, '首次只有 1 份快照');
      assert.equal(snap.snapshots[0].totalRows, 5, '快照记录总行数（2 metric + 3 events）');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ①b 有昨日快照时 ⇒ 走真 delta（不是恒 0）
  {
    const { dir, storages } = await makeFakeStorages();
    try {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await writeFile(join(dir, 'agint_storage_guard.json'), JSON.stringify({
        version: 1,
        snapshots: [{ date: yesterday, totalBytes: 100, totalRows: 1 }],
      }));
      const recorded = [];
      await storageGuard.action({
        'agint.storage': { root: storages },
        'agint.metrics.record': async (m) => { recorded.push(m); return true; },
      });
      const byKey = new Map(recorded.map((m) => [m.key, m]));
      assert.equal(byKey.get('storage.dailyDelta.bytes').meta.baseline, false, '有昨日快照 ⇒ 不是基线');
      assert.equal(byKey.get('storage.dailyDelta.rows').value, 4, '净增行数 = 今日 5 − 昨日 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ③ storage-prune：各 service 缺席时安全跳过全部步骤而不抛错（**常态**）
  {
    const { dir, storages } = await makeFakeStorages();
    try {
      const res = await storagePrune.action({ 'agint.storage': { root: storages } });
      assert.equal(res.summary.dryRun, true, '默认 dry-run = true（破坏性动作必须显式开）');
      assert.equal(res.steps.length, 5, '5 个 prune 步骤一个不少');
      for (const s of res.steps) {
        assert.equal(s.status, 'skipped', `${s.step} 服务缺席 ⇒ skipped（不是 error）`);
        assert.match(s.reason, /not available/, `${s.step} 必须写清跳过原因`);
      }
      assert.equal(res.summary.errored, 0, '缺席不是错误');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ④ storage-prune 的 dry-run 不产生任何文件删除
  {
    const { dir, storages } = await makeFakeStorages();
    try {
      const bakOld = join(storages, 'agint_metrics.json.bak-20260101-000000');
      const bakNew = join(storages, 'agint_metrics.json.bak-20260102-000000');
      const tmpOld = join(storages, '.old.tmp');
      await writeFile(bakOld, 'old-backup');
      await writeFile(bakNew, 'new-backup');
      await writeFile(tmpOld, 'stale-tmp');
      const { utimesSync } = await import('node:fs');
      const at = (p, iso) => { const d = new Date(iso); utimesSync(p, d, d); };
      at(bakOld, '2026-01-01T00:00:00Z');
      at(bakNew, '2026-01-02T00:00:00Z');
      const old = new Date(Date.now() - 48 * 3600_000);
      utimesSync(tmpOld, old, old);

      const res = await storagePrune.action({ 'agint.storage': { root: storages } });
      assert.equal(res.summary.dryRun, true);
      // dry-run：一个字节都不许动
      for (const p of [bakOld, bakNew, tmpOld]) {
        assert.ok(existsSync(p), `dry-run 不得删除 ${p}`);
      }
      const plan = res.files.backups;
      assert.equal(plan.archived.length, 1, '规划：两份 .bak 只留最近 1 份');
      assert.equal(plan.archived[0], 'agint_metrics.json.bak-20260101-000000', '旧的那份进归档候选');
      assert.equal(plan.deleted.length, 0, 'dry-run 一个都不删');
      assert.equal(res.files.tmp.candidates.length, 1, '规划：识别出 1 个孤儿 .tmp');
      assert.equal(res.files.tmp.deleted.length, 0, 'dry-run 不删 .tmp');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ④c 一次性 apply 标记（2026-11-12）：标记存在 ⇒ 本次真删 ⇒ 用完即删
  //    语义：老板批准的一次性存量回收需要真跑一次，但**不能**为此改配置再重启
  //    （配置型开关容易忘了关 ⇒ 长期真删，无人值守）。标记用完即自动消失。
  {
    const { dir, storages } = await makeFakeStorages();
    try {
      const bakOld = join(storages, 'agint_metrics.json.bak-20260101-000000');
      const bakNew = join(storages, 'agint_metrics.json.bak-20260102-000000');
      await writeFile(bakOld, 'old-backup');
      await writeFile(bakNew, 'new-backup');
      // 标记文件在**存储根的上一级**（与 storage-guard 快照同层）
      const marker = join(dirname(storages), 'agint_storage_prune_apply_once');
      await writeFile(marker, 'apply-once');

      // 注意：**不传** pruneDryRun:false —— 开关是标记文件，不是配置
      const res = await storagePrune.action({
        'agint.storage': { root: storages, backupDir: join(dir, '.agint-backups') },
      });
      assert.equal(res.summary.dryRun, false, '存在一次性标记 ⇒ 本次真删');
      assert.ok(existsSync(bakNew), '最近 1 份 .bak 仍保留');
      assert.ok(!existsSync(bakOld), '旧 .bak 被归档后删除');
      assert.ok(!existsSync(marker), '标记用完即删 ⇒ 下一次自动回到 dry-run');

      // 标记已消失 ⇒ 再跑一次必须回到 dry-run（不能连删）
      const res2 = await storagePrune.action({
        'agint.storage': { root: storages, backupDir: join(dir, '.agint-backups') },
      });
      assert.equal(res2.summary.dryRun, true, '标记消失 ⇒ 回到 dry-run（不连删）');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ④b apply 档（dryRun:false）：真的归档 + 删（**只在临时目录里**，不碰生产）
  {
    const { dir, storages } = await makeFakeStorages();
    try {
      const bakOld = join(storages, 'agint_metrics.json.bak-20260101-000000');
      const bakNew = join(storages, 'agint_metrics.json.bak-20260102-000000');
      const tmpOld = join(storages, '.old.tmp');
      await writeFile(bakOld, 'old-backup');
      await writeFile(bakNew, 'new-backup');
      await writeFile(tmpOld, 'stale-tmp');
      const old = new Date(Date.now() - 48 * 3600_000);
      const { utimesSync } = await import('node:fs');
      utimesSync(tmpOld, old, old);

      const res = await storagePrune.action({
        'agint.storage': { root: storages, pruneDryRun: false, backupDir: join(dir, '.agint-backups') },
      });
      assert.equal(res.summary.dryRun, false, '显式 pruneDryRun:false ⇒ 真删');
      assert.ok(existsSync(bakNew), '最近 1 份 .bak 必须保留');
      assert.ok(!existsSync(bakOld), '旧 .bak 归档后删除');
      assert.ok(!existsSync(tmpOld), '过期 .tmp 必须删');
      const archive = res.files.backups.archivePath;
      assert.ok(existsSync(archive), '归档 tar.gz 必须落盘');
      const { gunzipSync } = await import('node:zlib');
      const names = gunzipSync(await readFile(archive)).toString('latin1')
        .split('\0').filter(Boolean);
      assert.ok(names.some((n) => n.includes('agint_metrics.json.bak-20260101-000000')),
        '归档内容必须含被归档的文件名');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

runStorageSuites()
  .then(() => {
    console.log(`agint-cron smoke: ok (${defaultJobs.length} 个默认 job，失效两维度已覆盖，`
      + 'storage-guard/storage-prune 已覆盖）');
  })
  .catch((err) => {
    console.error('agint-cron smoke: FAIL');
    console.error(err);
    process.exit(1);
  });
