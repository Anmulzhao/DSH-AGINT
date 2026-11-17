#!/usr/bin/env node
/**
 * 提案 409d571f 第 3 点：历史假 fail attempt 的一次性失效回填（离线执行）。
 *
 * ⚠️ 只改 agint_curriculum 域的 attempts 表，走插件自带 zod spec（DomainFacility），
 *    绝不手改 storages JSON。只加 invalidated 标记，不改 result 事实。
 *
 * ⛔ 执行时序硬约束：运行中的 dsh web 持整域内存副本，外部写盘会被下一次
 *    任何写入覆盖 ⇒ 必须停在停机窗口执行，写完立即重启 dsh，再回读复核。
 *    本脚本默认 dry-run，只有显式 --commit 才写盘。
 *
 * 用法：
 *   # 预览（零写入）
 *   node bin/backfill-curriculum-invalidation.mjs --actor human:anmul --reason '提案409d571f回填'
 *   # 执行（写盘 + audit_log）
 *   node bin/backfill-curriculum-invalidation.mjs --actor human:anmul --reason '提案409d571f回填' --commit
 *   # 只回填指定 id（白名单，签名仍须匹配）
 *   node bin/backfill-curriculum-invalidation.mjs --actor human:anmul --reason '...' --ids id1,id2 --commit
 *
 * 前置：export DSH_HOME=/home/kylin/projects/DSH/AGINT-data；node 用 nvm v24。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  matchInvalidationSignature,
  selectBackfillCandidates,
  buildInvalidatedAttempt,
  buildBackfillAudit,
} from '../plugins/agint-curriculum/lib/invalidation-backfill.js';

const require = createRequire(import.meta.url);
const DSH_HOME = process.env.DSH_HOME;
if (!DSH_HOME) { console.error('DSH_HOME is required'); process.exit(2); }

// dsh-storage-domain 从部署位的 node_modules 解析（仓库位没有该包）。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE = process.env.AGINT_BUNDLE ?? join(DSH_HOME, '.agint-bundle');
const resolveDomain = (from) => {
  // createRequire 接受「文件路径」；传目录时它会自动追加 index.js 作为基准。
  const r = createRequire(join(from, 'noop.js'));
  try { return r.resolve('@deepseek-ai/dsh-storage-domain'); }
  catch { return null; }
};
const domainPath = resolveDomain(BUNDLE)
  || resolveDomain(HERE)
  || resolveDomain('/home/kylin/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh');
if (!domainPath) { console.error('cannot resolve @deepseek-ai/dsh-storage-domain; check DSH_HOME/.agint-bundle'); process.exit(2); }
const { DomainFacility } = require(domainPath);
const { spec: curriculumSpec, packAudit } = await import('../plugins/agint-curriculum/lib/storage.js');

const STORAGES = join(DSH_HOME, 'storages');

function fileKvBackend() {
  return {
    kv: {
      async open(descriptor) {
        const file = join(STORAGES, `${descriptor.name}.json`);
        let data = { unit: { name: descriptor.name, version: descriptor.version }, global: null, tables: {} };
        if (existsSync(file)) {
          try { data = JSON.parse(await readFile(file, 'utf8')); }
          catch (e) { throw new Error(`解析 ${file} 失败: ${e.message}`); }
        }
        data.tables ??= {};
        const save = async () => { await writeFile(file, JSON.stringify(data, null, 1)); };
        return {
          async loadAll() {
            return { unit: data.unit ?? { name: descriptor.name, version: descriptor.version }, global: data.global ?? null, tables: data.tables ?? {} };
          },
          async putRecord(table, key, value) { (data.tables[table] ??= {})[key] = value; await save(); },
          async deleteRecord(table, key) { if (data.tables[table]) { delete data.tables[table][key]; await save(); } },
          async setGlobal(value) { data.global = value; await save(); },
          async close() {},
        };
      },
    },
  };
}

function makeFacility() {
  const backend = fileKvBackend();
  const ctx = {
    storage: { backend: { get: () => backend } },
    logger: { warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) },
    emit: () => {},
    effect: () => {},
  };
  return new DomainFacility(ctx, { backend: 'file', routes: {} });
}

// ── CLI 参数 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { commit: false, ids: [], actor: '', reason: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--commit') out.commit = true;
    else if (a === '--actor') out.actor = argv[++i] ?? '';
    else if (a === '--reason') out.reason = argv[++i] ?? '';
    else if (a === '--ids') out.ids = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法: node backfill-curriculum-invalidation.mjs --actor human:<name> --reason <文本> [--ids id1,id2] [--commit]');
  process.exit(0);
}
if (!args.actor.startsWith('human:')) {
  console.error('--actor 必须以 human: 开头（人工确认留痕），如 human:anmul');
  process.exit(2);
}
if (!args.reason.trim()) { console.error('--reason 必填（留痕）'); process.exit(2); }

// ── 执行 ──────────────────────────────────────────────────────────────────
const facility = makeFacility();
const domain = await facility.open(curriculumSpec);
const attemptsTable = domain.table('attempts');
const all = [...attemptsTable.entries()].map(([key, v]) => ({ key, value: v }));
const { candidates, rejected } = selectBackfillCandidates(all.map((x) => x.value));

let targets = candidates;
if (args.ids.length > 0) {
  const wanted = new Set(args.ids);
  targets = candidates.filter((a) => wanted.has(a.id));
  const missing = args.ids.filter((id) => !targets.some((a) => a.id === id));
  if (missing.length > 0) {
    const reasons = all.filter((x) => wanted.has(x.value.id)).map((x) => `${x.value.id}: ${matchInvalidationSignature(x.value).why}`);
    console.error(`以下 id 未通过签名校验，拒绝回填：\n  ${missing.join(', ')}\n原因：${reasons.join(' | ') || 'id 不存在'}`);
    process.exit(3);
  }
}

console.log(`attempts 总数=${all.length}；签名命中候选=${candidates.length}；本次目标=${targets.length}；签名不匹配=${rejected.length}`);
console.log('候选明细：');
for (const a of targets) console.log(`  ${a.id}  ${a.domain}  ${a.verifiedAt}  ${a.reason}`);
if (rejected.length) {
  console.log('签名不匹配（不动）：');
  for (const r of rejected.slice(0, 20)) console.log(`  ${r.id} — ${r.why}`);
}

if (!args.commit) {
  console.log('\n[DRY-RUN] 未写入。确认后加 --commit 执行（须先停 dsh web，写完立即重启）。');
  await domain.close();
  process.exit(0);
}

if (targets.length === 0) {
  console.log('\n无目标，零写入。');
  await domain.close();
  process.exit(0);
}

for (const a of targets) {
  const updated = buildInvalidatedAttempt(a, { actor: args.actor, reason: args.reason });
  await attemptsTable.put(a.id, updated);
}
const auditTable = domain.table('audit_log');
const auditRecord = packAudit(buildBackfillAudit({ ids: targets.map((a) => a.id), actor: args.actor, reason: args.reason, dryRun: false }));
await auditTable.put(auditRecord.id, auditRecord);
await domain.close();

// 回读复核
const verify = makeFacility();
const vd = await verify.open(curriculumSpec);
const rows = [...vd.table('attempts').entries()].map(([, v]) => v);
const marked = rows.filter((a) => targets.some((t) => t.id === a.id) && a.invalidated === true);
await vd.close();
console.log(`\n[COMMIT] 写入 ${targets.length} 条；回读确认失效标记 ${marked.length} 条；audit=${auditRecord.id}`);
if (marked.length !== targets.length) { console.error('回读数量不符，请人工复核'); process.exit(4); }
