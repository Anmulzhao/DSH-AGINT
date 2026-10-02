#!/usr/bin/env node
/**
 * bin/rebuild-ledger-history.mjs —— 历史 Ledger 重建的**只读核对报告**（§4.3.5 / §4.6 #7）
 *
 * ## 为什么脚本只读，写入在宿主
 *
 * 与 `bin/anchor-ledger.mjs` 同一个理由：宿主存储后端把整个 unit 读进内存，
 * 每次 putRecord 用内存态整体重写 `agint_evolution.json`
 * （`@deepseek-ai/dsh-storage-json/lib/index.js:215-226`，自述 last-write-wins）
 * ⇒ 独立进程写的条目会在宿主下一次写入时被静默覆盖。链的写入因此只有
 * `plugins/agint-evolution-memory/lib/ledger.js` 这一个入口，重建也一样走它。
 *
 * 本脚本负责的是 §4.6 #7 里「重建脚本 + **人工核对**」的后半句：
 * 把准备入链的 6 条（或 N 条）逐字段摊开，连同**被拒绝的候选**和拒绝理由
 * 一起打印，让人在按下滑钮之前先看一遍证据够不够。
 *
 * ## 一份推导，两个入口
 *
 * 报告与宿主侧写入都 import `lib/ledger-rebuild.js` 的 `buildRebuildPlan`
 * （§4.3.5）。抄两份的后果不是"代码重复"，是**人核对过的那份计划与实际
 * 入链的那份不是同一套口径** —— 那正好废掉人工核对这道闸。
 *
 * 用法：
 *   node bin/rebuild-ledger-history.mjs                 # 人类可读报告
 *   node bin/rebuild-ledger-history.mjs --json          # 机器可读计划
 *   node bin/rebuild-ledger-history.mjs --out <文件>    # 计划落盘留档（⛔ 不写存储）
 *   node bin/rebuild-ledger-history.mjs --storages <目录> --repo <目录>
 * 退出码：0 = 计划可入链 / 1 = 时序窗口已关 或 证据不足 5 条 / 2 = 取数失败
 *
 * 实际入链（人工核对之后）：宿主服务方法
 *   agint.evolution.ledger.rebuild({ apply: true })    ← 工具 evolution_ledgerRebuildApply
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRebuildPlan } from '../plugins/agint-evolution-memory/lib/ledger-rebuild.js';
import { createFileSourceLoader, readUnitTable, resolveStoragesDir } from '../plugins/agint-evolution-memory/lib/ledger-rebuild-sources.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

function parseArgs(argv) {
  const opts = { storages: resolveStoragesDir(process.env), repo: REPO_ROOT, json: false, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--storages') opts.storages = argv[++i];
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

/** 链现状：只为了判 §4.3.5 的时序窗口，⛔ 不修不写。 */
function readChainState(storagesDir) {
  const file = join(storagesDir, 'agint_evolution.json');
  if (!existsSync(file)) return { file, entries: [], tableAbsent: true };
  const entries = readUnitTable(file, 'agint_evolution', 'evolution_ledger')
    .filter((e) => Number.isInteger(e?.seq))
    .sort((a, b) => a.seq - b.seq);
  return { file, entries, tableAbsent: false };
}

function shortId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 8)}…` : String(id ?? '—');
}

function renderText(plan, chain, opts) {
  const L = [];
  const live = chain.entries.filter((e) => e?.reconstructed !== true);
  const reconstructed = chain.entries.length - live.length;
  L.push(`重建源：${opts.storages}`);
  L.push(`  event_bus 事件 ${plan.sources.events} 条 · population variants ${plan.sources.variants} 行`
    + ` · preimage 探测 ${plan.sources.preimageProbed ? '开' : '关'}`);
  L.push(`链现状（${chain.file}）：${chain.entries.length} 条（实时 ${live.length} / 重建 ${reconstructed}）`
    + `${chain.tableAbsent ? ' · evolution_ledger 表尚未落表' : ''}`);
  L.push(live.length === 0
    ? '⇒ §4.3.5 时序窗口【开】：现在重建可以排在链首。'
    : `⇒ §4.3.5 时序窗口【已关】：链上有 ${live.length} 条实时条目，向中间插入会让后续 parentHash 全部失配。`
      + ' 唯一合法的后补动作是追加尾部并如实标注，那是单独的人工决定。');

  L.push('');
  L.push(`可重建 ${plan.entries.length} 条（排序键 = timestamp 升序，即入链顺序；seq 由 ledger service 分配）：`);
  L.push(' #  timestamp(UTC)            决策            完整度   mutationType      contractId');
  plan.entries.forEach((e, i) => {
    L.push(`${String(i + 1).padStart(2)}  ${e.timestamp}  ${e.summary.decision.padEnd(14)}  `
      + `${e.evidenceCompleteness.padEnd(8)}  ${e.summary.mutationType.padEnd(16)}  ${e.contractId}`);
    L.push(`     generation=${e.generation}  changedPlugins=[${e.summary.changedPlugins.join(', ') || '—'}]`
      + `  targetMetric=${e.summary.targetMetric}`);
    L.push(`     refs: events=[${e.references.eventBusIds.map(shortId).join(', ') || '—'}]`
      + ` candidate=${shortId(e.references.populationCandidateId)}`
      + ` preimage=${e.references.preimagePath ?? 'null'}`);
    L.push(`     缺证据: ${e.evidence.missingEvidence.length ? e.evidence.missingEvidence.join(', ') : '（无）'}`);
    L.push(`     digest: ${e.summary.hypothesisDigest}`);
  });

  L.push('');
  L.push(`拒绝重建 ${plan.blockers.length} 条（§4.3.5 规则 3：证据不全的字段留 null，⛔ 不推测填值）：`);
  if (plan.blockers.length === 0) L.push('  （无）');
  for (const b of plan.blockers) {
    L.push(`  - ${shortId(b.eventBusId)} ${b.topic} @${b.occurredAt}`);
    L.push(`      ${b.code}: ${b.detail}`);
  }

  // 门槛与窗口两条判据分开报，避免"能重建但窗口关了"被误读成"取数错了"。
  const gates = [];
  if (live.length > 0) gates.push('REBUILD_TIMING_CLOSED');
  if (plan.entries.length < 5) gates.push('REBUILD_INSUFFICIENT_EVIDENCE（§4.6 #7 门槛 ≥5 条）');
  L.push('');
  if (gates.length === 0) {
    L.push(`→ 人工核对无误后，在宿主内入链（⛔ 不要手改 agint_evolution.json）：`);
    L.push('     工具 evolution_ledgerRebuildApply { opts: { apply: true } }');
    L.push('     或服务方法 agint.evolution.ledger.rebuild({ apply: true })');
    L.push('   入链后立刻校验：node bin/verify-ledger-chain.mjs --full');
  } else {
    L.push(`→ 本轮不入链：${gates.join(' + ')}`);
  }
  return `${L.join('\n')}\n`;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write('用法：node bin/rebuild-ledger-history.mjs [--json] [--out <文件>] [--storages <目录>] [--repo <目录>]\n只读报告，不写存储、不 commit。\n');
    return 0;
  }
  const load = createFileSourceLoader({ storagesDir: opts.storages, repoRoot: opts.repo });
  const src = await load();
  const plan = buildRebuildPlan(src);
  const chain = readChainState(opts.storages);
  const live = chain.entries.filter((e) => e?.reconstructed !== true);
  const code = live.length > 0 ? 'REBUILD_TIMING_CLOSED'
    : (plan.entries.length < 5 ? 'REBUILD_INSUFFICIENT_EVIDENCE' : 'REBUILD_READY');

  if (opts.out) {
    // 只写调用方指定的**报告留档**文件，⛔ 绝不写 storages（那里写不动，见头注）。
    if (opts.out.startsWith(opts.storages)) throw new Error(`--out 不得指向存储目录：${opts.out}`);
    writeFileSync(opts.out, `${JSON.stringify({ generatedAt: new Date().toISOString(), code, chainHeadSeq: chain.entries.at(-1)?.seq ?? null, ...plan }, null, 2)}\n`, 'utf8');
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ code, sources: plan.sources, chain: { entries: chain.entries.length, live: live.length }, counts: plan.counts, entries: plan.entries, blockers: plan.blockers }, null, 2)}\n`);
  } else {
    process.stdout.write(renderText(plan, chain, opts));
  }
  return code === 'REBUILD_READY' ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`rebuild-ledger-history 失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
}
