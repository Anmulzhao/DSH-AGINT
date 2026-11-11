#!/usr/bin/env node
/**
 * bin/attest-baseline.mjs —— 判定基准的独立人工签发通道（离线 CLI）。
 *
 * ## 为什么是 CLI，不是 model-visible 工具
 *
 * 导出包的 G1 缺口原话：「判定基准与被评对象同池（success_template 有
 * model-visible 写工具 evolution_addSuccess）、上限 50、无 provenance 记录」。
 * 把签发做成 `evolution_attestBaseline` 工具，等于让被评对象自己给自己的
 * 基准盖章 —— 缺口没补，只是换了个名字。本 CLI **不注册任何工具**，
 * 只能由人在命令行运行。
 *
 * ## 为什么写独立文件
 *
 * 签发记录落 `$DSH_HOME/storages/agint_baseline_attestation.json`，
 * 与 `agint_evolution.json` 分开。三个理由：
 *   1. `benchmark_frozen_set` 是「只增不改、同 setId 二次写入拒绝」的
 *      防篡改留证。回写它的行会直接破纪律。
 *   2. 宿主运行时持有 `agint_evolution.json` 的域对象，离线改它可能被
 *      下一次写回覆盖 —— 签发记录会静默消失。
 *   3. 独立文件不进插件 tables 声明 ⇒ 不改 boot 期插件、不需要重启。
 *
 * ## 使用
 *
 *   node bin/attest-baseline.mjs --check
 *   node bin/attest-baseline.mjs --sign \
 *       --target=success_template:<id> --by=<签发人> --mandate=<授权来源>
 *
 * ⛔ 默认 --check：只报告，不写盘（K133：`--check` 必早于写盘）。
 * ⛔ `--sign` 只增不改：同 target 已有签发 ⇒ 拒绝，绝不覆盖。
 * ⛔ `humanValidated` 由 makeAttestation 硬设为 true，不接受参数。
 *
 * 本脚本不代任何人签发。`--sign` 必须由人显式执行并署名。
 */

import { readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessBaselineProvenance, makeAttestation, ATTESTABLE_TABLES,
  ATTESTATION_TABLE, rowHash, targetIdOf,
} from './lib/baseline-provenance.mjs';
import { writeJsonNoBom } from './lib/canonical-json.mjs';

const DSH_HOME = process.env.DSH_HOME
  || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const STORAGES = join(DSH_HOME, 'storages');
const EVO_FILE = join(STORAGES, 'agint_evolution.json');
const ATTEST_FILE = join(STORAGES, 'agint_baseline_attestation.json');

const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const WANT_SIGN = argv.includes('--sign');

/** 认 `{tables:{...}}` 与顶层形态两种写法，返回表容器。 */
function tablesOf(data) {
  if (data?.tables && typeof data.tables === 'object') return data.tables;
  if (data && typeof data === 'object') return data;
  return {};
}

function readJson(path) {
  if (!existsSync(path)) return { exists: false, data: {} };
  try {
    return { exists: true, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    console.error(`❌ 读取失败 ${path}：${e.message}`);
    process.exit(1);
  }
}

function loadState() {
  const evo = readJson(EVO_FILE);
  if (!evo.exists) {
    console.error(`❌ 找不到生产存储 ${EVO_FILE}。请确认 DSH_HOME（当前 ${DSH_HOME}）。`);
    process.exit(1);
  }
  const att = readJson(ATTEST_FILE);
  const evoTables = tablesOf(evo.data);
  const attTables = tablesOf(att.data);
  const attRows = attTables[ATTESTATION_TABLE] ?? {};
  const input = {
    success_template: evoTables.success_template ?? {},
    benchmark_frozen_set: evoTables.benchmark_frozen_set ?? {},
    [ATTESTATION_TABLE]: attRows,
  };
  return { evoTables, attRows, input, assessment: assessBaselineProvenance(input) };
}

function printReport(a) {
  console.log('[attest-baseline] 判定基准签发状态（实算）');
  console.log(`  DSH_HOME ${DSH_HOME}`);
  console.log(`  签发文件 ${ATTEST_FILE}${existsSync(ATTEST_FILE) ? '' : '（尚不存在）'}`);
  console.log(`  baselineProvenance = ${a.baselineProvenance} · baselineAnchored = ${a.baselineAnchored}`);
  const c = a.counts;
  console.log(`  基准行 ${c.total} · 已签发 ${c.attested} · 未签发 ${c.unattested}`
    + ` · 失效 ${c.stale} · 非人工 ${c.invalid} · 孤儿 ${c.orphan}`);
  for (const r of a.rows.slice(0, 20)) {
    console.log(`    [${r.status.padEnd(20)}] ${r.targetKind}:${r.targetId}${r.reason ? ` —— ${r.reason}` : ''}`);
  }
  if (a.rows.length > 20) console.log(`    … 另有 ${a.rows.length - 20} 条`);
  for (const r of a.reasons) console.log(`    · ${r}`);
}

function main() {
  const state = loadState();
  printReport(state.assessment);

  if (!WANT_SIGN) {
    const c = state.assessment.counts;
    const blocking = c.stale > 0 || c.invalid > 0 || c.orphan > 0;
    console.log(`\n  --check 结束，未写盘。${blocking ? '⛔ 存在失效/非法签发，需先处理。' : ''}`);
    console.log('  签发命令：node bin/attest-baseline.mjs --sign --target=<kind>:<id> --by=<签发人> --mandate=<授权来源>');
    process.exit(blocking ? 2 : 0);
  }

  // ── --sign：以下每一步都在写盘之前 ───────────────────────────────────
  const target = flag('target');
  const by = flag('by');
  const mandate = flag('mandate');
  if (!target || !by || !mandate) {
    console.error('❌ --sign 需要 --target=<kind>:<id>、--by=<签发人>、--mandate=<授权来源>');
    process.exit(1);
  }
  const i = target.indexOf(':');
  const kind = i > 0 ? target.slice(0, i) : '';
  const id = i > 0 ? target.slice(i + 1) : '';
  if (!ATTESTABLE_TABLES.includes(kind) || !id) {
    console.error(`❌ --target 形态应为 ${ATTESTABLE_TABLES.join(' 或 ')} 后接 :<id>，收到 ${target}`);
    process.exit(1);
  }

  const table = kind === 'benchmark_frozen_set'
    ? state.evoTables.benchmark_frozen_set
    : state.evoTables.success_template;
  const row = (Array.isArray(table) ? table : Object.values(table ?? {}))
    .find((r) => targetIdOf(kind, r) === id);
  if (!row) {
    console.error(`❌ ${kind}:${id} 在生产存储中不存在 ⇒ 拒绝签发（不能给不存在的基准盖章）`);
    process.exit(1);
  }

  const existing = state.assessment.rows.find(
    (r) => r.targetKind === kind && r.targetId === id && r.status !== 'UNATTESTED',
  );
  if (existing) {
    console.error(`❌ ${kind}:${id} 已有签发记录（${existing.status}）⇒ 只增不改，拒绝覆盖`);
    console.error('   若内容确已变更，须由人撤销原签发后再重签；本脚本不提供自动覆盖。');
    process.exit(1);
  }

  // 写前二次核对：check 之后到落盘之前，行内容不得被并发改动。
  const hashAtCheck = rowHash(row);
  const fresh = loadState();
  const freshTable = kind === 'benchmark_frozen_set'
    ? fresh.evoTables.benchmark_frozen_set
    : fresh.evoTables.success_template;
  const freshRow = (Array.isArray(freshTable) ? freshTable : Object.values(freshTable ?? {}))
    .find((r) => targetIdOf(kind, r) === id);
  if (!freshRow || rowHash(freshRow) !== hashAtCheck) {
    console.error(`❌ ${kind}:${id} 在 --check 之后发生变化 ⇒ 拒绝签发，请重跑 --check`);
    process.exit(1);
  }

  const entry = makeAttestation({
    targetKind: kind, targetId: id, row: freshRow, signedBy: by, mandate,
  });

  // 备份：签发文件可能已存在（增量追加），先留一份可回滚副本。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${ATTEST_FILE}.bak-${stamp}`;
  let hadFile = false;
  if (existsSync(ATTEST_FILE)) {
    copyFileSync(ATTEST_FILE, backup);
    hadFile = true;
  }

  const prev = readJson(ATTEST_FILE);
  const prevTables = tablesOf(prev.data);
  const nextRows = { ...(prevTables[ATTESTATION_TABLE] ?? {}) };
  nextRows[entry.id] = entry;
  const next = {
    ...(prev.exists ? prev.data : {}),
    tables: { ...prevTables, [ATTESTATION_TABLE]: nextRows },
  };

  try {
    writeJsonNoBom(ATTEST_FILE, next);
    // 写后逐行复核：读回实算，目标行必须变 ATTESTED。
    const verify = loadState().assessment;
    const got = verify.rows.find((r) => r.targetKind === kind && r.targetId === id);
    if (!got || got.status !== 'ATTESTED') {
      throw new Error(`写后复核失败：目标行状态 ${got?.status ?? 'MISSING'}`);
    }
    console.log(`\n  ✅ 已签发 ${kind}:${id}`);
    console.log(`     签发人 ${entry.signedBy} · 授权 ${entry.mandate}`);
    console.log(`     contentHash ${entry.contentHash}`);
    console.log(`     复核 ${verify.counts.attested}/${verify.counts.total} 已签发 · baselineProvenance = ${verify.baselineProvenance}`);
    if (hadFile) console.log(`     备份 ${backup}`);
    console.log('     ⚠ 本脚本不代签。该记录的价值取决于签发人是否真的核过基准内容。');
  } catch (e) {
    // fail-closed：写后复核不过就回滚到备份 / 删除新建文件。
    if (hadFile) copyFileSync(backup, ATTEST_FILE);
    else rmSync(ATTEST_FILE, { force: true });
    console.error(`❌ 签发失败并已回滚：${e.message}`);
    process.exit(1);
  }
}

main();
