/**
 * v2-scan: L0.5 代码层真源扫描器（设计稿 §1.2/§1.4）。
 *
 * 规则（生产版）：
 *  - 命中形如 ctx.get('agint.…') / ctx.provide('agint.…')（单/双/反引号）。
 *  - 注释态命中 → kind=comment（文档腐化候选，不建边）。
 *  - code 态 provide → 进 provided 表（不进 hits）。
 *  - code 态 get：provided 里存在该键的严格子键（K. 前缀）→ kind=umbrella
 *    （cordis 服务存储扁平，裸命名空间键恒 undefined，§1.4 不建边）；否则 kind=code。
 *
 * 已知限制（照实记录）：
 *  - 注释解析不处理模板串 ${} 嵌套与正则字面量；对 ctx.get 形态影响面≈0。
 *  - 与 2026-10-03 效果稿基线的两处分类差异（见实施计划 Task 2）：
 *    ① 注释里提到伞键的命中，效果稿标 umbrella，本规则一律标 comment；
 *    ② 提供方自己的伞键 ctx.provide 行，效果稿记进 hits，本规则 provide 不进 hits。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const KEY_RE = /ctx\s*\.\s*(get|provide)\s*\(\s*(['"`])(agint\.[A-Za-z0-9_.]+)\2\s*[,)]/g;

/**
 * 单行注释掩码：mask[i]=true 表示该行第 i 个字符处于注释态。
 * state = { block, tick } 跨行携带（块注释与反引号模板串可跨行；单双引号不跨行）。
 * @param {string} line - 不含换行符的一行
 * @param {{block:boolean,tick:boolean}} state - 行首状态
 * @returns {{ mask: boolean[], state: {block:boolean,tick:boolean} }}
 */
export function commentMask(line, state) {
  const mask = new Array(line.length).fill(false);
  let block = state.block;
  let quote = state.tick ? '`' : null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const n = line[i + 1];
    if (block) {
      mask[i] = true;
      if (c === '*' && n === '/') { mask[i + 1] = true; block = false; i += 1; }
      continue;
    }
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      for (let j = i; j < line.length; j += 1) mask[j] = true;
      break;
    }
    if (c === '/' && n === '*') {
      block = true;
      mask[i] = true;
      if (i + 1 < line.length) mask[i + 1] = true;
      i += 1;
      continue;
    }
    if (c === '`') { quote = '`'; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
  }
  const tick = quote === '`'; // 反引号未闭合 → 跨行；单双引号不跨行，行尾丢弃
  return { mask, state: { block, tick } };
}

/** 递归列出 dir 下全部 .js 文件（绝对路径）。目录不可读返回空数组。 */
function listJs(dir, out = []) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 扫描 pluginsDir 下全部 agint-* 插件 lib 目录里的 .js 文件。
 * @param {string} pluginsDir
 * @returns {{ hits: Array<[pl:string, relFile:string, line:number, key:string, kind:'code'|'comment'|'umbrella']>,
 *   provided: Record<string,string>, familyDirs: string[], scannedAt: string, errors: Array<{file:string,reason:string}> }}
 */
export function scanPlugins(pluginsDir) {
  const errors = [];
  const provided = Object.create(null);
  const gets = [];
  let dirs = [];
  try {
    dirs = readdirSync(pluginsDir)
      .filter((d) => d.startsWith('agint-') && !d.includes('.bak-'))
      .filter((d) => { try { return statSync(join(pluginsDir, d)).isDirectory(); } catch { return false; } })
      .sort();
  } catch (err) {
    return {
      hits: [], provided: {}, familyDirs: [], scannedAt: new Date().toISOString(),
      errors: [{ file: pluginsDir, reason: String((err && err.message) ?? err).slice(0, 200) }],
    };
  }
  for (const pl of dirs) {
    const plRoot = join(pluginsDir, pl);
    for (const abs of listJs(join(plRoot, 'lib'))) {
      const rel = relative(plRoot, abs).split(sep).join('/');
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch (err) {
        errors.push({ file: `${pl}/${rel}`, reason: String((err && err.message) ?? err).slice(0, 200) });
        continue;
      }
      const lines = text.split('\n');
      let st = { block: false, tick: false };
      for (let ln = 0; ln < lines.length; ln += 1) {
        const { mask, state } = commentMask(lines[ln], st);
        st = state;
        KEY_RE.lastIndex = 0;
        let m;
        while ((m = KEY_RE.exec(lines[ln])) !== null) {
          const rec = { pl, rel, line: ln + 1, key: m[3], call: m[1], inComment: mask[m.index] === true };
          if (rec.call === 'provide' && !rec.inComment) {
            if (!(rec.key in provided)) provided[rec.key] = pl;
          } else if (rec.call === 'get') {
            gets.push(rec);
          }
        }
      }
    }
  }
  const hasSub = (key) => Object.keys(provided).some((k) => k.startsWith(`${key}.`));
  const hits = gets.map((g) => [g.pl, g.rel, g.line, g.key,
    g.inComment ? 'comment' : (hasSub(g.key) ? 'umbrella' : 'code')]);
  hits.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);
  return { hits, provided: { ...provided }, familyDirs: dirs, scannedAt: new Date().toISOString(), errors };
}
