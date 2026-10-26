/**
 * 工作区指令体积哨兵（agents-size-guard）。
 *
 * 起因（2026-10-18 老板诉求）：AGENTS.md 每轮注入上下文，体积 = 每轮固定开销。
 * 它自己写死了双限（≤10000 字节 且 ≤5000 字符），但没人每天去核 —— 超限只有
 * 两种发现方式：人碰巧看一眼，或宿主 12000 预算把整份丢弃（丢弃时不压缩，只在
 * 上下文里报一句 Workspace instruction budget）。本模块把「核」这件事自动化。
 *
 * ⛔ 老板 2026-10-18 拍板：**只告警，不自动改**。
 * 理由（写在这里防止后来者顺手加自动压缩）：压缩顺序（删重复 → 删过期 →
 * 长段挪进 docs/ 只留一行指路）是**给人执行的判据**，不是给无人值守脚本执行的。
 * AI 自己决定删哪一段，可能删掉老板刚写进去的约定，而它自己不会觉得有问题。
 * 误删约定的代价 > 超限的代价 —— 所以本模块只读、只算、只写报告。
 *
 * 可靠性约束（见 check-soundness 技能）：
 *   1. 输入源消失（文件读不到 / 报告目录建不了）必须抛错，绝不静默 skip。
 *      「取不到基线」=「被检对象不合格」，不是「被检对象没问题」。
 *   2. 判据只含体积常量。时间戳只写进报告留痕，不参与任何判定 —— 否则门禁
 *      每次运行都必然报红，沦为噪声。
 *   3. 写盘固定 LF（跨机器字节级一致）。
 *   4. 字节数按 UTF-8 重新编码计算（Buffer.byteLength），不取 stat.size ——
 *      后者含 BOM 且随文件系统差异漂移。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 10000, // AGENTS.md §本文件大小硬限
  maxChars: 5000,
  hostBudgetBytes: 12000, // profiles/desktop/cordis.patch.yml agent-instructions.maxBytes
});

// 接近上限就出声：留 10% 提前量。超限是事后，逼近上限才来得及安排压缩。
const WARN_RATIO = 0.9;

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
const charsOf = (s) => [...s].length;

// 段落切分后重新拼串时，末尾的空行会丢掉它自己的分隔符（`split` 吃掉换行，
// `join` 不补最后一个）⇒ 各段字节之和比全文少 1 字节（单测实测 33 ≠ 34）。
// 体积哨兵自己算错体积，是最难查的一种假绿。
const rejoin = (lines, atEof) => lines.join('\n') + (atEof && lines[lines.length - 1] === '' ? '\n' : '');

/**
 * 按 Markdown 标题切段，逐段算字节/字符。
 * 目的是让报告能回答「砍哪一段最划算」，而不只是「你超限了」。
 */
export function measureSections(text) {
  const lines = text.split(/\r?\n/);
  const marks = [];
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) marks.push({ i, level: m[1].length, title: m[2].trim() });
  });

  if (marks.length === 0) {
    return [{ title: '(全文无标题)', level: 0, bytes: bytesOf(text), chars: charsOf(text), lines: lines.length }];
  }

  const out = [];
  if (marks[0].i > 0) {
    const t = rejoin(lines.slice(0, marks[0].i), false);
    out.push({ title: '(文件头)', level: 0, bytes: bytesOf(t), chars: charsOf(t), lines: marks[0].i });
  }
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].i;
    const atEof = k + 1 === marks.length;
    const end = atEof ? lines.length : marks[k + 1].i;
    const t = rejoin(lines.slice(start, end), atEof);
    out.push({ title: marks[k].title, level: marks[k].level, bytes: bytesOf(t), chars: charsOf(t), lines: end - start });
  }
  return out;
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function pickNumber(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * @param {object} opts
 * @param {string} opts.file          被核文件绝对路径（AGENTS.md）
 * @param {string} opts.reportDir     告警报告落盘目录（docs/）
 * @param {string} [opts.localFile]   本机覆盖层（AGENTS.local.md），存在则计入宿主预算
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxChars]
 * @param {number} [opts.hostBudgetBytes]
 */
export async function runAgentsSizeGuard(opts = {}) {
  const { file, reportDir, localFile } = opts;
  if (!file || typeof file !== 'string') {
    throw new Error('agents-size-guard: config.file 缺失（patch.yml 的 agint-cron.agentsSizeGuard.file）');
  }
  if (!reportDir || typeof reportDir !== 'string') {
    throw new Error('agents-size-guard: config.reportDir 缺失（patch.yml 的 agint-cron.agentsSizeGuard.reportDir）');
  }

  const limits = {
    maxBytes: pickNumber(opts.maxBytes, DEFAULT_LIMITS.maxBytes),
    maxChars: pickNumber(opts.maxChars, DEFAULT_LIMITS.maxChars),
    hostBudgetBytes: pickNumber(opts.hostBudgetBytes, DEFAULT_LIMITS.hostBudgetBytes),
  };

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    // 输入源消失 = 被检对象不合格。报红，不 skip。
    throw new Error(`agents-size-guard: 读不到 ${file}（${e.code || e.message}）`);
  }

  const bytes = bytesOf(text);
  const chars = charsOf(text);
  const lines = text.split(/\r?\n/).length;

  // 覆盖层：不存在是正常态（多数机器没有 AGENTS.local.md），不计入也不报错。
  // 但如果配了却读不到，那是配置错了 —— 同样报红。
  let localBytes = 0;
  let localPresent = false;
  if (localFile) {
    try {
      localBytes = bytesOf(await readFile(localFile, 'utf8'));
      localPresent = true;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw new Error(`agents-size-guard: localFile 配了但读不到 ${localFile}（${e.code || e.message}）`);
      }
    }
  }

  const overBytes = Math.max(0, bytes - limits.maxBytes);
  const overChars = Math.max(0, chars - limits.maxChars);
  const critical = overBytes > 0 || overChars > 0;
  const warn =
    !critical &&
    (bytes >= limits.maxBytes * WARN_RATIO || chars >= limits.maxChars * WARN_RATIO);
  const level = critical ? 'critical' : warn ? 'warn' : 'ok';

  const budgetUsed = bytes + localBytes;
  const hostDropRisk = budgetUsed > limits.hostBudgetBytes;

  const sections = measureSections(text)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10)
    .map((s) => ({
      title: s.title,
      level: s.level,
      bytes: s.bytes,
      chars: s.chars,
      pctBytes: bytes > 0 ? Math.round((s.bytes / bytes) * 1000) / 10 : 0,
    }));

  const result = {
    file,
    bytes,
    chars,
    lines,
    limits,
    overBytes,
    overChars,
    critical,
    warn,
    level,
    localFile: localFile ?? null,
    localPresent,
    localBytes,
    budgetUsed,
    hostBudgetBytes: limits.hostBudgetBytes,
    hostDropRisk,
    sections,
    reportPath: null,
    wroteReport: false,
  };

  // 只在「有事要说」时写盘，避免每天都往 docs/ 丢一份无信息量的报告。
  if (level !== 'ok' || hostDropRisk) {
    const stamp = localStamp();
    const reportPath = join(reportDir, `AGENTS-体积告警-${stamp}.md`);
    const content = renderReport(result);
    try {
      await mkdir(reportDir, { recursive: true });
      await writeFile(reportPath, content, 'utf8'); // 固定 LF
      result.reportPath = reportPath;
      result.wroteReport = true;
    } catch (e) {
      throw new Error(`agents-size-guard: 报告写盘失败 ${reportPath}（${e.code || e.message}）`);
    }
  }

  return result;
}

/** cron 面要的紧凑摘要（进 lastResultSummary，重启后仍可读）。 */
export function summarizeGuard(r) {
  return {
    level: r.level,
    bytes: r.bytes,
    chars: r.chars,
    overBytes: r.overBytes,
    overChars: r.overChars,
    hostDropRisk: r.hostDropRisk,
    wroteReport: r.wroteReport,
    report: r.reportPath,
  };
}

function renderReport(r) {
  const L = r.limits;
  const pad = (n) => String(n);
  const row = (name, v, lim) =>
    `| ${name} | ${pad(v)} | ${pad(lim)} | ${pad(lim - v)} |`;

  const verdict = r.critical
    ? `AGENTS.md 已超限：${r.bytes} 字节 / ${r.chars} 字符（上限 ${L.maxBytes} 字节 / ${L.maxChars} 字符）。`
    : r.hostDropRisk
      ? `AGENTS.md 未触双限，但已撑破宿主预算（${r.budgetUsed} > ${L.hostBudgetBytes} 字节）—— 宿主会整份丢弃注入。`
      : `AGENTS.md 接近上限（${r.bytes} 字节 / ${r.chars} 字符），尚未超限。`;

  const lines = [];
  lines.push(`# AGENTS.md 体积告警（${localStamp()}）`);
  lines.push('');
  lines.push(
    '> 本文件由 cron job `agents-size-guard` 自动生成（每日 06:45）。仅在超限 / 逼近上限 /',
  );
  lines.push('> 撑破宿主预算时生成。**本 job 不会修改 AGENTS.md —— 压缩由人执行。**');
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(verdict);
  lines.push('');
  lines.push('| 指标 | 实测 | 上限 | 余量 |');
  lines.push('|---|---|---|---|');
  lines.push(row('字节', r.bytes, L.maxBytes));
  lines.push(row('字符', r.chars, L.maxChars));
  lines.push(row('宿主预算用量', r.budgetUsed, L.hostBudgetBytes));
  lines.push('');
  lines.push(
    r.localFile
      ? `宿主预算用量 = AGENTS.md ${r.bytes} + 覆盖层 ${r.localPresent ? r.localBytes : 0}` +
        `（${r.localFile}${r.localPresent ? '' : '，不存在故不计入'}）。`
      : '未配置 localFile，宿主预算用量只含 AGENTS.md 本身 —— 若本机另有 AGENTS.local.md，实际用量会更高。',
  );
  lines.push('');
  lines.push('## 各段落实测体积（按字节降序，前 10）');
  lines.push('');
  lines.push('| 段落 | 层级 | 字节 | 占比 | 字符 |');
  lines.push('|---|---|---|---|---|');
  for (const s of r.sections) {
    lines.push(`| ${s.title} | ${'#'.repeat(s.level) || '—'} | ${s.bytes} | ${s.pctBytes}% | ${s.chars} |`);
  }
  lines.push('');
  lines.push('## 建议动作（AGENTS.md「本文件大小硬限」规定的压缩顺序）');
  lines.push('');
  lines.push('1. 删重复表述。');
  lines.push('2. 删过期条目。');
  lines.push('3. 长段挪进 `docs/`，只留一行指路。');
  lines.push('');
  lines.push('## 边界说明');
  lines.push('');
  lines.push('- 字节数 = UTF-8 重新编码长度（`Buffer.byteLength`），不取 `stat.size`。');
  lines.push('- 字符数 = Unicode 码点数（`[...text].length`）。');
  lines.push('- 时间戳只作留痕，不参与超限判定。');
  lines.push('');
  return lines.join('\n');
}
