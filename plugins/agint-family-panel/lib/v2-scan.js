/**
 * v2-scan: L0.5 代码层真源扫描器（设计稿 §1.2/§1.4）。
 *
 * 规则（v0.3.0，2026-10-04 修「面板 6 条误报」）：
 *  - 命中 ctx.get('…') / ctx.provide('…')，**可选链写法同样命中**
 *    （ctx?.get?.('…') / ctx?.get('…')，evolution-driver lib/index.js:1639 形态）。
 *  - **不再只认 `agint.` 前缀**：cordis 服务键分两类，本仓都真实存在 ——
 *    ① 家族服务 `agint.*`（本仓 provide，可判有无提供方）；
 *    ② 宿主服务 `agents` / `subagents` / `openvikingMemory`（dsh 官方提供，
 *       本仓不可能有 provide）。判「无提供方」时按前缀过滤，见 panel-v2.html。
 *  - **间接取服务形态**：本仓有一层薄包装 `const dep = (n) => ctx.get(n)`
 *    （evolution-driver 6 处 / mutator softDepOrReturn）。包装函数名先识别，
 *    随后 `dep('agint.evolve')` 按 **code 边**计，否则整插件会被误判「从未接线」。
 *  - 注释态命中 → kind=comment（文档腐化候选，不建边）。
 *  - code 态 provide → 进 provided 表（不进 hits）。
 *  - code 态 get：provided 里存在该键的严格子键（K. 前缀）→ kind=umbrella
 *    （cordis 服务存储扁平，裸命名空间键恒 undefined，§1.4 不建边）；否则 kind=code。
 *
 * 目录口径（v0.3.0 修「无提供方」误报）：
 *  仓库位 quality 系列是**嵌套**的（plugins/agint-quality/agint-quality-eval/lib），
 *  部署位同时存在扁平壳目录（profiles/web/plugins/agint-quality-eval，只有
 *  manifest.json + test，**没有 lib/**）与嵌套真身。只扫顶层 <plugin>/lib 会
 *  同时漏掉真身、又扫到空壳 ⇒ agint.qualityEvaluator / agint.qualityPolicy 被
 *  误报「无提供方」。故扫描顶层 lib 与嵌套一层的「子目录/lib」两层（嵌套一层，
 *  够覆盖 quality 家族；跳过 node_modules / test / fixtures / schemas）。
 *  两层用**内层目录名**作为插件身份，于是仓库位与部署位身份一致。
 *
 * 已知限制（照实记录）：
 *  - 注释解析不处理模板串 ${} 嵌套与正则字面量；对 ctx.get 形态影响面≈0。
 *  - 间接形态只认「同文件内、包装函数体直接含 ctx.get(」这一种；跨文件再包装
 *    （如 X = (n) => dep(n)）不识别，会漏边（漏边只影响覆盖率数字，不装绿）。
 *  - checker 插件（quality-static）扫描**别的插件源码里的字面量 token**，
 *    自己的 ctx 命中为 0。这是职责不是缺陷；判定层靠「manifest 是否声明消费」
 *    把这类排除，见 panel-v2.html 的从未接线判据。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 直呼形态：ctx 对象的 get/provide 取服务（键为任意服务名字面量）；可选链写法同样命中。
 *  注释里刻意不写可被本正则命中的样例 —— 扫描器会扫到自己（见下方「自指」）。 */
const KEY_RE = /ctx\s*\??\.\s*(get|provide)\s*(?:\?\.)?\s*\(\s*(['"`])([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*)\2\s*[,)]/g;
/**
 * 间接取服务：薄包装的**定义**（不是任意含 ctx.get 的函数）。
 *
 * 判据是「形参直传」：包装函数的形参 P 出现在 `ctx.get(P` 里。
 *   ✓ const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null)
 *   ✓ function softDepOrReturn(name) { … ctx.get(name) … }
 *   ✗ async function publishEvent(topic, payload) { … ctx.get('agint.eventBus.publish') … }
 *     —— 字面量参数、ctx.get 只服务它自己 ⇒ 不是包装，不产生间接边。
 *
 * ⛔ 早期版本用「函数体任意位置出现 ctx.get(」当包装，害得 ov-strategy 的
 * publishEvent 被当成取服务函数，于是 `publishEvent('ov.recall.checked')`
 * 这类**事件名**被记成服务键（ov.recall.checked 等 5 条假边）。
 */
const DEP_DEF_ARROW = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^()]*)\)\s*=>[^;]*?ctx\s*(?:\?\.)?\.\s*get\s*\(\s*([A-Za-z_$][\w$]*)/g;
const DEP_DEF_FN = /function\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{[^}]*?ctx\s*(?:\?\.)?\.\s*get\s*\(\s*([A-Za-z_$][\w$]*)/g;

/**
 * 浏览器半文件（basename）：**排除**，其 `ctx` 不是 cordis 上下文。
 *
 * 判据与证据：family-panel/lib/client.js 是 React 半，`ctx` 来自组件 props
 * （`function FamilyPanel({ ctx })`），它 ctx.get('layout') 取的是宿主 GUI 壳层的
 * 布局服务 —— 那个键不在 node 面服务存储里，按 provide 表判「无提供方」必假。
 * 收窄成显式 basename 清单而不是「看起来像前端就跳过」：泛化启发式会把真实
 * node 半的边一起丢掉（那是更坏的错：漏边不报错，看着像干净）。
 * 新增浏览器半插件时往这里加一行，并写明它的 ctx 来源。
 */
const BROWSER_HALF_FILES = new Set(['client.js']);

/** 嵌套扫描要跳过的目录名（不是插件身份）。 */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', 'fixtures', 'schemas', 'bin', 'examples', 'assets', 'docs', 'lib']);

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
 * 列出一个插件目录下所有「代码根」：顶层 lib，加上嵌套一层的「子目录/lib」。
 * 嵌套项的插件身份取内层目录名（仓库位 plugins/agint-quality/agint-quality-eval
 * 与部署位 profiles/web/plugins/agint-quality/agint-quality-eval 同名同身份；
 * 部署位那个扁平的空壳 agint-quality-eval 没有 lib/，自然不产生身份）。
 * @param {string} plRoot - 插件顶层目录绝对路径
 * @returns {Array<{ id: string, root: string, top: boolean }>} 身份 + **插件目录** + 是否顶层
 *   （root 是插件目录本身，不是 lib/ —— 调用方还要读同级的 manifest.json / package.json）
 */
export function codeRoots(plRoot) {
  const out = [];
  if (existsSync(join(plRoot, 'lib'))) out.push({ id: basenameOf(plRoot), root: plRoot, top: true });
  let ents = [];
  try { ents = readdirSync(plRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.') || e.name.includes('.bak-')) continue;
    if (existsSync(join(plRoot, e.name, 'lib'))) out.push({ id: e.name, root: join(plRoot, e.name), top: false });
  }
  return out;
}

function basenameOf(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * 扫描 pluginsDir 下全部 agint-* 插件（含嵌套一层）的 lib 目录里的 .js 文件。
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
  /**
   * 单元身份注册：**顶层代码根先注册**（顶层目录是宿主 patch 的挂载单位），
   * 嵌套子目录只在身份未被占用时补位。
   *
   * 为什么必须这个顺序：部署位同时存在扁平的 agint-quality-eval（只有 manifest +
   * test，**没有 lib/**）与嵌套真身 agint-quality/agint-quality-eval（真挂载点）。
   * 扁平壳不产生代码根，不占身份，真身补位成功。若顺序反过来，嵌套会抢走
   * agint-quality-sandbox 等身份，把顶层真身挤掉。
   */
  const takenIds = new Set();
  const units = [];
  const pending = [];
  for (const pl of dirs) {
    const plRoot = join(pluginsDir, pl);
    for (const unit of codeRoots(plRoot)) {
      const rec = {
        id: unit.id,
        root: unit.root,
        lib: join(unit.root, 'lib'),
        // relBase = 插件目录相对**顶层目录**的路径；顶层单元为空串，
        // relFile 仍须以 `lib/` 开头（面板证据列按此解析）。
        relBase: relative(plRoot, unit.root).split(sep).join('/'),
      };
      if (unit.top) { takenIds.add(unit.id); units.push(rec); } else pending.push(rec);
    }
  }
  for (const rec of pending) {
    if (takenIds.has(rec.id)) continue;
    takenIds.add(rec.id);
    units.push(rec);
  }
  for (const unit of units) {
    for (const abs of listJs(unit.lib)) {
      const base = abs.split(/[\\/]/).pop();
      if (BROWSER_HALF_FILES.has(base)) continue;
      const relFile = unit.relBase === ''
        ? `lib/${relative(unit.lib, abs).split(sep).join('/')}`
        : `${unit.relBase}/lib/${relative(unit.lib, abs).split(sep).join('/')}`;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch (err) {
        errors.push({ file: `${unit.id}/${relFile}`, reason: String((err && err.message) ?? err).slice(0, 200) });
        continue;
      }
      scanOneFile(unit.id, relFile, text, gets, provided, errors);
    }
  }
  const hasSub = (key) => Object.keys(provided).some((k) => k.startsWith(`${key}.`));
  const hits = gets.map((g) => [g.pl, g.rel, g.line, g.key,
    g.inComment ? 'comment' : (hasSub(g.key) ? 'umbrella' : 'code')]);
  hits.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);
  return {
    hits,
    provided: { ...provided },
    familyDirs: dirs,
    units: units.map((u) => u.id).sort(),
    scannedAt: new Date().toISOString(),
    errors,
  };
}

/**
 * 单文件扫描：先识别薄包装函数名，再扫直呼与间接两种命中形态。
 * @param {string} id - 插件身份
 * @param {string} relFile - 相对代码根的展示路径（含 lib/ 前缀）
 * @param {string} text - 文件全文
 * @param {Array<object>} gets - 累积的 get 命中（出参）
 * @param {Record<string,string>} provided - 累积的 provide 表（出参）
 * @param {Array<object>} errors - 累积错误（出参）
 */
function scanOneFile(id, relFile, text, gets, provided, errors) {
  const wrappers = new Set();
  for (const re of [DEP_DEF_ARROW, DEP_DEF_FN]) {
    re.lastIndex = 0;
    let w;
    while ((w = re.exec(text)) !== null) {
      // 形参直传才认：ctx.get 的实参名必须出现在形参列表里。
      const params = w[2].split(',').map((s) => s.trim().replace(/^\.\.\./, '')).filter(Boolean);
      if (params.includes(w[3])) wrappers.add(w[1]);
    }
  }
  /** 由包装名构造「间接 get」正则；无包装则不构造（省一次匹配）。 */
  const depRes = [...wrappers].map((fn) => ({
    fn,
    re: new RegExp(`\\b${fn}\\s*\\(\\s*(['"\`])((?:agint\\.)?[A-Za-z_$][A-Za-z0-9_$.]*)\\1\\s*[,)]`, 'g'),
  }));
  const lines = text.split('\n');
  let st = { block: false, tick: false };
  for (let ln = 0; ln < lines.length; ln += 1) {
    const { mask, state } = commentMask(lines[ln], st);
    st = state;
    KEY_RE.lastIndex = 0;
    let m;
    while ((m = KEY_RE.exec(lines[ln])) !== null) {
      const inComment = mask[m.index] === true;
      if (m[1] === 'provide') {
        if (!inComment && !(m[3] in provided)) provided[m[3]] = id;
      } else {
        gets.push({ pl: id, rel: relFile, line: ln + 1, key: m[3], via: '', inComment });
      }
    }
    for (const d of depRes) {
      d.re.lastIndex = 0;
      let dm;
      while ((dm = d.re.exec(lines[ln])) !== null) {
        gets.push({ pl: id, rel: relFile, line: ln + 1, key: dm[2], via: d.fn, inComment: mask[dm.index] === true });
      }
    }
  }
  void errors;
}