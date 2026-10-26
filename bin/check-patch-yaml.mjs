#!/usr/bin/env node
/**
 * check-patch-yaml.mjs —— bundle / profile patch 文件的 YAML 预检门禁
 *
 * 起源（2026-10-20 事故）：`@agint/host` 的 cordis.patch.yml 里有两行 `!!js`
 * 写成了 js-yaml 不认的形态，导致**整份 patch 解析失败**。dsh 的处理是
 * `skipping profile bundle "@agint/host"` 然后继续启动 —— 智进 preset 与全部
 * agint-* 服务一起消失，界面上只表现为「智进没了」，没有任何报错上浮。
 *
 * 所以「改完 patch 先解析一遍」必须机械可判、不能靠自觉。
 *
 * 与 dsh 完全同口径：app-boot 里是
 *     yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(JsExpr) })
 *     JsExpr = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar' })
 * 本脚本用同样的 js-yaml + 同样的 schema + 同样的 kind:'scalar' 复现解析。
 *
 * ⛔ `kind: 'scalar'` 是这条门禁的核心判据：`!!js` 标签只接受标量。
 *    - 多行块集合 `!!js ({` … 由缩进决定解析结果，可能被静默解析错位，也可能直接
 *      `bad indentation of a mapping entry`；
 *    - `!!js ` + 反引号模板 —— 模板字面量没有引号，js-yaml 当作**纯量里的反引号字符**，
 *      同时把 `!!js ` 这个**带空格的标签**当成未知标签 ⇒
 *      `cannot resolve a node with !<tag:yaml.org,2002:js>`。
 *    正确写法只有三种：裸标量、带引号的单行标量、块标量（`|` / `>` 开头）。
 *
 * 用法：
 *   node bin/check-patch-yaml.mjs              人读输出
 *   node bin/check-patch-yaml.mjs --json       CI 消费
 *   node bin/check-patch-yaml.mjs --file <p>   只查指定文件（默认自动发现）
 *
 * 自动发现范围：
 *   1. 仓库根 `cordis.patch.yml`
 *   2. `$DSH_HOME/.agint-bundle/cordis.patch.yml`（bundle 真身）
 *   3. `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`（cordis:include 指过去的 preset 组合）
 *   4. `$DSH_HOME/profiles/<p>/plugins/cordis.patch.yml`（镜像位）
 *   5. `$DSH_HOME/profiles/<p>/cordis.patch.yml`（profile 级 patch）
 * 备份文件（`*.bak-*`）默认不查 —— 它们本来就可能保留坏形态作取证。
 *
 * 退出码：0 = 全部可解析 / 1 = 有文件解析失败 / 2 = 环境不满足
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const FILE_ARG = (() => {
  const i = process.argv.indexOf('--file');
  return i >= 0 ? process.argv[i + 1] : null;
})();

/** 找一个 js-yaml。dsh 自己也是从自己的依赖树里加载它。 */
function loadYaml() {
  const candidates = [];
  if (process.env.AGINT_DSH_RUNTIME) candidates.push(process.env.AGINT_DSH_RUNTIME);
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  candidates.push(path.join(home, '.agint-deps', 'dsh-runtime', 'node_modules'));
  candidates.push(path.join(REPO_ROOT, 'node_modules'));
  for (const base of candidates) {
    try {
      const req = createRequire(path.join(base, 'noop.js'));
      return { yaml: req('js-yaml'), from: base };
    } catch { /* 试下一个 */ }
  }
  return null;
}

function discoverTargets() {
  const out = [];
  out.push({ label: 'repo', file: path.join(REPO_ROOT, 'cordis.patch.yml') });

  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  out.push({ label: 'bundle:.agint-bundle', file: path.join(home, '.agint-bundle', 'cordis.patch.yml') });

  // preset 组合文件（cordis:include 指过去的那份）与 patch 同样是 dsh 直接解析的 YAML，
  // 坏一次同样是「加载失败」或整段行消失 ⇒ 一并预检。
  const presetsDir = path.join(home, '.agent-presets');
  if (fs.existsSync(presetsDir)) {
    for (const d of fs.readdirSync(presetsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'node_modules') continue;
      out.push({
        label: `preset:${d.name}`,
        file: path.join(presetsDir, d.name, 'agent.cordis.yml'),
      });
    }
  }

  const profilesDir = path.join(home, 'profiles');
  if (fs.existsSync(profilesDir)) {
    for (const d of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      out.push({
        label: `mirror:profiles/${d.name}`,
        file: path.join(profilesDir, d.name, 'plugins', 'cordis.patch.yml'),
      });
      out.push({
        label: `profile:profiles/${d.name}`,
        file: path.join(profilesDir, d.name, 'cordis.patch.yml'),
      });
    }
  }
  return out.filter((t) => fs.existsSync(t.file));
}

/**
 * 解析前的形状检查：把 dsh 的报错翻成人能读的「这一行该怎么改」。
 * 只在解析失败时补充解释，不替代真解析。
 */
function shapeHints(txt) {
  const hints = [];
  txt.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('#') || !t.includes('!!js')) return;
    const after = t.slice(t.indexOf('!!js') + 4).trim();
    if (after.startsWith('`')) {
      hints.push({ line: i + 1, kind: 'backtick-template', text: t.slice(0, 120) });
    } else if (/^[{[]/.test(after) && !/^[{[].*[}\]]$/.test(after)) {
      hints.push({ line: i + 1, kind: 'multi-line-flow', text: t.slice(0, 120) });
    }
  });
  return hints;
}

const loaded = loadYaml();
if (!loaded) {
  console.error('找不到 js-yaml。设置 AGINT_DSH_RUNTIME=<含 js-yaml 的 node_modules> 再跑。');
  process.exit(2);
}
const { yaml, from } = loaded;

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
});
const schema = yaml.JSON_SCHEMA.extend(JsExpr);

const targets = FILE_ARG
  ? [{ label: 'file', file: path.resolve(FILE_ARG) }]
  : discoverTargets();

if (targets.length === 0) {
  console.error('没有找到任何要检查的 patch 文件。');
  process.exit(2);
}

const results = [];
for (const { label, file } of targets) {
  const txt = fs.readFileSync(file, 'utf8');
  const rec = { label, file, ok: false, rows: 0, error: null, hints: [] };
  try {
    const doc = yaml.load(txt, { schema });
    if (!Array.isArray(doc)) {
      rec.error = `顶层不是数组（dsh 要求 patch 文件是一个 YAML 数组），实际是 ${doc === null ? 'null' : typeof doc}`;
    } else {
      rec.ok = true;
      rec.rows = doc.length;
    }
  } catch (e) {
    rec.error = String(e.message).split('\n')[0];
    rec.hints = shapeHints(txt);
  }
  results.push(rec);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ jsYamlFrom: from, results }, null, 2));
} else {
  console.log(`js-yaml: ${from}`);
  for (const r of results) {
    const status = r.ok ? '✅' : '❌';
    console.log(`${status} [${r.label}] ${r.file}`);
    if (r.ok) console.log(`     可解析，顶层 ${r.rows} 条 patch`);
    else {
      console.log(`     解析失败：${r.error}`);
      for (const h of r.hints) {
        const advice = h.kind === 'backtick-template'
          ? '改成单行带引号标量：key: !!js "表达式"'
          : '改成单行带引号标量或块标量（!!js 只接受标量）';
        console.log(`     第 ${h.line} 行疑似 ${h.kind} —— ${advice}`);
        console.log(`       ${h.text}`);
      }
    }
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  if (!JSON_OUT) {
    console.log('');
    console.log('⚠️ 这份 patch 解析失败时，dsh 的真实行为是 skipping profile bundle + 照常启动：');
    console.log('   插件与 preset 一起消失，但界面上没有任何报错。改完必须重跑本门禁。');
  }
  process.exit(1);
}
if (!JSON_OUT) console.log(`\nPASS —— ${results.length}/${results.length} 个 patch 文件可解析`);
process.exit(0);
