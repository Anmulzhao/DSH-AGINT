// 只读探针：直调 computeEffectiveDelta 纯函数，看生产 token 覆盖率/完成率。
// 完全绕过 apply——直接读 JSONL + import 纯函数。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_ROOT = 'D:\\DSH\\AGINT-date';
const jsonlPath = path.join(DEPLOY_ROOT, 'storages', 'agint_tool_stats.jsonl');

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 7;

// import 纯函数
const { computeEffectiveDelta, formatEffectiveDeltaLine, MIN_TOKEN_COVERAGE } =
  await import(pathToFileURL(path.join(__dirname, 'plugins', 'agint-quality', 'agint-quality-eval', 'lib', 'effectiveDelta.js')).href);
const { summarizeResourceWindow } =
  await import(pathToFileURL(path.join(DEPLOY_ROOT, '.agint-bundle', 'plugins', 'agint-tool-stats', 'lib', 'resource-window.js')).href);

// 自己实现 readAllRecords（tool-stats 内部函数没 export）
async function readAllRecords(p) {
  let raw;
  try { raw = await readFile(p, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const records = await readAllRecords(jsonlPath);
console.log(`[probe] records loaded: ${records.length}`);
const nowMs = Date.now();

const current = summarizeResourceWindow(records, {
  sinceMs: nowMs - DEFAULT_WINDOW_DAYS * DAY_MS,
  untilMs: nowMs,
});
const baseline = summarizeResourceWindow(records, {
  sinceMs: nowMs - 2 * DEFAULT_WINDOW_DAYS * DAY_MS,
  untilMs: nowMs - DEFAULT_WINDOW_DAYS * DAY_MS,
});

console.log('\n===== current window (近 7 天) =====');
console.log(JSON.stringify(current, null, 2));
console.log('\n===== baseline window (前 7 天) =====');
console.log(JSON.stringify(baseline, null, 2));

const ed = computeEffectiveDelta({
  baseline,
  current,
  minTokenCoverage: MIN_TOKEN_COVERAGE,
  origin: 'probe',
});

console.log('\n===== computeEffectiveDelta =====');
console.log('verdict:', ed.verdict, '| reason:', ed.reason);
console.log('value:', ed.value, '| shouldBlockDeploy:', ed.shouldBlockDeploy);
console.log('numerator:', ed.numerator, '| denominator:', ed.denominator);
console.log('terms:', JSON.stringify(ed.terms));
if (ed.tokenCoverage) console.log('tokenCoverage:', JSON.stringify(ed.tokenCoverage));
console.log('minTokenCoverage:', ed.minTokenCoverage);
console.log('\n' + formatEffectiveDeltaLine(ed));
