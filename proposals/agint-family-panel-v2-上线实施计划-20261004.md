# agint-family-panel v2 上线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2026-10-04 批准的 v2 家族面板（Q1/Q2/Q3 整页）投入生产：host 半新增实时数据端点与整页 HTML 路由，前端从内嵌常量改为 fetch，数据全部实时来自源码扫描与 `$DSH_HOME/storages/` 三源。

**Architecture:** 在现有 `agint-family-panel` 双半插件内扩展（方案 A，老板已拍板）。host 半新增两条回环路由：`GET /api/agint-family/v2`（吐整页 HTML）与 `GET /api/agint-family/v2/data`（吐 JSON 聚合）。新文件 `lib/v2-scan.js`（源码扫描器，L0.5 真源）与 `lib/v2-data.js`（storages 三源聚合 + 缓存）。前端资产 `assets/panel-v2.html` 由效果稿 `D:\DSH\AGINT家族面板精修.html` 改造。v1 停靠面板只加一个「打开 v2 全页」按钮，`FAMILY_GROUPS` 不删（另行拍板）。

**Tech Stack:** Node.js ESM（host 半，无新依赖，只用 node:fs/node:path）、cordis webServer 路由（裸 req/res）、原生浏览器 JS（前端，无框架）。测试用 node:assert + node:test 风格裸脚本，与现有 `test/smoke.mjs` 一致。

**Spec:** 设计稿 `proposals/agint-family-panel-v2.md`（§1.2 源码真源、§1.4 伞键硬约束、§2 四层模型、D4 缓存纪律）+ 2026-10-04 会话批准的方案 A 设计（入口=独立整页+停靠面板链接；数据=实时端点按需计算+缓存；范围=端点+整页全量，暂不删 FAMILY_GROUPS）。效果稿 `D:\DSH\AGINT家族面板精修.html`（691 行）是前端的改造底稿。

## Global Constraints

- 面板**只读**。不加任何写路径（设计稿 §5 反模式）。
- 路由**回环 only**，沿用现有 `isLoopback` 守卫与 `enabled` kill-switch、`allowNonLoopback` 配置。
- **降级不装绿**：任一数据源缺失/读挂 → 该字段回 `{state:'error',reason}` 或 `{state:'unavailable',reason}`，前端琥珀显示。
- **归属不猜**：工具归属沿用命名前缀推断（U4 未证实），面板文案保留「U4 待证实」标注；无法归属 → unknown。
- **延迟指标不进面板**（U2 未查清，恒 0）。
- 伞键（有子键的命名空间键）不建边，只登记（§1.4）。
- 宿主内建 / `mcp__*` 工具单列，不计入任何 agint 插件。
- 机器私有绝对路径**不进入库文件**：host 半用 `process.env.DSH_HOME` / `AGINT_HOME` / `import.meta.url` 推导（Windows/Linux 双机）。路径拼接一律 `path.join`，扫描输出的相对路径统一 `/` 分隔符。
- 删除效果稿头部的 `g.alicdn.com` itrace 埋点脚本（外部遥测不进内网面板）。
- 本仓红线：不动 dsh 安装目录；`plugins/` 部署位（`$DSH_HOME/profiles/web/plugins/`）只读扫描，改动只落仓库 `project源码/DSH-AGINT`，部署=拷贝+重启（走 `wiki/挂载-重启红线.md` SOP，逐步授权）。
- L0 门禁：合并前跑 `node bin/check-l0-frozen.mjs` 与 `bin/plugin-check.sh`（本插件不涉 FROZEN 字段，预期通过）。
- 版本：`package.json` 与 `manifest.json` 同步 bump 到 **0.2.0**（顺带修复现存漂移：package 0.1.4 / manifest 0.1.2）。
- Commit 风格沿用仓库现有 `feat(family-panel): …` / `fix(…)` 中文主题。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `plugins/agint-family-panel/lib/v2-scan.js` | 新建 | 源码扫描器：遍历插件目录 `lib/**/*.js`，提取 `ctx.get/provide('agint.*')`，三分类 code/comment/umbrella，产出 HITS + PROVIDED + familyDirs |
| `plugins/agint-family-panel/lib/v2-data.js` | 新建 | storages 三源聚合（tool_stats/cron/bus）+ manifest consumes + repoDirs + 目录解析 `resolveV2Dirs` + TTL/mtime 缓存，组装 `/v2/data` payload |
| `plugins/agint-family-panel/assets/panel-v2.html` | 新建 | v2 整页前端（效果稿改造：删埋点、常量→fetch、渲染包进 render()、刷新真实生效） |
| `plugins/agint-family-panel/lib/index.js` | 修改 | 注册两条新路由（HTML + JSON），复用回环/kill-switch 守卫；`agint.familyPanel` 服务加 `v2Data()` 方法 |
| `plugins/agint-family-panel/lib/client.js` | 修改 | v1 停靠面板 Head 加「打开 v2 全页」按钮 |
| `plugins/agint-family-panel/manifest.json` | 修改 | version 0.2.0、`permissions.fs` 补读声明、description 更新 |
| `plugins/agint-family-panel/package.json` | 修改 | version 0.2.0 |
| `plugins/agint-family-panel/CHANGELOG.md` | 修改 | 0.2.0 条目 |
| `plugins/agint-family-panel/test/v2-scan.test.mjs` | 新建 | 扫描器单测（三分类、注释解析、错误降级） |
| `plugins/agint-family-panel/test/v2-data.test.mjs` | 新建 | 聚合单测（三源形状、窗口、降级、缓存） |
| `plugins/agint-family-panel/test/fixtures/v2-home/` | 新建 | 假 DSH_HOME 树（假插件 + 假 storages），单测与 smoke 共用 |
| `plugins/agint-family-panel/test/fixtures/v2-scan-baseline.json` | 新建 | 真实仓库扫描基线（Task 6 冻结，与 2026-10-03 效果稿基线对账后入库） |
| `plugins/agint-family-panel/test/smoke.mjs` | 修改 | 增 v2 路由断言（注册、回环、降级、HTML content-type） |

---

### Task 0: 提交遗留的 0.1.4 改动（前置清场）

仓库工作树现有 26 个脏文件，其中 4 个属于本插件（`agint-ops-preset` 补录，CHANGELOG 0.1.4 已写好、smoke 已改）。v2 工作必须叠在干净的本插件基线上。**其余 22 个非本插件脏文件一律不动**（可能是并行会话在途工作）。

**Files:**
- Commit（不改内容）: `plugins/agint-family-panel/{CHANGELOG.md,lib/index.js,package.json,test/smoke.mjs}`

**Interfaces:**
- Produces: 本插件工作树干净，`package.json` version=0.1.4 已入库。

- [ ] **Step 1: 向老板确认**：这 4 个文件是上一会话完成但未提交的 0.1.4（分组表补录 agint-ops-preset）。得到同意后单独提交。
- [ ] **Step 2: 跑 smoke 验证遗留改动完好**

Run: `cd "D:/DSH/project源码/DSH-AGINT/plugins/agint-family-panel" && node test/smoke.mjs`
Expected: 全部断言 PASS（CHANGELOG 0.1.4 声称 14 组 PASS）。若 FAIL，停下报告，不提交。

- [ ] **Step 3: 只暂存本插件 4 个文件并提交**

```bash
cd "D:/DSH/project源码/DSH-AGINT"
git add plugins/agint-family-panel/CHANGELOG.md plugins/agint-family-panel/lib/index.js plugins/agint-family-panel/package.json plugins/agint-family-panel/test/smoke.mjs
git commit -m "feat(family-panel): 分组表补录 agint-ops-preset（0.1.4）"
git status --short plugins/agint-family-panel/
```
Expected: status 无本插件残留。

---

### Task 1: 测试夹具树 `test/fixtures/v2-home/`

单测与 smoke 共用的假 DSH_HOME。先建夹具，后续任务全部对它断言。

**Files:**
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/profiles/web/plugins/agint-alpha/lib/index.js`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/profiles/web/plugins/agint-alpha/manifest.json`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/profiles/web/plugins/agint-beta/lib/index.js`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/profiles/web/plugins/agint-beta/lib/extra.js`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/profiles/web/plugins/agint-beta/manifest.json`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/profiles/web/plugins/not-family/index.js`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/storages/agint_tool_stats.jsonl`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/storages/agint_cron.json`
- Create: `plugins/agint-family-panel/test/fixtures/v2-home/storages/agint_event_bus.json`
- Create: `plugins/agint-family-panel/test/fixtures/v2-repo/plugins/agint-alpha/manifest.json`（假仓库位，repoDirs 用）

**Interfaces:**
- Produces: 夹具树。后面任务引用的确切事实：
  - alpha provide：`agint.alpha`（精确键，无子键）；alpha manifest 有 `spec.cordis.consumes: ["agint.beta.svc"]`
  - beta provide：`agint.beta.svc`、`agint.beta.other`（只有子键，无裸键）；beta manifest 用**顶层 cordis** 形态且无 consumes
  - get 命中：code 2 条、comment 2 条、umbrella 1 条（明细见下方文件内容）
  - tool_stats 8 行：`alpha_do`×2（1 失败）、`pwsh`×2、`mcp__x__y`×1、`beta_act`×3；ts 全部落在最近 7 天内（相对夹具生成时间，用固定近期时间戳会随时间滑出窗口 ⇒ **测试内动态生成 jsonl**，见 Step 1 说明）

- [ ] **Step 1: 写夹具文件**

`agint-alpha/lib/index.js`（命中明细：L3 code get、L5 comment get、L7 umbrella get（裸键 agint.beta 有子键）、L8 code provide）：

```js
export function apply(ctx) {
  // 消费 beta 的具体子键 → code
  const svc = ctx.get('agint.beta.svc');
  // 文档里提到 ctx.get('agint.alpha') 只是说明 → comment
  const self = ctx.get('agint.alpha');
  const ns = ctx.get('agint.beta'); // 裸命名空间键，beta 只提供子键 → umbrella
  ctx.provide('agint.alpha', { self, svc, ns });
}
```

`agint-alpha/manifest.json`（spec.cordis 形态 + consumes）：

```json
{ "name": "agint-alpha", "version": "0.0.1",
  "spec": { "cordis": { "provides": ["agint.alpha"], "consumes": ["agint.beta.svc"] } } }
```

`agint-beta/lib/index.js`：

```js
export function apply(ctx) {
  ctx.provide('agint.beta.svc', () => 1);
  // 注释里的 ctx.get('agint.alpha') → comment
}
```

`agint-beta/lib/extra.js`（多层 glob 覆盖 + code get）：

```js
export function more(ctx) {
  return ctx.get('agint.alpha');
}
```

`agint-beta/manifest.json`（顶层 cordis 形态、无 consumes）：

```json
{ "name": "agint-beta", "version": "0.0.1", "cordis": { "provides": ["agint.beta.svc", "agint.beta.other"] } }
```

`not-family/index.js`：`export default 1;`（非 agint- 前缀，必须被扫描忽略）

`agint-alpha/manifest.json`（v2-repo 假仓库位）：`{ "name": "agint-alpha" }`

storages 三文件由测试脚本**运行时动态生成**（时间戳相对当前时间，避免窗口滑出）——在 `test/fixtures/make-storages.mjs` 提供生成器：

```js
// test/fixtures/make-storages.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
export function makeStorages(home, now = Date.now()) {
  const dir = join(home, 'storages'); mkdirSync(dir, { recursive: true });
  const D = 86400000;
  const tl = (t, tool, ok) => JSON.stringify({ ts: t, tool, ok, latencyMs: 0, sessionId: 's', callId: 'c' });
  writeFileSync(join(dir, 'agint_tool_stats.jsonl'), [
    tl(now - 1 * 3600e3, 'alpha_do', true), tl(now - 1 * 3600e3, 'alpha_do', false),
    tl(now - 2 * D, 'beta_act', true), tl(now - 2 * D, 'beta_act', true), tl(now - 2 * D, 'beta_act', true),
    tl(now - 3 * D, 'pwsh', true), tl(now - 3 * D, 'pwsh', false),
    tl(now - 40 * D, 'old_tool', true), // 30 天窗口外，必须被排除
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'agint_cron.json'), JSON.stringify({ unit: 'u', global: {}, tables: { cron_state: {
    'alpha-daily': { lastRunAt: new Date(now - 5 * 3600e3).toISOString(), lastResult: 'ok', lastError: null, updatedAt: '' },
    'mystery-job': { lastRunAt: new Date(now - 9 * 3600e3).toISOString(), lastResult: '?', lastError: 'x', updatedAt: '' },
  } } }));
  const ev = (topic, source, ago) => ({ envelope: { id: topic + ago, topic, source, occurredAt: new Date(now - ago).toISOString(), payload: {} } });
  writeFileSync(join(dir, 'agint_event_bus.json'), JSON.stringify({ unit: 'u', global: {}, tables: {
    events: { e1: ev('alpha.did', 'agint-alpha', 1 * 3600e3), e2: ev('alpha.did', 'agint-alpha', 2 * D), e3: ev('beta.did', 'agint-beta', 3 * D) },
    deadletter: {},
  } }));
  return dir;
}
```

- [ ] **Step 2: 验证夹具生成器可运行**

```bash
cd "D:/DSH/project源码/DSH-AGINT/plugins/agint-family-panel"
node -e "import('./test/fixtures/make-storages.mjs').then(m=>m.makeStorages('./test/fixtures/v2-home'))" && ls test/fixtures/v2-home/storages
```
Expected: 列出三个文件。生成的 storages 文件**不入库**（加进仓库 `.gitignore`：`plugins/agint-family-panel/test/fixtures/v2-home/storages/`），测试各自现生成。

- [ ] **Step 3: Commit**

```bash
git add plugins/agint-family-panel/test/fixtures/ .gitignore
git commit -m "test(family-panel): v2 夹具树——假插件源、三形态 manifest、动态 storages 生成器"
```

---

### Task 2: 源码扫描器 `lib/v2-scan.js`（TDD）

**Files:**
- Create: `plugins/agint-family-panel/lib/v2-scan.js`
- Test: `plugins/agint-family-panel/test/v2-scan.test.mjs`

**Interfaces:**
- Consumes: Task 1 夹具树。
- Produces:
  ```js
  export function commentMask(line, state) // -> { mask: boolean[], state: { block: bool, tick: bool } }
  export function scanPlugins(pluginsDir)  // -> { hits: Array<[pl, relFile, line, key, kind]>,
                                           //      provided: Record<key, pl>, familyDirs: string[],
                                           //      scannedAt: string /*ISO*/, errors: Array<{file, reason}> }
  ```
  `kind ∈ 'code'|'comment'|'umbrella'`；`relFile` 相对插件根、`/` 分隔（Windows 兼容）。

**分类规则（生产版，写进模块头注释）：**
1. 命中形如 `ctx.get('agint.…')` / `ctx.provide('agint.…')`（单/双/反引号）。
2. 命中位置在注释里（`//` 之后或 `/* */` 内）→ 该命中 `inComment=true`。
3. code 态 `ctx.provide(K)` → `provided[K]=插件名`（同键先到先得）。provide 命中**不进 hits**。
4. get 命中分类：`inComment` → `comment`；否则若 `provided` 里存在 K 的严格子键（`K.` 前缀）→ `umbrella`（§1.4 伞键不建边）；否则 → `code`。
5. **与 2026-10-03 效果稿基线的两处已知差异**（对账时按此解释，不算回归）：① 效果稿把注释里提到伞键的命中标 `umbrella`，生产规则一律标 `comment`（注释命中不再细分）；② 效果稿把提供方自己的伞键 `ctx.provide` 行也记进 hits（mutator:1189、self-model:417），生产规则 provide 不进 hits。

- [ ] **Step 1: 写失败单测**

```js
// test/v2-scan.test.mjs
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentMask, scanPlugins } from '../lib/v2-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOME = join(here, 'fixtures', 'v2-home');
const PLUGINS = join(HOME, 'profiles', 'web', 'plugins');

// commentMask：行注释、块注释跨行、字符串里的 // 不算注释
{
  const a = commentMask("const x = 1; // ctx.get('agint.a')", { block: false, tick: false });
  assert.equal(a.mask[20], true, '// 之后是注释');
  assert.equal(a.mask[10], false, '代码区不是注释');
  const b = commentMask("const s = 'http://x';", { block: false, tick: false });
  assert.equal(b.mask[14], false, '字符串里的 // 不触发注释');
  const c1 = commentMask('/* start', { block: false, tick: false });
  assert.equal(c1.state.block, true, '块注释状态跨行携带');
  const c2 = commentMask('still comment */ code(1)', c1.state);
  assert.equal(c2.mask[5], true); assert.equal(c2.mask[20], false);
}

// scanPlugins：夹具全量断言
{
  const r = scanPlugins(PLUGINS);
  assert.deepEqual(r.familyDirs, ['agint-alpha', 'agint-beta'], 'non-agint 目录不扫');
  assert.equal(r.provided['agint.alpha'], 'agint-alpha');
  assert.equal(r.provided['agint.beta.svc'], 'agint-beta');
  assert.ok(!('agint.beta' in r.provided), '裸键未被 provide');
  const at = (pl, key) => r.hits.filter(h => h[0] === pl && h[3] === key);
  // alpha：beta.svc=code；alpha(注释)=comment；beta(裸键,有子键)=umbrella；alpha(L6 code get)=code
  assert.equal(at('agint-alpha', 'agint.beta.svc').filter(h => h[4] === 'code').length, 1);
  assert.equal(at('agint-alpha', 'agint.beta').filter(h => h[4] === 'umbrella').length, 1);
  assert.equal(r.hits.filter(h => h[4] === 'comment').length, 2, 'alpha L5 + beta index L2');
  assert.equal(at('agint-beta', 'agint.alpha').filter(h => h[4] === 'code').length, 1, 'extra.js 多层 glob 命中');
  for (const h of r.hits) { assert.match(h[1], /^lib\//, 'relFile 用 / 分隔且相对插件根'); assert.ok(!h[1].includes('\\')); }
  assert.deepEqual(r.errors, []);
}

// 目录不存在 → 降级不抛
{
  const r = scanPlugins(join(HOME, 'nope'));
  assert.deepEqual(r.hits, []); assert.equal(r.errors.length, 1);
}

console.log('v2-scan.test.mjs PASS');
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `cd "D:/DSH/project源码/DSH-AGINT/plugins/agint-family-panel" && node test/v2-scan.test.mjs`
Expected: FAIL（`Cannot find module ../lib/v2-scan.js`）。

- [ ] **Step 3: 实现 `lib/v2-scan.js`**

```js
/**
 * v2-scan: L0.5 代码层真源扫描器（设计稿 §1.2/§1.4）。
 *
 * 规则（生产版）：
 *  - 命中形如 ctx.get('agint.…') / ctx.provide('agint.…')（三种引号）。
 *  - 注释态命中 → kind=comment（文档腐化候选，不建边）。
 *  - code 态 provide → 进 provided 表（不进 hits）。
 *  - code 态 get：provided 里存在该键的严格子键（K. 前缀）→ kind=umbrella
 *    （cordis 存储扁平，裸命名空间键恒 undefined，§1.4 不建边）；否则 kind=code。
 * 已知限制（照实记录，不修）：
 *  - 注释解析不处理模板串 ${} 嵌套与正则字面量；对 ctx.get 形态影响面≈0。
 *  - 与 2026-10-03 效果稿基线的两处分类差异见实施计划 Task 2。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const KEY_RE = /ctx\s*\.\s*(get|provide)\s*\(\s*(['"`])(agint\.[A-Za-z0-9_.]+)\2\s*[,)]/g;

export function commentMask(line, state) {
  const mask = new Array(line.length).fill(false);
  let block = state.block;
  let quote = state.tick ? '`' : null; // 只有反引号合法跨行；'/'" 每行重置
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]; const n = line[i + 1];
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
    if (c === '/' && n === '/') { for (let j = i; j < line.length; j += 1) mask[j] = true; break; }
    if (c === '/' && n === '*') { block = true; mask[i] = true; if (i + 1 < line.length) mask[i + 1] = true; i += 1; continue; }
    if (c === '`') { quote = '`'; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
  }
  const tick = quote === '`';
  if (!tick) quote = null; // 单双引号不跨行
  void quote;
  return { mask, state: { block, tick } };
}

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

export function scanPlugins(pluginsDir) {
  const errors = [];
  const provided = Object.create(null);
  const gets = [];
  let dirs = [];
  try {
    dirs = readdirSync(pluginsDir)
      .filter((d) => d.startsWith('agint-') && statSync(join(pluginsDir, d)).isDirectory())
      .sort();
  } catch (err) {
    return { hits: [], provided: {}, familyDirs: [], scannedAt: new Date().toISOString(),
      errors: [{ file: pluginsDir, reason: String((err && err.message) ?? err).slice(0, 200) }] };
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
          if (rec.call === 'provide' && !rec.inComment) { if (!(rec.key in provided)) provided[rec.key] = pl; }
          else if (rec.call === 'get') gets.push(rec);
        }
      }
    }
  }
  const hasSub = (key) => Object.keys(provided).some((k) => k.startsWith(key + '.'));
  const hits = gets.map((g) => [g.pl, g.rel, g.line, g.key,
    g.inComment ? 'comment' : (hasSub(g.key) ? 'umbrella' : 'code')]);
  hits.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);
  return { hits, provided: { ...provided }, familyDirs: dirs, scannedAt: new Date().toISOString(), errors };
}
```

注意 `void quote;` 一行是防 lint 死代码告警的占位——实现时如果 quote 变量按上面写法在函数尾未再使用，直接删掉 `const tick` 之前的两行改为 `const tick = quote === '\u0060';`，保持返回 `state:{block,tick}` 即可（以测试通过为准）。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `node test/v2-scan.test.mjs`
Expected: `v2-scan.test.mjs PASS`。

- [ ] **Step 5: 对真实仓库跑一遍肉眼抽查（不入测试）**

```bash
node -e "import('./lib/v2-scan.js').then(({scanPlugins})=>{const r=scanPlugins(process.env.DSH_HOME+'/profiles/web/plugins');const c={};for(const h of r.hits)c[h[4]]=(c[h[4]]||0)+1;console.log(c, 'provided keys:', Object.keys(r.provided).length, 'errors:', r.errors.length)})"
```
Expected: 三分类计数接近效果稿基线（93 code / 24 comment / 10 umbrella，允许 Task 2 声明的两处差异导致 comment/umbrella 之间少量移动）。记录实际数字，Task 6 冻结基线时用。**若 code 计数偏离 >10%，停下排查分类规则，不进下一任务。**

- [ ] **Step 6: Commit**

```bash
git add plugins/agint-family-panel/lib/v2-scan.js plugins/agint-family-panel/test/v2-scan.test.mjs
git commit -m "feat(family-panel): v2 源码扫描器——code/comment/umbrella 三分类，L0.5 真源"
```

---

### Task 3: 聚合层 `lib/v2-data.js`（TDD）

**Files:**
- Create: `plugins/agint-family-panel/lib/v2-data.js`
- Test: `plugins/agint-family-panel/test/v2-data.test.mjs`

**Interfaces:**
- Consumes: `scanPlugins`（Task 2）、`makeStorages`（Task 1）。
- Produces:
  ```js
  export function resolveV2Dirs(env, selfUrl) // -> { pluginsDir, storagesDir, repoPluginsDir|null }
  export function collectV2Data(dirs, opts)  // -> payload（下方形状）；opts={ now, force, cache }（测试注入用，生产缺省）
  export function clearV2Cache()
  ```
  payload 形状（`/v2/data` 的响应体，字段名与效果稿常量一一对应，前端好映射）：
  ```js
  { ok: true, generatedAt, panelVersion,
    scan:   { hits, provided, familyDirs, scannedAt, errors }        | { state:'error', reason },
    tools:  { rows:[{t,n,f,last}], daily:{tool:[7个数]}, total, windowDays:30, observedAt } | { state:'error', reason },
    cron:   { jobs:[{j,last,res,err}], count, observedAt }           | { state:'error', reason },
    bus:    { total, deadletter, topics:[[t,n]…], sources:[[s,n]…], daily:{src:[7]}, range:[firstISO,lastISO], observedAt } | { state:'error', reason },
    manifestConsumes: { pl: [keys…] },   // 只收非空 consumes
    repoDirs: [dirs] | { state:'unavailable', reason } }
  ```
  每源独立 try/catch：一源挂 → 该字段 `{state:'error',reason}`，其余照常（降级不装绿）。`observedAt` = 对应文件 mtime ISO。

- [ ] **Step 1: 写失败单测**

```js
// test/v2-data.test.mjs
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStorages } from './fixtures/make-storages.mjs';
import { resolveV2Dirs, collectV2Data, clearV2Cache } from '../lib/v2-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOME = join(here, 'fixtures', 'v2-home');
makeStorages(HOME);
const DIRS = { pluginsDir: join(HOME, 'profiles', 'web', 'plugins'),
  storagesDir: join(HOME, 'storages'), repoPluginsDir: join(here, 'fixtures', 'v2-repo', 'plugins') };
const now = Date.now();

// resolveV2Dirs：DSH_HOME 优先；无 env 时从自身路径推导
{
  const a = resolveV2Dirs({ DSH_HOME: HOME }, 'file:///' + join(DIRS.pluginsDir, 'agint-alpha', 'lib', 'index.js').split('\\').join('/'));
  assert.equal(a.pluginsDir, DIRS.pluginsDir);
  assert.equal(a.storagesDir, join(HOME, 'storages'));
  assert.equal(a.repoPluginsDir, null, '无 AGINT_HOME → null，不猜');
  const b = resolveV2Dirs({ DSH_HOME: HOME, AGINT_HOME: join(here, 'fixtures', 'v2-repo') }, 'file:///x');
  assert.equal(b.repoPluginsDir, DIRS.repoPluginsDir);
}

const P = collectV2Data(DIRS, { now, cache: new Map() });

// tools：30 天窗口（old_tool 排除）、聚合、7 天 daily、host 工具不丢
assert.equal(P.tools.windowDays, 30);
assert.ok(!P.tools.rows.some(r => r.t === 'old_tool'), '30 天窗口外排除');
const alpha = P.tools.rows.find(r => r.t === 'alpha_do');
assert.deepEqual({ n: alpha.n, f: alpha.f }, { n: 2, f: 1 });
assert.equal(P.tools.daily.alpha_do.reduce((s, v) => s + v, 0), 2);
assert.equal(P.tools.daily.alpha_do.length, 7);
assert.ok(P.tools.rows.some(r => r.t === 'pwsh') && P.tools.rows.some(r => r.t === 'mcp__x__y') === false,
  'mcp 工具本夹具未生成；pwsh 单列在 rows（归属分离是前端职责）');

// cron
assert.equal(P.cron.count, 2);
assert.deepEqual(P.cron.jobs.find(j => j.j === 'mystery-job').res, '?');

// bus
assert.equal(P.bus.total, 3); assert.equal(P.bus.deadletter, 0);
assert.deepEqual(P.bus.topics[0], ['alpha.did', 2]);
assert.equal(P.bus.daily['agint-alpha'].reduce((s, v) => s + v, 0), 2);
assert.equal(P.bus.range.length, 2);

// manifestConsumes：三形态解析，只收非空
assert.deepEqual(P.manifestConsumes, { 'agint-alpha': ['agint.beta.svc'] });

// scan 与 repoDirs
assert.equal(P.scan.hits.length > 0, true);
assert.deepEqual(P.repoDirs, ['agint-alpha']);

// 降级：storages 目录不存在 → 三源各自 error，scan 照常，不抛
{
  const bad = collectV2Data({ ...DIRS, storagesDir: join(HOME, 'nope') }, { now, cache: new Map() });
  assert.equal(bad.ok, true);
  assert.equal(bad.tools.state, 'error'); assert.equal(bad.cron.state, 'error'); assert.equal(bad.bus.state, 'error');
  assert.ok(bad.scan.hits, 'scan 独立于 storages');
}

// 缓存：同 cache 二次调用命中（generatedAt 不变）；force 重算
{
  const c = new Map();
  const p1 = collectV2Data(DIRS, { now, cache: c });
  const p2 = collectV2Data(DIRS, { now: now + 1000, cache: c });
  assert.equal(p1.generatedAt, p2.generatedAt, 'TTL 内命中缓存');
  const p3 = collectV2Data(DIRS, { now: now + 1000, cache: c, force: true });
  assert.notEqual(p1.generatedAt, p3.generatedAt, 'force 重算');
}

clearV2Cache();
console.log('v2-data.test.mjs PASS');
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node test/v2-data.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `lib/v2-data.js`**

```js
/**
 * v2-data: /v2/data 的聚合层。L0.5（源码扫描）+ L1（storages 三源）+ manifest consumes。
 * 纪律：每源独立降级（error 带 reason，不装绿）；TTL 30s + mtime 缓存（设计稿 D4）；
 * observedAt = 文件 mtime，展示龄期；延迟字段（latencyMs）不聚合（U2）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scanPlugins } from './v2-scan.js';

const require = createRequire(import.meta.url);
const PANEL_VERSION = (require('../package.json')?.version) ?? '0.0.0';
const TTL_MS = 30_000;
const WINDOW_DAYS = 30;
const DAILY_DAYS = 7;
const DAY_MS = 86_400_000;

const moduleCache = new Map();
export function clearV2Cache() { moduleCache.clear(); }

export function resolveV2Dirs(env = process.env, selfUrl = import.meta.url) {
  const pluginRoot = resolve(dirname(fileURLToPath(selfUrl)), '..');
  const pluginsDir = env.DSH_HOME ? join(env.DSH_HOME, 'profiles', 'web', 'plugins') : resolve(pluginRoot, '..');
  const dshHome = env.DSH_HOME ?? resolve(pluginsDir, '..', '..', '..');
  return {
    pluginsDir,
    storagesDir: join(dshHome, 'storages'),
    repoPluginsDir: env.AGINT_HOME ? join(env.AGINT_HOME, 'plugins') : null,
  };
}

const err = (e) => ({ state: 'error', reason: String((e && e.message) ?? e).slice(0, 200) });
const mtimeIso = (p) => { try { return statSync(p).mtime.toISOString(); } catch { return null; } };

function dayIndex(ts, now) { // 0=今天 … 6=六天前；越界/未来 → null
  const d = Math.floor((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  return d >= 0 && d < DAILY_DAYS ? DAILY_DAYS - 1 - d : null;
}
function startOfDay(ts) { const x = new Date(ts); x.setHours(0, 0, 0, 0); return x.getTime(); }

function aggTools(storagesDir, now) {
  const file = join(storagesDir, 'agint_tool_stats.jsonl');
  const text = readFileSync(file, 'utf8');
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const byTool = new Map(); const daily = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; } // 坏行跳过，不整源报废
    if (typeof r.ts !== 'number' || r.ts < cutoff || typeof r.tool !== 'string') continue;
    const a = byTool.get(r.tool) ?? { t: r.tool, n: 0, f: 0, last: 0 };
    a.n += 1; if (r.ok !== true) a.f += 1; if (r.ts > a.last) a.last = r.ts;
    byTool.set(r.tool, a);
    const i = dayIndex(r.ts, now);
    if (i !== null) { const arr = daily.get(r.tool) ?? new Array(DAILY_DAYS).fill(0); arr[i] += 1; daily.set(r.tool, arr); }
  }
  const rows = [...byTool.values()].sort((x, y) => y.n - x.n);
  return { rows, daily: Object.fromEntries(daily), total: rows.reduce((s, r) => s + r.n, 0),
    windowDays: WINDOW_DAYS, observedAt: mtimeIso(file) };
}

function aggCron(storagesDir) {
  const file = join(storagesDir, 'agint_cron.json');
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const cs = body?.tables?.cron_state;
  if (!cs || typeof cs !== 'object') return { state: 'error', reason: 'cron_state 表缺失或形态未知' };
  const jobs = Object.entries(cs).map(([j, v]) => ({ j,
    last: v?.lastRunAt ?? null, res: v?.lastResult ?? '?', err: v?.lastError ?? null }))
    .sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  return { jobs, count: jobs.length, observedAt: mtimeIso(file) };
}

function aggBus(storagesDir, now) {
  const file = join(storagesDir, 'agint_event_bus.json');
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const ev = body?.tables?.events;
  if (!ev || typeof ev !== 'object') return { state: 'error', reason: 'events 表缺失或形态未知' };
  const topics = new Map(); const sources = new Map(); const daily = new Map();
  let total = 0; let first = null; let last = null;
  for (const v of Object.values(ev)) {
    const e = v?.envelope; if (!e) continue;
    total += 1;
    if (e.topic) topics.set(e.topic, (topics.get(e.topic) ?? 0) + 1);
    if (e.source) sources.set(e.source, (sources.get(e.source) ?? 0) + 1);
    const ts = Date.parse(e.occurredAt ?? '');
    if (Number.isFinite(ts)) {
      if (!first || e.occurredAt < first) first = e.occurredAt;
      if (!last || e.occurredAt > last) last = e.occurredAt;
      const i = dayIndex(ts, now);
      if (i !== null && e.source) { const arr = daily.get(e.source) ?? new Array(DAILY_DAYS).fill(0); arr[i] += 1; daily.set(e.source, arr); }
    }
  }
  const dl = body?.tables?.deadletter;
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { total, deadletter: dl && typeof dl === 'object' ? Object.keys(dl).length : 0,
    topics: sortDesc(topics), sources: sortDesc(sources), daily: Object.fromEntries(daily),
    range: [first, last], observedAt: mtimeIso(file) };
}

function readManifestConsumes(pluginsDir) {
  const out = {};
  let dirs = [];
  try { dirs = readdirSync(pluginsDir); } catch { return out; }
  for (const d of dirs) {
    if (!d.startsWith('agint-')) continue;
    const p = join(pluginsDir, d, 'manifest.json');
    if (!existsSync(p)) continue; // 无 manifest（agint-quality 等）→ 跳过，不猜
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      const consumes = m?.spec?.cordis?.consumes ?? m?.cordis?.consumes ?? null; // 三形态
      if (Array.isArray(consumes) && consumes.length > 0) out[d] = consumes;
    } catch { /* 坏 manifest 单插件跳过 */ }
  }
  return out;
}

function signature(dirs) { // mtime 签名：三个 storages 文件 + 插件 lib 树
  const sig = [];
  for (const f of ['agint_tool_stats.jsonl', 'agint_cron.json', 'agint_event_bus.json'])
    sig.push(mtimeIso(join(dirs.storagesDir, f)));
  try {
    for (const d of readdirSync(dirs.pluginsDir)) {
      const lib = join(dirs.pluginsDir, d, 'lib');
      if (existsSync(lib)) sig.push(d, String(statSync(lib).mtimeMs));
    }
  } catch { /* 目录级失败由 collect 内的源级降级兜住 */ }
  return sig.join('|');
}

export function collectV2Data(dirs, opts = {}) {
  const now = opts.now ?? Date.now();
  const cache = opts.cache ?? moduleCache;
  const sig = signature(dirs);
  const hit = cache.get('v2');
  if (!opts.force && hit && now - hit.builtAt < TTL_MS && hit.sig === sig) return hit.value;
  const payload = { ok: true, generatedAt: new Date(now).toISOString(), panelVersion: PANEL_VERSION };
  try { Object.assign(payload, { scan: (() => { const r = scanPlugins(dirs.pluginsDir); return { hits: r.hits, provided: r.provided, familyDirs: r.familyDirs, scannedAt: r.scannedAt, errors: r.errors }; })() }); }
  catch (e) { payload.scan = err(e); }
  try { payload.tools = aggTools(dirs.storagesDir, now); } catch (e) { payload.tools = err(e); }
  try { payload.cron = aggCron(dirs.storagesDir); } catch (e) { payload.cron = err(e); }
  try { payload.bus = aggBus(dirs.storagesDir, now); } catch (e) { payload.bus = err(e); }
  try { payload.manifestConsumes = readManifestConsumes(dirs.pluginsDir); } catch (e) { payload.manifestConsumes = {}; }
  if (dirs.repoPluginsDir) {
    try { payload.repoDirs = readdirSync(dirs.repoPluginsDir).filter((d) => d.startsWith('agint-')).sort(); }
    catch (e) { payload.repoDirs = { state: 'unavailable', reason: String((e && e.message) ?? e).slice(0, 200) }; }
  } else payload.repoDirs = { state: 'unavailable', reason: 'AGINT_HOME 未设置' };
  cache.set('v2', { builtAt: now, sig, value: payload });
  return payload;
}
```

注意：`aggCron`/`aggBus` 文件整体读不到时 `readFileSync` 抛 → 外层 catch 成 `{state:'error'}`，单测「降级」用例覆盖。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `node test/v2-data.test.mjs`
Expected: `v2-data.test.mjs PASS`。

- [ ] **Step 5: Commit**

```bash
git add plugins/agint-family-panel/lib/v2-data.js plugins/agint-family-panel/test/v2-data.test.mjs
git commit -m "feat(family-panel): v2 聚合层——storages 三源 + manifest consumes + TTL/mtime 缓存，每源独立降级"
```

---

### Task 4: host 半路由（`lib/index.js`）+ smoke 断言

**Files:**
- Modify: `plugins/agint-family-panel/lib/index.js`
- Modify: `plugins/agint-family-panel/test/smoke.mjs`
- Create: `plugins/agint-family-panel/assets/panel-v2.html`（本任务先放最小占位页，Task 5 换成真前端——占位页保证路由可测）

**Interfaces:**
- Consumes: `collectV2Data`、`resolveV2Dirs`（Task 3）。
- Produces:
  - 路由 `GET /api/agint-family/v2` → `text/html; charset=utf-8`，读 `assets/panel-v2.html`（mtime 缓存）。
  - 路由 `GET /api/agint-family/v2/data` → `application/json`，`collectV2Data(resolveV2Dirs())`。
  - 两条路由都过 `enabled` kill-switch 与回环守卫（与 `/status` 同一套）。
  - `ctx.provide('agint.familyPanel', …)` 增方法 `v2Data: () => collectV2Data(resolveV2Dirs())`。

- [ ] **Step 1: 写占位页**

```html
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>AGINT 家族面板 v2</title></head>
<body><p>panel-v2 placeholder — Task 5 替换为真前端。</p></body></html>
```
存为 `plugins/agint-family-panel/assets/panel-v2.html`。

- [ ] **Step 2: 先在 smoke.mjs 加失败断言**（追加到现有用例之后；沿用其 `makeCtx`/`callRoute` 工具）

```js
// ── v2 路由 ────────────────────────────────────────────────
{
  process.env.DSH_HOME = join(here, 'fixtures', 'v2-home');
  delete process.env.AGINT_HOME;
  const { makeStorages } = await import('./fixtures/make-storages.mjs');
  makeStorages(process.env.DSH_HOME);
  const ctx = makeCtx();
  apply(ctx, {});
  // 三条路由都注册
  for (const p of ['/api/agint-family/status', '/api/agint-family/v2', '/api/agint-family/v2/data'])
    assert.ok(ctx._registered.some((r) => r.path === p), `route ${p} registered`);
  // data 路由：JSON、ok、含五块
  const d = await callRoute(ctx, { path: '/api/agint-family/v2/data' });
  assert.equal(d.status, 200);
  const body = JSON.parse(d.body);
  assert.equal(body.ok, true);
  assert.ok(body.scan.hits.length > 0 && body.tools.rows && body.cron.jobs && body.bus.topics);
  // HTML 路由：content-type
  const h = await callRoute(ctx, { path: '/api/agint-family/v2' });
  assert.equal(h.status, 200);
  assert.match(h.headers['content-type'], /text\/html/);
  // 非回环 → 403
  const f = await callRoute(ctx, { path: '/api/agint-family/v2/data', remoteAddress: '8.8.8.8' });
  assert.equal(f.status, 403);
  // kill-switch：enabled=false → data 路由回 enabled:false，不吐家族数据
  const ctx2 = makeCtx(); apply(ctx2, {});
  ctx2._provided['agint.familyPanel'].setEnabled(false);
  const off = await callRoute(ctx2, { path: '/api/agint-family/v2/data' });
  assert.equal(JSON.parse(off.body).enabled, false);
  delete process.env.DSH_HOME;
  console.log('smoke: v2 routes PASS');
}
```

注意：现有 `callRoute` 只捕获 `writeHead`/`end`；确认它对非 status 路径可用（签名带 `path` 参数，已支持）。`makeCtx` 的 Proxy 白名单不需要新增（v2 代码只从 `process.env` 与 fs 读，不从 ctx 读新属性）。若 smoke 顶层不是 async IIFE，把该块包进现有的 async 主流程。

- [ ] **Step 3: 跑 smoke 确认新断言 FAIL**

Run: `node test/smoke.mjs`
Expected: FAIL（route /api/agint-family/v2 registered 断言挂）。

- [ ] **Step 4: 实现 index.js 改动**

在 `lib/index.js` 顶部 import 区加：

```js
import { readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectV2Data, resolveV2Dirs } from './v2-data.js';
```

在 `STATUS_PATH` 定义后加：

```js
const V2_PAGE_PATH = `${API_PREFIX}/v2`;
const V2_DATA_PATH = `${API_PREFIX}/v2/data`;
const HERE = dirname(fileURLToPath(import.meta.url));
const V2_HTML_PATH = resolve(HERE, '..', 'assets', 'panel-v2.html');

/** HTML 资产按 mtime 缓存；文件丢失时回降级页而不是 500 裸文本。 */
let htmlCache = { mtimeMs: 0, text: null };
function readV2Html() {
  try {
    const st = statSync(V2_HTML_PATH);
    if (htmlCache.text === null || htmlCache.mtimeMs !== st.mtimeMs)
      htmlCache = { mtimeMs: st.mtimeMs, text: readFileSync(V2_HTML_PATH, 'utf8') };
    return htmlCache.text;
  } catch {
    return '<!DOCTYPE html><meta charset="utf-8"><p>panel-v2.html 资产缺失（部署不完整）。</p>';
  }
}
```

在 `apply()` 里现有 `ctx.webServer.register({…STATUS_PATH…})` 之后加两条注册（守卫顺序与 status 路由完全一致：enabled → 回环 → method）：

```js
  ctx.webServer.register({
    kind: 'exact',
    path: V2_PAGE_PATH,
    handler: (req, res) => {
      if (!enabled) { writeJson(res, 200, { ok: true, enabled: false, note: '面板已被 kill-switch 关闭' }); return; }
      if (!allowNonLoopback && !isLoopback(req)) { writeJson(res, 403, { ok: false, error: 'loopback-only' }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(readV2Html());
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: V2_DATA_PATH,
    handler: async (req, res) => {
      try {
        if (!enabled) { writeJson(res, 200, { ok: true, enabled: false, apiPrefix: API_PREFIX, note: '面板已被 kill-switch 关闭（host 半仍在，可即时 reopen）' }); return; }
        if (!allowNonLoopback && !isLoopback(req)) { writeJson(res, 403, { ok: false, error: 'loopback-only' }); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        const payload = collectV2Data(resolveV2Dirs());
        writeJson(res, 200, { ...payload, enabled: true });
      } catch (e) {
        writeJson(res, 500, { ok: false, error: String((e && e.message) ?? e).slice(0, 300) });
      }
    },
  });
```

`ctx.provide('agint.familyPanel', {…})` 对象里加一个方法：

```js
    /** v2 聚合快照；与 /v2/data 路由同源同缓存。 */
    v2Data: () => collectV2Data(resolveV2Dirs()),
```

- [ ] **Step 5: 跑全量测试确认 PASS**

Run: `node test/smoke.mjs && node test/v2-scan.test.mjs && node test/v2-data.test.mjs`
Expected: 三个全 PASS（smoke 原有用例不回归）。

- [ ] **Step 6: Commit**

```bash
git add plugins/agint-family-panel/lib/index.js plugins/agint-family-panel/test/smoke.mjs plugins/agint-family-panel/assets/
git commit -m "feat(family-panel): host 半新增 /v2 整页与 /v2/data 实时聚合路由（回环+kill-switch 同守卫）"
```

---

### Task 5: 前端改造 `assets/panel-v2.html`

**Files:**
- Create（覆盖占位页）: `plugins/agint-family-panel/assets/panel-v2.html`
- 底稿: `D:\DSH\AGINT家族面板精修.html`（691 行，工作区根目录，**不入库**）

**Interfaces:**
- Consumes: `/v2/data` payload（Task 3 形状）。
- Produces: 生产整页。全局约定：数据变量全部 `let`，由 `applyPayload(D)` 赋值；计算与 DOM 写入全部包进 `render()`；`load()` = fetch + applyPayload + render；刷新按钮 = `load()`。

- [ ] **Step 1: 复制底稿并做六处结构改造**

```bash
cp "/d/DSH/AGINT家族面板精修.html" "/d/DSH/project源码/DSH-AGINT/plugins/agint-family-panel/assets/panel-v2.html"
```

对 `assets/panel-v2.html` 依次改：

1. **删埋点**：删除 `<head>` 开头整个 `<script>!(function(j,a,g){j.__itrace_conf…})…</script>` 块（底稿第 4-6 行）。
2. **标题去效果稿化**：`<title>` 改为 `AGINT 家族面板 v2`；`<h1>` 里 `<span class="demo-badge">Q1+Q2+Q3 效果稿</span>` 改为 `<span class="demo-badge">v2 生产 · 只读</span>`。
3. **常量区改 let 空值**（底稿 326-341 行的 `const HITS = …` 到 `const MANIFEST_CONSUMES = …` 整块替换）：

```js
// 数据来自 GET ./v2/data（host 半实时聚合，回环）。任何源降级 → 顶部琥珀横幅，不装绿。
let HITS=[],PROVIDED={},TOOLS=[],CRON=[],BUS={total:0,deadletter:0,topics:[],sources:[],range:[null,null]},
    FAMILY_DIRS=[],TOOL_DAILY={},BUS_DAILY={},OBS={},MANIFEST_CONSUMES={},REPO_DIRS=null,SRC_ERRORS=[];
```

4. **计算+渲染包进 render()**：把原 `function providerOf(service){…}` 起、到 `foot.innerHTML=…` 止的全部逻辑包进 `function render(){ …原代码原样… }`。两个内部例外改动：
   - 原 `const byPlugin={}` 等顶层聚合变量保持在 `render()` 内部即可（每次重建，无跨渲染状态）；`SPARK_MAX` 的 `let` 声明留在 render 外（`spark()` 引用它）。
   - Q3「运行态不在仓库」判定块（原 `ANOM.push({v:"运行态不在仓库",o:"agint-quality-policy",…})` 硬编码）替换为数据驱动：

```js
if(Array.isArray(REPO_DIRS)){
  const known=new Set([...REPO_DIRS,...FAMILY_DIRS]);
  for(const [src,n] of BUS.sources)
    if(!known.has(src))
      ANOM.push({v:"运行态不在仓库",o:src,ev:`bus 发布 ${n} 条`,
        note:"运行时有此 source，仓库与部署位 plugins/ 均无此目录。家族名册派生时需覆盖部署态。"});
}else{
  ANOM.push({v:"无法判定",o:"运行态不在仓库",ev:REPO_DIRS?.reason??"AGINT_HOME 未设置",
    note:"仓库位目录清单不可得，该判据降级为 unknown。",amber:true});
}
```

   - 原「示意 · 待接 ledger」标记（Q1 详情行「最后改动」）**保留原样**——它仍是示意，不冒充。
   - `foot.innerHTML` 模板整体替换为：

```js
foot.innerHTML=`数据说明：
① 依赖边与 <code>文件:行号</code> 由 host 半实时扫描部署位 <code>profiles/web/plugins/agint-*/lib/**/*.js</code>（L0.5 真源，mtime+30s 缓存）。伞键不建边（设计稿 §1.4）。
② 工具调用（30 天窗口）、cron、bus 发布、7 天曲线实时聚合自 <code>$DSH_HOME/storages/</code> 三文件；延迟指标不进面板（U2 未查清）。
③ 工具→插件归属按命名前缀推断（U4 未证实）；宿主内建与 <code>mcp__*</code> 单列。
④ bus「投递」列一律 unknown：订阅表是模块级 Map，无查询接口，不拿猜测冒充测量。
⑤ 仍属示意的只有一处：Q1 详情「最后改动」（待接 evolution ledger，步 2 之后）。
⑥ Q3 导出是只读草稿，不自动喂 evolve.propose。`;
```

5. **导出文件名动态日期**：`el.download="agint-family-Q3-draft-20261003.md"` 改为 `el.download="agint-family-Q3-draft-"+new Date().toISOString().slice(0,10)+".md"`；导出头注释里「由面板 v2 效果稿导出」改「由面板 v2 导出」，「数据基线：2026-10-03」改为动态 `new Date(OBS.bus??Date.now()).toISOString().slice(0,10)`。
6. **bootstrap + 降级横幅**：在 `</script>` 前追加，并把原刷新按钮占位逻辑接上：

```js
// ── 数据装载 ──────────────────────────────────────────────
function applyPayload(D){
  SRC_ERRORS=[];
  const bad=(name,blk)=>{ if(blk&&blk.state){ SRC_ERRORS.push(name+"："+blk.reason); return true; } return false; };
  if(D.scan&&D.scan.hits){ HITS=D.scan.hits; PROVIDED=D.scan.provided; FAMILY_DIRS=D.scan.familyDirs; OBS.scan=D.scan.scannedAt; }
  else bad("源码扫描",D.scan);
  if(D.tools&&D.tools.rows){ TOOLS=D.tools.rows; TOOL_DAILY=D.tools.daily??{}; OBS.tools=D.tools.observedAt; }
  else bad("tool_stats",D.tools);
  if(D.cron&&D.cron.jobs){ CRON=D.cron.jobs; OBS.cron=D.cron.observedAt; }
  else bad("cron",D.cron);
  if(D.bus&&typeof D.bus.total==="number"){ BUS=D.bus; BUS_DAILY=D.bus.daily??{}; OBS.bus=D.bus.observedAt; }
  else bad("eventBus",D.bus);
  MANIFEST_CONSUMES=D.manifestConsumes??{};
  REPO_DIRS=Array.isArray(D.repoDirs)?D.repoDirs:{state:"unavailable",reason:D.repoDirs?.reason??"不可得"};
  if(D.enabled===false) SRC_ERRORS.push("kill-switch 已关闭面板数据");
}
function showSrcErrors(){
  let el=document.getElementById("srcErr");
  if(!SRC_ERRORS.length){ el?.remove(); return; }
  if(!el){ el=document.createElement("div"); el.id="srcErr";
    el.style.cssText="margin:8px 0;padding:8px 12px;border:1px solid rgba(201,162,74,.42);border-radius:8px;color:var(--warn);font-size:12px";
    document.querySelector(".overview").prepend(el); }
  el.textContent="⚠ 数据源降级 — "+SRC_ERRORS.join("；");
}
async function load(){
  refreshBtn.disabled=true; refreshBtn.textContent="刷新中…";
  try{
    const r=await fetch(new URL("v2/data",location.href),{cache:"no-store"});
    const D=await r.json();
    if(!D) throw new Error("空响应");
    if(D.ok===false&&D.enabled!==false) throw new Error(D.error??"数据端点报错");
    applyPayload(D); render(); showSrcErrors();
  }catch(e){
    SRC_ERRORS=["取数失败："+e.message]; render(); showSrcErrors();
  }finally{ refreshBtn.disabled=false; refreshBtn.textContent="刷新"; }
}
refreshBtn.onclick=load;
load();
```

  同时把原 `render()` 内对空数据的健壮性兜住：`STATS` 计算里 `toolTotal` 为 0 时 `hostTotal/toolTotal` 会 NaN——在 `render()` 开头加 `if(!HITS.length&&!TOOLS.length&&!BUS.total){stats.innerHTML="";tbodyQ1.innerHTML=tbodyQ2.innerHTML=tbodySvc.innerHTML=tbodyQ3.innerHTML=tbodyChain.innerHTML=tbodyHost.innerHTML="";umbList.innerHTML="";cronUnmapped.innerHTML="—";q3chips.innerHTML="";ages.innerHTML="";return;}`（空态由横幅说明，不渲染假表）。

- [ ] **Step 2: 静态自查（无浏览器）**

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const s = readFileSync('assets/panel-v2.html', 'utf8');
const must = ['function render()', 'async function load()', 'applyPayload', 'new URL(\"v2/data\"', 'refreshBtn.onclick=load'];
for (const m of must) if (!s.includes(m)) { console.error('MISSING:', m); process.exit(1); }
const banned = ['itrace', 'g.alicdn.com', 'const HITS', '效果稿</span>'];
for (const b of banned) if (s.includes(b)) { console.error('BANNED still present:', b); process.exit(1); }
console.log('panel-v2.html static check PASS');
"
```
Expected: PASS。

- [ ] **Step 3: 本地起假 host 联调（不进生产）**

```bash
node -e "
import('node:http').then(async ({default:http})=>{
  const { collectV2Data, resolveV2Dirs } = await import('./lib/v2-data.js');
  const { readFileSync } = await import('node:fs');
  process.env.DSH_HOME = process.env.DSH_HOME || require('node:os').homedir()+'/.dsh';
  http.createServer((req,res)=>{
    if(req.url.endsWith('/v2/data')){ res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(collectV2Data(resolveV2Dirs()))); }
    else { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); res.end(readFileSync('./assets/panel-v2.html','utf8')); }
  }).listen(41873, '127.0.0.1', ()=>console.log('fake host on http://127.0.0.1:41873/v2'));
});
" &
```
用 browser-use 打开 `http://127.0.0.1:41873/v2`，**用 `evaluate_script` 断言**（截图在本工作区恒失败，见项目记忆）：`document.querySelectorAll('#tbodyQ1 tr.row').length > 20`、`#tbodyQ2 tr.row` 非空、`#srcErr` 不存在（或列出降级项核对真实性）、五个 stat 数字非 NaN。验完杀掉假 host 进程。

- [ ] **Step 4: Commit**

```bash
git add plugins/agint-family-panel/assets/panel-v2.html
git commit -m "feat(family-panel): v2 整页前端——效果稿转生产，常量改实时 fetch，删外部埋点"
```

---

### Task 6: v1 停靠面板加「打开 v2 全页」链接

**Files:**
- Modify: `plugins/agint-family-panel/lib/client.js`（Head 按钮区，现第 264-265 行附近）
- Modify: `plugins/agint-family-panel/test/smoke.mjs`（client.js 静态检查段）

**Interfaces:**
- Consumes: status payload 里已有 `apiPrefix` 字段（host 半现成）。

- [ ] **Step 1: smoke 先加失败静态断言**（追加到现有「browser half 静态检查」用例）

```js
assert.match(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), /window\.open\([^)]*\/v2/, 'client.js 有 v2 全页入口');
```

- [ ] **Step 2: 跑 smoke 确认 FAIL**（新断言挂）。

- [ ] **Step 3: client.js 的 Head 按钮区（`h('button', … '刷新')` 之前）插入**

```js
          h('button', {
            type: 'button', className: 'agintfp-btn',
            title: '在新标签页打开 v2 全页（Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定）',
            onClick: () => {
              const prefix = (data && data.apiPrefix) || '/api/agint-family';
              window.open(prefix + '/v2', '_blank', 'noopener');
            },
          }, '打开 v2 全页'),
```

- [ ] **Step 4: 跑 smoke 确认 PASS**（全量：`node test/smoke.mjs`）。
- [ ] **Step 5: Commit**

```bash
git add plugins/agint-family-panel/lib/client.js plugins/agint-family-panel/test/smoke.mjs
git commit -m "feat(family-panel): v1 停靠面板加「打开 v2 全页」入口"
```

---

### Task 7: 元数据收口（manifest / package / CHANGELOG）+ 基线冻结 + 门禁

**Files:**
- Modify: `plugins/agint-family-panel/manifest.json`、`package.json`、`CHANGELOG.md`、`README.md`（路由文档补两条）
- Create: `plugins/agint-family-panel/test/fixtures/v2-scan-baseline.json`
- Modify: `plugins/agint-family-panel/test/v2-scan.test.mjs`（基线回归断言）

- [ ] **Step 1: 冻结扫描基线**（对**仓库位** plugins/ 跑，两机可复现；不是部署位）

```bash
cd "D:/DSH/project源码/DSH-AGINT/plugins/agint-family-panel"
node -e "
import('./lib/v2-scan.js').then(async ({scanPlugins})=>{
  const r = scanPlugins('../'); // 仓库 plugins/ 目录
  const c = {code:0,comment:0,umbrella:0}; for (const h of r.hits) c[h[4]]++;
  const base = { generatedFrom: 'repo plugins/ (DSH-AGINT)', generatedAt: r.scannedAt, counts: c,
    providedKeys: Object.keys(r.provided).length, familyDirs: r.familyDirs.length,
    note: '与 2026-10-03 效果稿基线（93 code/24 comment/10 umbrella）的差异按实施计划 Task 2 两处规则差解释；冻结前人工对账一次' };
  require('node:fs').writeFileSync('test/fixtures/v2-scan-baseline.json', JSON.stringify(base,null,2));
  console.log(base);
});
"
```
人工对账：把输出的 counts 与 93/24/10 对比，差异必须全部落在 Task 2 声明的两处规则差内（comment↔umbrella 移动、provide 行不再进 hits）。**对不上就停下排查，不冻结。** 注意基线文件含 `generatedAt`/`scannedAt` 时间戳——断言只比对 `counts`/`providedKeys`/`familyDirs` 三个稳定字段，时间戳字段断言存在即可。基线随代码演进会漂移：断言写成「±2 容差 + 漂移超限时报错提示重新对账冻结」，不写死相等。

- [ ] **Step 2: v2-scan.test.mjs 追加基线回归断言**

```js
// 基线回归（仓库位扫描，容差 ±2；漂移超限 → 人工对账后重新冻结基线）
{
  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(join(here, 'fixtures', 'v2-scan-baseline.json'), 'utf8'));
  const r = scanPlugins(join(here, '..', '..')); // 仓库 plugins/
  const c = { code: 0, comment: 0, umbrella: 0 };
  for (const h of r.hits) c[h[4]] += 1;
  for (const k of ['code', 'comment', 'umbrella'])
    assert.ok(Math.abs(c[k] - base.counts[k]) <= 2, `${k} 计数漂移超容差：${c[k]} vs 基线 ${base.counts[k]}，重新对账冻结`);
}
```
（若测试文件当前非 async 上下文，用 `readFileSync` 静态 import 替代 await import。）

- [ ] **Step 3: manifest.json 三处改**

1. `"version": "0.1.2"` → `"0.2.0"`；`package.json` `"version": "0.1.4"` → `"0.2.0"`（修复既有漂移，CHANGELOG 里注明）。
2. `spec.permissions.fs`：`[]` → `["read:storages", "read:profiles/web/plugins", "read:plugins"]`（格式依 `docs/plugins/PLUGIN-SPEC.md:78`，先例 `agint-evolution-memory/manifest.json:45-48`）。
3. `description` 更新为：`AGINT 家族面板：v1 停靠面板（分组/行状态/信号）+ v2 整页（Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定）。host 半开三条回环只读路由：/status、/v2、/v2/data；数据实时来自源码扫描与 storages 三源，TTL+mtime 缓存。`
4. `spec.cordis.provides` 不变（仍是 `agint.familyPanel`，只是多了一个方法）；`spec.compatSince` 维持 `0.1.0`。

- [ ] **Step 4: CHANGELOG.md 顶部加 0.2.0 条目**（格式仿 0.1.4：为什么/改了什么/测试）。要点：v2 整页上线（入口、两条路由）；数据对接（扫描器三分类规则 + 三源聚合 + 缓存 + 每源降级）；删外部埋点；版本漂移修复（manifest 0.1.2 与 package 0.1.4 统一到 0.2.0）；FAMILY_GROUPS 保留未删（另行拍板，引设计稿 §10）。

- [ ] **Step 5: README.md 路由段补 `/v2` 与 `/v2/data` 两行说明**（回环、只读、缓存 30s）。

- [ ] **Step 6: 全量测试 + 门禁**

```bash
cd "D:/DSH/project源码/DSH-AGINT"
node plugins/agint-family-panel/test/smoke.mjs && node plugins/agint-family-panel/test/v2-scan.test.mjs && node plugins/agint-family-panel/test/v2-data.test.mjs
node bin/check-l0-frozen.mjs && bash bin/plugin-check.sh
```
Expected: 全 PASS / exit 0。

- [ ] **Step 7: Commit**

```bash
git add plugins/agint-family-panel/
git commit -m "feat(family-panel)!: v2 面板上线（0.2.0）——整页+实时数据端点；扫描基线冻结；manifest fs 读权限"
```

---

### Task 8: 部署 + 实机验收（每步单独授权）

**前置**：Task 0-7 全部入库。部署走 `wiki/挂载-重启红线.md` SOP。以下每个动作先向老板报备再做。

- [ ] **Step 1: 备份部署位现文件**（工作区约定：改配置/组合前先备份）

```bash
cp -r "$USERPROFILE/.dsh/profiles/web/plugins/agint-family-panel" "$USERPROFILE/.dsh/profiles/web/plugins/agint-family-panel.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || echo "部署位无旧版，跳过备份"
```

- [ ] **Step 2: 拷贝仓库版到部署位**（只拷本插件目录；`.bak-*` 目录以 `agint-family-panel` 前缀开头但不含 `lib/`，扫描器按 `agint-` 前缀会把它收进 familyDirs——**备份必须放到 plugins/ 目录之外**，改放 `$USERPROFILE/.dsh/agint-family-panel.bak-<ts>/`。Step 1 的备份路径按此执行）

```bash
rm -rf "$USERPROFILE/.dsh/profiles/web/plugins/agint-family-panel"
cp -r "/d/DSH/project源码/DSH-AGINT/plugins/agint-family-panel" "$USERPROFILE/.dsh/profiles/web/plugins/agint-family-panel"
```
（`test/`、`fixtures/` 一起拷无碍——运行时不加载；如 install.sh 有排除清单则按 install.sh 跑，二选一，以 SOP 为准。）

- [ ] **Step 3: 重启**：仅走 dsh 内 `restart_request`（项目记忆红线），等 `restart_status` 报 ready。
- [ ] **Step 4: 路由实测**（端口从 dsh web 启动日志或 `AGENTS.local.md` 取）

```bash
curl -s "http://127.0.0.1:<port>/api/agint-family/v2/data" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok:',j.ok,'ver:',j.panelVersion,'hits:',j.scan?.hits?.length,'tools:',j.tools?.rows?.length,'cron:',j.cron?.count,'bus:',j.bus?.total)})"
curl -s -o /dev/null -w "%{content_type} %{http_code}\n" "http://127.0.0.1:<port>/api/agint-family/v2"
```
Expected: `ok: true ver: 0.2.0 hits:≈139 tools:≈140 cron:≈24 bus:≈17500+`；HTML 路由 `text/html… 200`。

- [ ] **Step 5: 浏览器验收**：`cmd /c start http://127.0.0.1:<port>/api/agint-family/v2` 给老板看真页面；自动化核验用 browser-use `evaluate_script` 断言（截图恒失败）：Q1/Q2 表非空、无 `NaN`、`#srcErr` 缺失或降级项与实况相符、刷新按钮点击后 `generatedAt` 变化。
- [ ] **Step 6: v1 停靠面板核验**：GUI 里打开家族面板，确认「打开 v2 全页」按钮存在且新标签页可达。

---

### Task 9: 收尾（沉淀 + push，按老板三步授权习惯）

- [ ] **Step 1: 经验教训沉淀**到 `docs/AGINT-经验教训技能沉淀-20260929.md`（Playbook）：本次新增条目候选——①扫描器分类规则与效果稿基线的两处差异及原因；②`.bak-*` 备份不能放 plugins/ 目录内（会被 agint- 前缀扫描误收）；③storages events 是对象不是数组（按 id 键控）。
- [ ] **Step 2: 更新项目记忆**（family-panel-v2-demo-status → 改为已上线状态；agint-l1-storage-sources 补 events 对象键控形态）。
- [ ] **Step 3: push**（仅 `project源码/DSH-AGINT`，可 push 仓；D:/DSH 根无 remote 是禁区）——老板点头后：

```bash
cd "D:/DSH/project源码/DSH-AGINT" && git log --oneline origin/main..HEAD && git push
```

---

## Self-Review 记录

1. **Spec 覆盖**：入口=独立整页+停靠链接（Task 4/6）✓；实时端点+缓存（Task 3/4，D4=TTL30s+mtime ✓）；范围=端点+整页全量、FAMILY_GROUPS 不删（Task 7 CHANGELOG 注明）✓；设计稿纪律——只读 ✓、回环 ✓、降级不装绿 ✓、伞键不建边 ✓、归属不猜（U4 标注保留在文案）✓、延迟不进面板（aggTools 不读 latencyMs）✓、删埋点（Task 5 banned 断言）✓、Q3 只读导出（保留效果稿行为，动态文件名）✓。
2. **占位符扫描**：`<port>` 两处——部署端口是机器私有事实（红线：不入库），执行时从启动日志/AGENTS.local.md 读，属合法运行参数非计划空洞。其余步骤均含实际代码/命令。
3. **类型一致性**：`scanPlugins` 返回字段（hits/provided/familyDirs/scannedAt/errors）在 Task 2 定义、Task 3 payload.scan 与 Task 5 applyPayload 消费一致；`collectV2Data(dirs,{now,force,cache})` 在 Task 3 定义、Task 4 路由以 `collectV2Data(resolveV2Dirs())` 调用（opts 缺省走 moduleCache）一致；payload 字段名 scan/tools/cron/bus/manifestConsumes/repoDirs 与前端 applyPayload 映射一致；`v2Data()` 服务方法与 manifest provides 不冲突（键不变）。
4. **已知风险**：smoke.mjs 现 being 顶层结构未逐行核对（Task 4 Step 2 注明了 async 包裹的适配动作）；基线容差 ±2 是经验值，首次对账若超差按 Task 7 Step 1 停下排查。
