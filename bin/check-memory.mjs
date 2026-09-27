#!/usr/bin/env node
/**
 * check-memory.mjs — 记忆层自检：防止「索引指向不存在的条目」这类**自造事实**。
 *
 * # 为什么需要它
 * 2026-09-27 复盘时发现两处只有人眼撞见才会暴露的缺陷：
 *   ① `MEMORY.md` 索引里**已经写着 K116**，而 `KNOWLEDGE.md` 里根本没有这条 ——
 *      索引指向不存在的条目。这不是"记漏了"，是**制造了一个假事实**：
 *      未来的我按索引去 grep，会得到"知识库里查不到"这种更坏的结论。
 *   ② `K110` 有**两条**（同日相隔 2 小时各写一份），而文件里声明「K 号有 8 组重复」
 *      **没有把 K110 算进去** —— 声明本身腐坏了，谁按声明去避坑就会踩空。
 *
 * 这两类的共同点：**它们的错误不在内容，在"元数据与正文的一致性"**。
 * 靠记忆和自觉挡不住（人只会在用到时才发现），必须机器扫。
 *
 * # 查什么
 *   [F] 索引存在性   MEMORY.md 引用的每个 K<号> 必须在 KNOWLEDGE.md 有对应 `## K<号>` 标题
 *   [F] 重复声明一致  MEMORY.md 声明的"重复 K 号"集合 == KNOWLEDGE.md 里实际的重复 K 号集合
 *   [W] 重复 K 号     KNOWLEDGE.md 同一 K 号出现多次（未重编号属存量，但要可见）
 *   [W] 体积          MEMORY.md 字符数超阈值（历史三次超限被截断）
 *   [W] 路径引用      MEMORY.md 里反引号包住的仓库相对路径必须真实存在
 *   [W] 技能引用      MEMORY.md 里「技能 `xxx`」指向的技能必须真实存在
 *   [I] 孤儿 K        KNOWLEDGE.md 里有、MEMORY.md 索引里未引用的 K 号（可能漏编入索引）
 *   [I] 当日日志      今天的 YYYY-MM-DD.md 是否存在
 *
 * # 用法
 *   node bin/check-memory.mjs [--memory-dir <dir>] [--repo <dir>] [--max-chars <n>] [--json]
 *
 * 默认 memory-dir = <repo>/../.workbuddy/memory（本机 D:/DSH/.workbuddy/memory）。
 * 退出码 0 = 无 FAIL；1 = 有 FAIL（[F]）；--json 供 CI 消费。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/** 从仓库根向上找 `.workbuddy/memory`（本机仓库在 D:/DSH/project源码/DSH-AGINT，
 *  记忆目录在其上两级：D:/DSH/.workbuddy/memory —— 写死相对层级会在换目录时静默找错）。
 *  ⚠️ 沿路上可能撞见**残废候选**（只有 MEMORY.md 没有 KNOWLEDGE.md）——
 *  本机实测仓库内就有 `DSH-AGINT/.workbuddy/memory/`（09-05/09-06 的旧目录，未跟踪）。
 *  判据 = **必须有 KNOWLEDGE.md** 才算活的那份；残废候选单独报出来（记忆分裂是事故，不是噪音）。 */
function findMemoryDir(start) {
  const strays = [];
  let cur = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const cand = path.join(cur, '.workbuddy', 'memory');
    if (fs.existsSync(path.join(cand, 'MEMORY.md'))) {
      if (fs.existsSync(path.join(cand, 'KNOWLEDGE.md'))) return { dir: cand, strays };
      strays.push(cand);
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { dir: path.join(os.homedir(), '.workbuddy', 'memory'), strays };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const REPO = path.resolve(argOf('--repo', path.resolve(HERE, '..')));
const _found = findMemoryDir(REPO);
const MEM_DIR = path.resolve(argOf('--memory-dir', '') || _found.dir);
const STRAY_DIRS = _found.strays;
const MAX_CHARS = Number(argOf('--max-chars', '9500'));
const AS_JSON = argv.includes('--json');
const SKILLS_ROOTS = [path.join(os.homedir(), '.workbuddy', 'skills')];

const findings = [];
const stats = { kHeadings: 0, kRefs: 0, pathRefs: 0, skillRefs: 0 };
const add = (level, code, msg, extra = {}) => findings.push({ level, code, msg, ...extra });
const chars = (s) => [...s].length;

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();

function main() {
  // ── [W] 记忆分裂：沿路撞见的残废记忆目录 ─────────────────────────
  for (const d of STRAY_DIRS) {
    const files = fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort();
    add('W', 'stray-memory-dir',
      `${d} 是一个没有 KNOWLEDGE.md 的旧记忆目录（${files.join(', ')}）—— 记忆分裂残留，需人工裁定合并或归档`);
  }

  const memPath = path.join(MEM_DIR, 'MEMORY.md');
  const kPath = path.join(MEM_DIR, 'KNOWLEDGE.md');
  const mem = readIf(memPath);
  const kd = readIf(kPath);
  if (mem === null) return add('F', 'memory-missing', `找不到 ${memPath}`);
  if (kd === null) return add('F', 'knowledge-missing', `找不到 ${kPath}`);

  // ── 解析 KNOWLEDGE.md 里的 K 号标题 ────────────────────────────────
  const kLines = kd.split(/\r?\n/);
  const headings = new Map(); // K号 -> [行号]
  kLines.forEach((line, i) => {
    const m = /^##\s+K(\d+)(?!\d)/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (!headings.has(n)) headings.set(n, []);
      headings.get(n).push(i + 1);
    }
  });

  // ── [F] 索引存在性：MEMORY.md 引用的 K 号必须真实存在 ───────────────
  const cited = new Set();
  for (const m of mem.matchAll(/\bK(\d{1,3})\b/g)) cited.add(Number(m[1]));
  stats.kHeadings = headings.size;
  stats.kRefs = cited.size;
  const missing = [...cited].filter((n) => !headings.has(n)).sort((a, b) => a - b);
  for (const n of missing) {
    add('F', 'dangling-k', `MEMORY.md 引用了 K${n}，但 KNOWLEDGE.md 没有 \`## K${n}\` 条目（索引指向不存在的条目）`);
  }

  // ── [F] 重复声明一致性 ────────────────────────────────────────────
  const actualDup = [...headings.entries()].filter(([, l]) => l.length > 1).map(([n]) => n).sort((a, b) => a - b);
  const declaredLine = kLines && mem.split(/\r?\n/).findIndex((l) => /K\s*号有\s*\d+\s*组重复/.test(l));
  if (declaredLine >= 0) {
    const memLines = mem.split(/\r?\n/);
    const declared = new Set();
    const claimed = Number(/K\s*号有\s*(\d+)\s*组重复/.exec(memLines[declaredLine])[1]);
    for (let i = declaredLine; i < memLines.length && i < declaredLine + 12; i++) {
      if (i > declaredLine && /^\s*$/.test(memLines[i])) break;
      if (i > declaredLine && /^##\s/.test(memLines[i])) break;
      for (const m of memLines[i].matchAll(/K(\d+)/g)) declared.add(Number(m[1]));
    }
    const undeclared = actualDup.filter((n) => !declared.has(n));
    const overdeclared = [...declared].filter((n) => !actualDup.includes(n)).sort((a, b) => a - b);
    if (undeclared.length) {
      add('F', 'dup-undeclared',
        `实际重复的 K 号未在 MEMORY.md 声明：${undeclared.map((n) => 'K' + n).join(' / ')}（声明说有 ${claimed} 组，实际 ${actualDup.length} 组）`);
    }
    if (overdeclared.length) {
      add('W', 'dup-overdeclared',
        `MEMORY.md 声明重复但实际不重复：${overdeclared.map((n) => 'K' + n).join(' / ')}`);
    }
    if (claimed !== actualDup.length) {
      add('W', 'dup-count-mismatch', `声明的组数 ${claimed} ≠ 实测 ${actualDup.length}`);
    }
  } else if (actualDup.length > 0) {
    // 有重复却连声明都没有 —— 与「声明漏了 K110」是同一种病（谁按声明避坑谁踩空），同判 FAIL。
    add('F', 'dup-undeclared',
      `KNOWLEDGE.md 有 ${actualDup.length} 组重复 K 号（${actualDup.map((n) => 'K' + n).join(' / ')}），MEMORY.md 未声明`);
  }

  // ── [W] 重复 K 号明细 ────────────────────────────────────────────
  for (const n of actualDup) {
    add('W', 'dup-k', `K${n} 在 KNOWLEDGE.md 出现 ${headings.get(n).length} 次（行 ${headings.get(n).join(', ')}）—— 引用时先看主题`);
  }

  // ── [W] MEMORY.md 体积（历史三次超限被截断：09-21 / 09-26 / 09-27） ─
  const memChars = chars(mem);
  if (memChars > MAX_CHARS) {
    add('W', 'memory-too-large',
      `MEMORY.md ${memChars} 字符 > ${MAX_CHARS}（本文件只放硬规则+索引；新知识写 KNOWLEDGE.md）`);
  }

  // ── [W] 路径引用存在性 ──────────────────────────────────────────
  const PATH_RE = /`((?:docs|bin|plugins|presets|install)\/[\w./@*-]+)`/g;
  const seenPaths = new Set();
  for (const m of mem.matchAll(PATH_RE)) {
    const p = m[1];
    if (seenPaths.has(p) || p.includes('*') || p.includes('<')) continue;
    seenPaths.add(p);
    stats.pathRefs++;
    const abs = path.join(REPO, p);
    const ok = p.endsWith('/') ? isDir(abs) : fs.existsSync(abs) || isDir(abs);
    if (!ok) add('W', 'path-ref-missing', `MEMORY.md 引用的路径不存在：${p}`);
  }

  // ── [W] 技能引用存在性（「技能 `xxx`」） ─────────────────────────
  const skillSeen = new Set();
  for (const m of mem.matchAll(/技能\s+`([a-z0-9][a-z0-9-]*)`/g)) {
    const name = m[1];
    if (skillSeen.has(name)) continue;
    skillSeen.add(name);
    stats.skillRefs++;
    const ok = SKILLS_ROOTS.some((r) => fs.existsSync(path.join(r, name, 'SKILL.md')) || fs.existsSync(path.join(r, `${name}.md`)));
    if (!ok) add('W', 'skill-ref-missing', `MEMORY.md 引用的技能不存在：${name}`);
  }

  // ── [I] 孤儿 K：知识库有、索引未引用 ────────────────────────────
  const orphans = [...headings.keys()].filter((n) => !cited.has(n)).sort((a, b) => a - b);
  if (orphans.length) {
    add('I', 'orphan-k', `KNOWLEDGE.md 有 ${orphans.length} 个 K 号未编入 MEMORY.md 索引（最近：${
      orphans.slice(-6).map((n) => 'K' + n).join(' / ')}）`);
  }

  // ── [I] 当日日志 ────────────────────────────────────────────────
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (!fs.existsSync(path.join(MEM_DIR, `${stamp}.md`))) {
    add('I', 'no-daily-log', `今日日志 ${stamp}.md 尚不存在`);
  }
}

main();

const fails = findings.filter((f) => f.level === 'F');
const warns = findings.filter((f) => f.level === 'W');
const infos = findings.filter((f) => f.level === 'I');

if (AS_JSON) {
  console.log(JSON.stringify({
    memoryDir: MEM_DIR, repo: REPO, stats,
    counts: { fail: fails.length, warn: warns.length, info: infos.length },
    findings,
  }, null, 2));
} else {
  const tag = { F: 'FAIL', W: 'WARN', I: 'INFO' };
  for (const f of [...fails, ...warns, ...infos]) {
    console.log(`[${tag[f.level]}] ${f.code}: ${f.msg}`);
  }
  // ⭐ 统计必须打印：0 报错可能是「检查项一条都没匹配上」—— 那是最隐蔽的假绿（K112 教训）。
  console.log(`
check-memory: 扫 ${stats.kHeadings} 条 K 标题 / ${stats.kRefs} 个 K 引用 / ${stats.pathRefs} 个路径引用 / ${stats.skillRefs} 个技能引用`);
  console.log(`check-memory: ${fails.length} fail, ${warns.length} warn, ${infos.length} info  (dir=${MEM_DIR})`);
}
process.exit(fails.length > 0 ? 1 : 0);
