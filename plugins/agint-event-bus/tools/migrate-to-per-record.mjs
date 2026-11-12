#!/usr/bin/env node
/**
 * 一次性迁移脚本：event bus 的 events 表从 `single` 布局搬到 `per-record` 布局。
 *
 * ── 为什么需要单独一个脚本 ──────────────────────────────────────────────────
 * 插件在启动时会做「启动前补迁」（见 lib/index.js），但**首次迁移**量级大
 * （生产 30 天内约 1 万条 × 约 6.5 ms ≈ 70 秒），放在启动路径里会拖慢启动
 * （启动延迟红线 < 30s）。所以：
 *   · 首次迁移走本脚本，**离线**跑，不阻塞宿主；
 *   · 启动前补迁只处理「脚本跑完之后宿主又新写的那几条」，毫秒级完成。
 *
 * ── 安全约定 ────────────────────────────────────────────────────────────────
 * ① 默认 **dry-run**：只打印计划，不写任何文件。要真跑加 `--apply`。
 * ② **绝不删除旧文件**：`agint_event_bus.json` 原地保留，就是回滚备份
 *    （single 读该文件、per-record 读目录，两者可共存）。
 * ③ 幂等：水位线 `agint_event_bus_migration.json` 记录已迁到的位置，
 *    重复运行只补新的。
 * ④ 自检：--apply 后用 dsh 的 backend 打开该 unit 并 loadAll()，
 *    断言读回的条数与迁入条数一致（证明写出的文档格式与 dsh 认的一致）。
 *
 * 用法：
 *   node plugins/agint-event-bus/tools/migrate-to-per-record.mjs              # dry-run
 *   node plugins/agint-event-bus/tools/migrate-to-per-record.mjs --apply      # 真迁
 *   node plugins/agint-event-bus/tools/migrate-to-per-record.mjs --apply --verify  # 迁后自检
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigration, resolveStoragesRoot, serializePerRecord,
  SINGLE_FILE, PER_RECORD_DIR, EVENTS_TABLE_DIR,
} from '../lib/migrate.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VERIFY = argv.includes('--verify');
const MAX_AGE_DAYS = Number((argv.find((a) => a.startsWith('--max-age-days=')) ?? '').split('=')[1] || 30);

const storageRoot = resolveStoragesRoot();
if (!storageRoot) {
  console.error('无法定位存储根：$DSH_HOME 与 $HOME 都不可用');
  process.exit(2);
}

const singlePath = join(storageRoot, SINGLE_FILE);
const eventsDir = join(storageRoot, PER_RECORD_DIR, EVENTS_TABLE_DIR);

console.log(`存储根：${storageRoot}`);
console.log(`源（single）：${singlePath}${existsSync(singlePath) ? '' : '  ← 不存在'}`);
console.log(`目标（per-record）：${eventsDir}`);
console.log(`保留窗口：${MAX_AGE_DAYS} 天`);
console.log(`模式：${APPLY ? 'APPLY（会写文件）' : 'DRY-RUN（只报告，不写）'}\n`);

if (!existsSync(singlePath)) {
    console.log('源文件不存在 ⇒ 无需迁移（可能已切换过，或该布局不是 single）。');
    process.exit(0);
}

const result = applyMigration({
    storageRoot,
    maxAgeDays: MAX_AGE_DAYS,
    dryRun: !APPLY,
});

console.log('── 迁移计划 ──');
console.log(`  源总行数        ：${result.totalRows}`);
console.log(`  本次将迁入      ：${result.planned}${APPLY ? `（实际写入 ${result.migrated}）` : '（dry-run 计划数）'}`);
console.log(`  已迁过（跳过）  ：${result.skipped}`);
console.log(`  窗口外（不迁）  ：${result.staleRows}`);
console.log(`  写入失败        ：${result.failed}`);
console.log(`  预计字节        ：${(result.bytes / 1024).toFixed(1)} KB`);
console.log(`  水位线文件      ：${result.watermarkPath}`);
console.log(`  最新 occurredAt ：${result.lastOccurredAt || '(无)'}`);

if (!APPLY) {
    console.log('\n这是 dry-run。加 --apply 才会真正写入。');
    console.log('（旧文件 agint_event_bus.json 不会被删除，它是 single 布局的回滚备份。）');
    process.exit(0);
}

// ── 自检：用 dsh 的 backend 打开该 unit，确认写出的文档能被 loadAll 读回 ──
if (VERIFY) {
    console.log('\n── 自检：用 dsh backend 打开 unit 并 loadAll ──');
    try {
        const DSH_MODULES = '/home/kylin/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
        const { JsonStorageBackend } = await import(`${DSH_MODULES}/dsh-storage-json/lib/index.js`);
        const { defineDomain, descriptorOf } = await import(`${DSH_MODULES}/dsh-storage-domain/lib/index.js`);
        const backend = new JsonStorageBackend(storageRoot);
        const spec = defineDomain({
            name: 'agint_event_bus', version: 1, layout: 'per-record',
            tables: { events: { valueSchema: null }, deadletter: { valueSchema: null } },
        });
        const unit = await backend.kv.open(descriptorOf(spec));
        const snap = await unit.loadAll();
        const rows = Object.keys(snap.tables.events ?? {}).length;
        const files = existsSync(eventsDir)
            ? (await import('node:fs')).readdirSync(eventsDir).filter((f) => f.endsWith('.json')).length
            : 0;
        console.log(`  loadAll 读回 ${rows} 行 / 目录里 ${files} 个 .json`);
        if (rows !== files) {
            console.error(`  ❌ 不一致：读回 ${rows} ≠ 文件数 ${files}`);
            await backend.close();
            process.exit(1);
        }
        console.log('  ✅ 一致：写出的文档格式与 dsh 认的一致，且能被读回');
        await backend.close();
    } catch (err) {
        console.error(`  ❌ 自检失败：${err?.message ?? err}`);
        process.exit(1);
    }
}

console.log('\n迁移完成。旧文件保留为回滚备份，未删除。');
