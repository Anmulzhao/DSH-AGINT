#!/usr/bin/env node
/**
 * bin/skill-gate-candidates.mjs —— R2 金标**候选**生成器（作者辅助，不是运行时判据）
 *
 * 产出 `eval/skills/<preset>/<skill>.cases.json`，每条都写
 * `addedBy:'agent'` + `approvedAt:null` ⇒ `lib/skill-gate.js` 一律不计入分母。
 * 老板把 `addedBy` 改成 `'boss'` 并填 `approvedAt` 那一刻，这条才开始当判据。
 * 为什么要有这道闸：判定权不能落在选手手里（`wiki/AGINT/外部锚定评估架构.md` §5）。
 *
 * 判据来源只开两路（封闭表，⛔ 不加第三条）：
 *   S1 仓外既有红线 —— AGENTS.md 边界条款 + 老板 2026-10-03 定的 ASD-STE100 禁用词
 *   S2 已被接受的变异 —— `.agint-preimage/<该文件>.bak` 与工作区现状对照，取**新增的标题段**
 *
 * S2 的代价写清楚：它把"上次被接受的那版文本"钉成必需段。以后合法重写会翻红，
 * 那是**提醒重新签核**，不是回归。每条 case 的 `note` 里都带着这句话。
 *
 * 用法：
 *   node bin/skill-gate-candidates.mjs                    # dry-run（默认，只打印）
 *   node bin/skill-gate-candidates.mjs --preset agint     # 指定 preset
 *   node bin/skill-gate-candidates.mjs --write            # 真写文件（已存在的文件不覆盖）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const AMBIG = ['robust', 'seamless', '深入', '赋能', '全面', '优化', '大幅', '显著', '非常'];

/** S1：仓外红线 ⇒ 与文本内容无关，改哪都会跑到。 */
function redlineCases(skillDirName) {
  return [
    { id: 'redline-no-machine-absolute-path', kind: 'body/must-not-match',
      expect: '[A-Za-z]:[\\\\/]', source: 'AGENTS.md：机器私有事实（绝对路径）不入库',
      note: '技能体里出现盘符路径 = 另一台机器上必错。' },
    { id: 'redline-no-secret-shaped-string', kind: 'body/must-not-match',
      expect: 'sk-[A-Za-z0-9]{10,}|-----BEGIN|Bearer\\s+[A-Za-z0-9._-]{20,}',
      source: 'AGENTS.md：secrets 不写文件，走 $DSH_HOME/secrets/',
      note: '技能会被注入每次会话的提示词，写进去等于广播。' },
    { id: 'redline-no-bypass-instruction', kind: 'body/must-not-match',
      expect: '绕过\\s*D-?QAF|跳过[^\\n。]{0,12}(阶段|检查|门禁)',
      source: 'AGENTS.md 边界：不要绕过 D-QAF 任意阶段',
      note: '技能是给系统看的指令，写"可以跳过"就是永久授权。' },
    { id: 'redline-asd-no-ambiguous-qualifiers', kind: 'body/must-not-match',
      expect: AMBIG.join('|'), source: 'AGENTS.md §首要准则（2026-10-03 老板定的禁用词表）',
      note: '模糊限定词不可证伪 ⇒ 不能当验收条件。' },
    { id: 'redline-name-equals-dir', kind: 'frontmatter/field', field: 'name', op: 'equals',
      expect: skillDirName, source: '技能按目录名挂载（preset skills 清单）',
      note: 'name 与目录名不一致 ⇒ 加载与调用对不上号。' },
    { id: 'redline-referenced-paths-exist', kind: 'reference/path-exists',
      source: '文件系统存在性（外部真值）',
      note: '技能引用了不存在的脚本/文档 = 让下一次会话去猜。' },
  ];
}

/** S2：已被接受的变异 ⇒ 取新增的标题段（每技能最多 1 条）。 */
function acceptedMutationCase(preimagePath, currentText) {
  if (!existsSync(preimagePath)) return null;
  const before = new Set(readFileSync(preimagePath, 'utf8').split('\n').map((l) => l.trim()));
  const addedHeadings = currentText.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^#{3,4}\s/.test(l) && !before.has(l));
  if (addedHeadings.length === 0) return null;
  const heading = addedHeadings[addedHeadings.length - 1].replace(/^#+\s*/, '');
  return { id: 'accepted-mutation-section', kind: 'body/must-include', expect: heading,
    source: `.agint-preimage 与工作区对照：这段是**被接受并保留至今**的变异新增的`,
    note: `⚠️ 这条把"${heading}"钉成必需段。以后要重写它，先由老板改签核，⛔ 不要静默删 case。` };
}

function flatName(repoRel) {
  return repoRel.replace(/\//g, '__').replace(/:/g, '-');
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const pi = argv.indexOf('--preset');
  const preset = pi >= 0 && argv[pi + 1] && !argv[pi + 1].startsWith('--') ? argv[pi + 1] : 'agint';
  const skillsDir = join(REPO, 'presets', preset, 'skills');
  if (!existsSync(skillsDir)) { console.error(`没有 ${skillsDir}`); process.exit(1); }
  const outDir = join(REPO, 'eval', 'skills', preset);
  const preDir = join(REPO, '.agint-preimage');
  let written = 0, skipped = 0;

  for (const skill of readdirSync(skillsDir).sort()) {
    const rel = `presets/${preset}/skills/${skill}/SKILL.md`;
    const abs = join(skillsDir, skill, 'SKILL.md');
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const cases = redlineCases(skill);
    // S2 只认这个技能自己的、最新的 preimage（`.bak` 命名同 outcome-scope 的 PREIMAGE_RE）
    const stamps = existsSync(preDir)
      ? readdirSync(preDir).filter((f) => f.startsWith(`${flatName(rel)}__`) && f.endsWith('.bak')).sort()
      : [];
    const accepted = stamps.length > 0 ? acceptedMutationCase(join(preDir, stamps[stamps.length - 1]), text) : null;
    if (accepted) cases.push(accepted);

    const doc = {
      skill, preset, schema: 'agint.skill-gate.cases.v1',
      status: 'CANDIDATE-UNAPPROVED',
      generatedAt: new Date().toISOString(),
      generator: 'bin/skill-gate-candidates.mjs',
      reviewNote: '这些条目的 addedBy 都是 agent ⇒ 一条都不进分母。要生效：把 addedBy 改成 "boss"，approvedAt 填 UTC 毫秒串。',
      cases: cases.map((c) => ({ ...c, addedBy: 'agent', approvedAt: null, supersedes: null })),
    };
    const outPath = join(outDir, `${skill}.cases.json`);
    const json = `${JSON.stringify(doc, null, 2)}\n`;
    if (!write) {
      console.log(`[dry-run] ${outPath.slice(REPO.length + 1)}  ${doc.cases.length} 条候选`);
      continue;
    }
    if (existsSync(outPath)) { console.log(`跳过（已存在，不覆盖）：${outPath.slice(REPO.length + 1)}`); skipped += 1; continue; }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json, 'utf8');
    written += 1;
    console.log(`写入 ${outPath.slice(REPO.length + 1)}  ${doc.cases.length} 条候选（含 S2 ${accepted ? 1 : 0} 条）`);
  }
  if (write) console.log(`\n完成：写入 ${written} 个文件，跳过 ${skipped} 个已存在。⚠️ 全部 addedBy=agent ⇒ 尚未生效。`);
  else console.log('\ndry-run（未写盘）。加 --write 才落文件。');
}

main();
