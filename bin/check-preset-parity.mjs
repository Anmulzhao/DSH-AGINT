#!/usr/bin/env node
/**
 * check-preset-parity.mjs — 智进(agint) preset 与 shipped cordis preset 的能力行对齐门禁
 *
 * # 为什么需要它
 *
 * AGINT 的 agint preset 是**手抄** shipped `cordis` preset 的一份拷贝
 * （presets/agint/agent.cordis.yml 文件头自己写着 "Originally copied from ..."）。
 * 拷贝式平价有一个固有失效模式：**dsh 升级时 shipped preset 加了新行，agint 不会自动跟进**，
 * 而症状极其安静 —— 智进会话照常起，只是少了某个工具，没有任何一行报错。
 *
 * 这不是假想。2026-10-01 之前 agint 就比 cordis 少三行能力：
 *   - `command-goal`  —— `/goal` 人类命令行（create_goal 工具本身在，命令行不在）
 *   - `tool-cordis`   —— cordis_inspect_list / cordis_inspect_query 两个工具
 *   - `present`       —— 交付文件卡片
 * 而当时的排查还走错过一次弯路：文件里有一段注释断言 tool-cordis 不能挂，
 * 理由是「inspect provider 是进程级单例，第二个 preset 再挂会抛 already registered」，
 * **该理由与已发布代码矛盾**（host 层 cordis-inspect-providers 行全进程只注册一次，
 * preset 行只是读它，多 preset 挂载安全）。这段错误注释至今还留在仓库副本里。
 *
 * 一次人工核对只能证明「今天平了」。本脚本把它变成一条命令，让「明天 dsh 升级后平不平」
 * 变成机械可判定的事实。
 *
 * # 检查项
 *
 *   A. 能力行缺失   —— shipped cordis 有、agint 副本没有的行（critical）
 *   B. 包名分歧     —— 同 id 指向不同包（critical）：说明有人手改过 agint 与上游分家
 *   C. 启用倒挂     —— 上游启用、agint 却 `disabled`（critical）
 *   D. 副本漂移     —— 仓库副本 vs 部署副本行集合不同（critical）：
 *                      VERSION「挂载-重启红线」明写「双副本必须同时同步」，
 *                      分叉时重装会拿旧副本覆盖已修好的部署位
 *   E. agint 冗余   —— agint 多出的行（info）：智进 25 个 agint-* 工具模块等，属预期超集
 *
 * # 为什么 E 不算缺口
 *
 * 目标是「agint 不比我弱」，不是「agint 逐行等于 cordis」。多出来的能力是超集，
 * 只有**缺失 / 分歧 / 倒挂**才是真缺口。
 *
 * # disabled 怎么求值
 *
 * shipped 与部署两边的 `disabled` 都有 `!!js` 表达式。YAML 解析后它们是**字符串**
 * （`"process.platform === 'win32'"`），直接按真值判断会把 Linux 上明明启用的
 * tool-bash 误判成禁用。所以：
 *   - 认识的两个平台表达式按真值在本机求值；
 *   - 其余（如 `!ctx.get('profileContext')`，需要 Loader 上下文）标为 dynamic，
 *     退化成**表达式文本比对** —— 两边文本一致即视为一致，不一致报 info（不猜）。
 *
 * # 数据源
 *
 *   目标（上游基线）
 *     - shipped: <dsh>/node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml
 *       随 dsh 包发版，CI 里不需要起宿主 —— 这是它当主基线的原因。
 *     - live:    $DSH_HOME/profiles/<profile>/cordis.yml 里的 preset-cordis 行
 *       启动期组合产物，额外反映 profile 级 patch 覆盖。缺失时跳过并在报告里说明。
 *   被检（agint 副本）
 *     - repo:      presets/agint/agent.cordis.yml（本仓，随 git 走）
 *     - deployed:  $DSH_HOME/.agent-presets/agint/agent.cordis.yml（智进真正加载的那份）
 *
 * ⚠️ 已知边界：shipped 基线不含「profile 级 patch 对 preset-cordis 的覆盖」。
 *    本仓 profile patch 未触碰该 preset 行，故今日两者等价；若将来 profile 开始
 *    改写 preset 行，以 `--target live` 的结果为准。
 *
 * # 用法
 *
 *   node bin/check-preset-parity.mjs                 # 人类可读报告
 *   node bin/check-preset-parity.mjs --json          # 机器可读（给 CI / 技能编排用）
 *   node bin/check-preset-parity.mjs --strict        # info 级也算失败
 *   node bin/check-preset-parity.mjs --target=live   # 只用启动期组合当基线
 *   node bin/check-preset-parity.mjs --target=shipped
 *   node bin/check-preset-parity.mjs --target-file=shipped=<file>   # 自测用，指定基线
 *   node bin/check-preset-parity.mjs --agint=<label>=<file>         # 自测用，覆盖副本
 *
 * 环境变量：
 *   DSH_ROOT   覆盖 dsh 安装目录（默认按 check-dsh-compat.mjs 同一套候选路径找）
 *   DSH_HOME   覆盖 $DSH_HOME（默认 ~/.dsh）
 *
 * 退出码：0 = 通过；1 = 有缺口；2 = 环境不满足（找不到 dsh / yaml / 目标文件）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');
const TARGET_FILTER = readFlag('--target');
const TARGET_OVERRIDES = argv.filter((a) => a.startsWith('--target-file=')).map((a) => a.slice('--target-file='.length));
const AGINT_OVERRIDES = argv.filter((a) => a.startsWith('--agint=')).map((a) => a.slice('--agint='.length));

function readFlag(name) {
  const hit = argv.find((a) => a === name || a.startsWith(`${name}=`));
  return hit ? (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '') : null;
}

// `--target` 是**过滤器**不是路径。传个文件名进来若被静默忽略，脚本就会拿真实基线
// 去比对，结论看着有模有样、比的却不是你想比的东西 —— 传错标志必须当场喊停。
if (TARGET_FILTER !== null && TARGET_FILTER !== 'live' && TARGET_FILTER !== 'shipped') {
  console.error(`--target 只接受 live 或 shipped（收到 "${TARGET_FILTER}"）。要指定具体基线文件请用 --target-file=<label>=<path>。`);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 1. 环境
 * ------------------------------------------------------------------ */

/**
 * 跨平台候选：npm 全局安装位。按优先级排列。
 * 与 check-dsh-compat.mjs 同一套 —— 别去猜 nvm 目录名：`process.versions.node`
 * 是 `24.19.0`，而 nvm 目录叫 `v24.19.0`，少个 v 就静默找不到（已踩）。
 */
function dshRootCandidates() {
  const out = [];
  if (process.env.DSH_ROOT) out.push(process.env.DSH_ROOT);
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  if (appData) out.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  if (localAppData) out.push(path.join(localAppData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  out.push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
  out.push('/usr/lib/node_modules/@deepseek-ai/dsh');
  out.push(path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh'));
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) out.push(path.join(root, '@deepseek-ai', 'dsh'));
  } catch { /* 没有 npm 就跳过 */ }
  return out;
}

function findDshRoot() {
  for (const dir of dshRootCandidates()) {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh') return { dir, version: pkg.version };
    } catch { /* 试下一个 */ }
  }
  return null;
}

const dsh = findDshRoot();
if (!dsh) {
  console.error('找不到 @deepseek-ai/dsh 安装位置。设置 DSH_ROOT=<dsh 包目录> 再跑。');
  process.exit(2);
}

const require = createRequire(path.join(dsh.dir, 'noop.js'));
let YAML;
try {
  YAML = require('yaml');
} catch {
  console.error(`找不到 yaml（应在 ${path.join(dsh.dir, 'node_modules')} 下）。设置 DSH_ROOT 指向正确的 dsh 包目录。`);
  process.exit(2);
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/**
 * 解析 YAML。dsh 的组合文件里 `!!js` 是 Loader 表达式标签，标准 YAML 库不认，
 * 会打一堆 YAMLWarning；这里临时静音并把值当标量字符串取回（见文件头「disabled 怎么求值」）。
 */
function parseYaml(text) {
  const realWarn = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return YAML.parse(text);
  } finally {
    process.emitWarning = realWarn;
  }
}

/* ------------------------------------------------------------------ *
 * 2. 取行（递归展开 cordis:group 的子行）
 * ------------------------------------------------------------------ */

/**
 * 把一个 plugins 数组摊平成能力行列表。
 * `group: true` 的行（cordis:group）本身不是能力，它把子行放在 config 数组里 ——
 * plan-mode / compaction-basic / tool-workflow 都在这儿，**漏了它们就等于漏了三组能力**。
 */
function collectRows(plugins, out = [], depth = 0) {
  if (!Array.isArray(plugins)) return out;
  for (const entry of plugins) {
    if (!entry || typeof entry !== 'object' || entry.id === undefined) continue;
    out.push({
      id: String(entry.id),
      name: entry.name === undefined ? null : String(entry.name),
      disabled: entry.disabled,
      depth,
    });
    if (Array.isArray(entry.config)) collectRows(entry.config, out, depth + 1);
  }
  return out;
}

function readRows(file) {
  const rows = collectRows(parseYaml(fs.readFileSync(file, 'utf8')));
  if (rows.length === 0) throw new Error('解析结果里没有插件行');
  return rows;
}

/** 自测用：直接指定基线文件，绕过自动发现（`--target-file=label=path`）。 */
function readTargetOverrides() {
  return TARGET_OVERRIDES.map((spec) => {
    const at = spec.indexOf('=');
    const label = at === -1 ? 'custom' : spec.slice(0, at);
    const file = at === -1 ? spec : spec.slice(at + 1);
    if (!fs.existsSync(file)) throw new Error(`基线文件不存在：${file}`);
    return { label, file, rows: readShippedStyle(file) };
  });
}

/** shipped cordis preset 的形态：patch 文件里 `insert:` 段落下的 preset-cordis 行。 */
function readShippedStyle(file) {
  const doc = parseYaml(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(doc) ? doc : [doc];
  for (const entry of entries) {
    for (const row of entry?.insert ?? []) {
      if (row?.id === 'preset-cordis') return collectRows(row.config?.plugins);
    }
  }
  // 兜底：也接受裸 plugins 数组，让自测不必非包一层 insert
  return readRows(file);
}

function readShippedTarget() {
  const file = path.join(dsh.dir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'cordis.patch.yml');
  if (!fs.existsSync(file)) return null;
  const rows = readShippedStyle(file);
  return rows.length === 0 ? null : { label: 'shipped', file, rows };
}

/**
 * live 组合：正在跑的 profile 实际用的那棵树。
 *
 * ⚠️ 为什么不能只读 profiles/<p>/cordis.yml（2026-10-01 实测踩坑）：
 * 该文件**不保证是物化后的树**。dsh 0.2.0-rc.2 用 `agint-restart` 拉起（`dsh web`、
 * 不带 --profile）后，它被写成 4 行的空根：
 *     # dsh profile root — an empty entry list. The tree is composed as patches...
 *     []
 * 同一版本、早先那次带 --profile 的启动则写了 238 行。两种形态取决于启动方式。
 * 于是「文件里没有 preset-cordis → 返回 null → 调用方 if(live) 跳过」，门禁会
 * **静默丢掉整条 live 基线还照样报绿** —— 正是本门禁要防的那类假绿。
 *
 * 现在：先试 cordis.yml（快路径，兼容物化形态），拿不到再回退到
 * `dsh --profile <p> --dump-config`（权威、与启动方式无关）。两条都拿不到时
 * 返回 reason，由调用方**判红**，不再静默跳过。
 */
function readLiveTarget(profile = 'web') {
  const file = path.join(dshHome, 'profiles', profile, 'cordis.yml');
  if (fs.existsSync(file)) {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(doc) ? doc : [doc];
    for (const row of entries) {
      if (row?.id === 'preset-cordis') {
        const rows = collectRows(row.config?.plugins);
        if (rows.length > 0) return { label: 'live', file, rows };
      }
    }
  }

  // 回退：向 dsh 要权威组合。慢（要起一次进程）但与启动方式无关。
  let out;
  try {
    out = execFileSync('dsh', ['--profile', profile, '--dump-config'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return { error: `dsh --profile ${profile} --dump-config 执行失败：${e.message.split('\n')[0]}` };
  }
  const rows = pickPresetCordis(out);
  if (rows === null) {
    return { error: `dsh --profile ${profile} --dump-config 的输出里没有 preset-cordis 行` };
  }
  return { label: 'live', file: `dsh --profile ${profile} --dump-config`, rows };
}

/** 从一段 YAML 文本里取出 preset-cordis 的能力行；取不到返回 null。 */
function pickPresetCordis(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  for (const row of Array.isArray(doc) ? doc : [doc]) {
    if (row?.id === 'preset-cordis') {
      const rows = collectRows(row.config?.plugins);
      if (rows.length > 0) return rows;
    }
  }
  return null;
}

function readAgintCopies() {
  if (AGINT_OVERRIDES.length > 0) {
    return AGINT_OVERRIDES.map((spec) => {
      const at = spec.indexOf('=');
      const label = at === -1 ? spec : spec.slice(0, at);
      const file = at === -1 ? spec : spec.slice(at + 1);
      return { label, file: path.resolve(REPO_ROOT, file), rows: readRows(file) };
    });
  }
  const candidates = [
    { label: 'repo', file: path.join(REPO_ROOT, 'presets', 'agint', 'agent.cordis.yml') },
    { label: 'deployed', file: path.join(dshHome, '.agent-presets', 'agint', 'agent.cordis.yml') },
  ];
  const copies = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.file)) continue;
    copies.push({ ...c, rows: readRows(c.file) });
  }
  if (copies.length === 0) {
    console.error(`找不到 agint preset 副本（试过 ${candidates.map((c) => c.file).join('、')}）。`);
    process.exit(2);
  }
  return copies;
}

/* ------------------------------------------------------------------ *
 * 3. 判据
 * ------------------------------------------------------------------ */

/** 认识的两个平台表达式按真值在本机求值；其余标 dynamic，退化成文本比对。 */
function resolveDisabled(value) {
  if (value === undefined || value === null || value === false) return { state: 'enabled' };
  if (value === true) return { state: 'disabled' };
  if (typeof value === 'string') {
    const expr = value.trim();
    if (expr === "process.platform === 'win32'") return { state: process.platform === 'win32' ? 'disabled' : 'enabled' };
    if (expr === "process.platform !== 'win32'") return { state: process.platform !== 'win32' ? 'disabled' : 'enabled' };
    return { state: 'dynamic', expr };
  }
  return { state: 'dynamic', expr: JSON.stringify(value) };
}

function rowKey(row) {
  return `${row.id}::${row.name ?? ''}`;
}

function compare(target, copy) {
  const issues = [];
  const targetById = new Map(target.rows.map((r) => [r.id, r]));
  const copyById = new Map(copy.rows.map((r) => [r.id, r]));

  for (const [id, tRow] of targetById) {
    const cRow = copyById.get(id);
    if (!cRow) {
      issues.push({
        level: 'critical',
        kind: 'missing-row',
        row: id,
        target: tRow.name,
        message: `缺失能力行 ${id}（上游 cordis 有 ${tRow.name}，agint/${copy.label} 没有）`,
        remedy: `把该行补进 presets/agint/agent.cordis.yml 与部署位（两份都要），否则智进会话静默少这项能力`,
      });
      continue;
    }
    if (cRow.name !== tRow.name) {
      issues.push({
        level: 'critical',
        kind: 'package-divergence',
        row: id,
        target: tRow.name,
        actual: cRow.name,
        message: `能力行 ${id} 指向不同包：上游 ${tRow.name}，agint/${copy.label} ${cRow.name}`,
        remedy: '确认是刻意替换还是手改漏跟上游；刻意替换请在本脚本的忽略清单里显式登记，别默默分家',
      });
    }
    const tDis = resolveDisabled(tRow.disabled);
    const cDis = resolveDisabled(cRow.disabled);
    if (tDis.state === 'enabled' && cDis.state === 'disabled') {
      issues.push({
        level: 'critical',
        kind: 'disabled-regression',
        row: id,
        message: `能力行 ${id} 在上游启用、在 agint/${copy.label} 被 disabled —— 等于没有这项能力`,
        remedy: `去掉该行的 disabled${cRow.name ? `（包 ${cRow.name}）` : ''}`,
      });
    } else if (tDis.state === 'dynamic' || cDis.state === 'dynamic') {
      if ((tDis.expr ?? 'enabled') !== (cDis.expr ?? 'enabled')) {
        issues.push({
          level: 'info',
          kind: 'dynamic-disabled-mismatch',
          row: id,
          message: `能力行 ${id} 的 disabled 表达式两边不同（无法静态求值，按文本比对）：上游 ${tDis.expr ?? '（无）'}，agint/${copy.label} ${cDis.expr ?? '（无）'}`,
          remedy: '需在真实 Loader 上确认；本门禁不猜 ctx 上下文',
        });
      }
    } else if (tDis.state === 'disabled' && cDis.state === 'enabled') {
      issues.push({
        level: 'info',
        kind: 'superset-row',
        row: id,
        message: `能力行 ${id} 上游 disabled、agint/${copy.label} 启用（超集，允许）`,
        remedy: '',
      });
    }
  }

  for (const [id, cRow] of copyById) {
    if (targetById.has(id)) continue;
    issues.push({
      level: 'info',
      kind: 'agint-extra-row',
      row: id,
      message: `agint/${copy.label} 多出行 ${id}（${cRow.name}）`,
      remedy: '',
    });
  }

  return issues;
}

/** 双副本一致性：仓库与部署位分叉时，重装会把已修好的部署位覆盖回旧版。 */
function compareCopies(repoCopy, deployedCopy) {
  if (!repoCopy || !deployedCopy) return [];
  const a = new Map(repoCopy.rows.map((r) => [r.id, rowKey(r)]));
  const b = new Map(deployedCopy.rows.map((r) => [r.id, rowKey(r)]));
  const issues = [];
  const onlyRepo = [...a.keys()].filter((id) => !b.has(id));
  const onlyDeployed = [...b.keys()].filter((id) => !a.has(id));
  for (const id of onlyDeployed) {
    issues.push({
      level: 'critical',
      kind: 'copy-drift',
      row: id,
      message: `部署位有、仓库副本没有的能力行 ${id} —— 从仓库重装会把它抹掉`,
      remedy: `presets/agint/agent.cordis.yml 补上 ${id}（VERSION 红线：双副本必须同时同步）`,
    });
  }
  for (const id of onlyRepo) {
    issues.push({
      level: 'critical',
      kind: 'copy-drift',
      row: id,
      message: `仓库副本有、部署位没有的能力行 ${id} —— 部署位落后于仓库`,
      remedy: '重装或手工同步部署位，否则仓库改动从未真正生效过',
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * 4. 主流程
 * ------------------------------------------------------------------ */

const targets = [];
// 基线取不到时收集在这里，最后与比对结果合并（不能就地 push：issues 在下方才声明）
const baselineFailures = [];
if (TARGET_OVERRIDES.length > 0) {
  try {
    targets.push(...readTargetOverrides());
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
} else {
  if (TARGET_FILTER !== 'live') {
    const shipped = readShippedTarget();
    if (!shipped) {
      // 附上已探测的位置，别只丢一句「找不到」让人无从下手
      const tried = path.join(dsh.dir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'cordis.patch.yml');
      const hint = fs.existsSync(tried)
        ? `${tried} 存在但里面没有 preset-cordis 行（该文件可能被换版）`
        : `${tried} 不存在（dsh 安装于 ${dsh.dir}；可用 DSH_ROOT 覆盖）`;
      console.error(`读不到 shipped cordis preset 基线。已探测：${hint}`);
      process.exit(2);
    }
    targets.push(shipped);
  }
  if (TARGET_FILTER !== 'shipped') {
    const live = readLiveTarget(process.env.DSH_PROFILE || 'web');
    if (live?.error) {
      // 关键：拿不到基线必须判红。静默跳过 = 门禁少查一半还报绿（2026-10-01 实踩）。
      baselineFailures.push({
        level: 'critical',
        kind: 'baseline-unavailable',
        row: 'preset-cordis',
        copy: 'live',
        targets: [],
        message: `取不到 live 基线，本次没查它：${live.error}`,
        remedy: '确认 dsh 可执行且 `dsh --profile <p> --dump-config` 能出组合；或用 --target=shipped 只查 shipped 基线',
      });
    } else if (live) {
      targets.push(live);
    }
  }
}
if (targets.length === 0) {
  console.error('没有任何可用基线：live 组合文件不存在且未允许用 shipped。');
  process.exit(2);
}

let copies;
try {
  copies = readAgintCopies();
} catch (e) {
  console.error(`读取 agint 副本失败：${e.message}`);
  process.exit(2);
}

/**
 * 跨基线去重。
 *
 * shipped 与 live 是同一份上游能力的两个视角（前者随包发版，后者是启动期组合产物），
 * 它们一致时每条发现都会原样报两遍。两遍不增加信息量，只会把 3 条真缺口淹没在 6 条里。
 * 同一 (kind,row,copy) 的发现合并成一条，附上命中它的基线列表。
 */
function mergeIssues(issues) {
  const byKey = new Map();
  for (const issue of issues) {
    const key = `${issue.kind}|${issue.row ?? ''}|${issue.copy ?? ''}`;
    const hit = byKey.get(key);
    if (hit) {
      if (issue.target && !hit.targets.includes(issue.target)) hit.targets.push(issue.target);
      continue;
    }
    byKey.set(key, { ...issue, targets: issue.target ? [issue.target] : [] });
  }
  return [...byKey.values()];
}

const issues = mergeIssues([
  // 基线缺失也要进 issues（2026-10-01：静默跳过 = 少查一半还报绿）
  ...baselineFailures,
  ...targets.flatMap((target) =>
    copies.flatMap((copy) =>
      compare(target, copy).map((i) => ({ ...i, target: target.label, copy: copy.label })),
    ),
  ),
]);
for (const i of compareCopies(
  copies.find((c) => c.label === 'repo'),
  copies.find((c) => c.label === 'deployed'),
)) {
  issues.push({ ...i, targets: [] });
}

const critical = issues.filter((i) => i.level === 'critical');
const info = issues.filter((i) => i.level === 'info');

/** 两个基线是否描述同一份上游能力。 */
function targetsAgree() {
  if (targets.length < 2) return null;
  const key = (t) => t.rows.map((r) => `${r.id}::${r.name ?? ''}::${String(r.disabled ?? '')}`).sort().join('\n');
  const [a, b] = targets;
  return key(a) === key(b);
}

const report = {
  dshVersion: dsh.version,
  targets: targets.map((t) => ({ label: t.label, file: t.file, rows: t.rows.length })),
  targetsAgree: targetsAgree(),
  agintCopies: copies.map((c) => ({ label: c.label, file: c.file, rows: c.rows.length })),
  critical: critical.length,
  info: info.length,
  issues,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`dsh ${dsh.version}  @ ${dsh.dir}`);
  for (const t of targets) console.log(`基线 ${t.label.padEnd(8)}: ${t.rows.length} 行  ${t.file}`);
  for (const c of copies) console.log(`被检 ${c.label.padEnd(9)}: ${c.rows.length} 行  ${c.file}`);
  if (targetsAgree() === true) console.log('（两个基线描述同一份上游能力，发现已跨基线去重）');
  if (targetsAgree() === false) console.log('⚠️ shipped 与 live 基线不一致 —— profile 级 patch 改写了 preset 行，以 live 为准');
  console.log('');

  if (critical.length === 0 && info.length === 0) {
    console.log('✅ preset 平价检查通过：agint 副本不弱于 cordis baseline，双副本一致');
  }

  if (critical.length > 0) {
    console.log(`🔴 CRITICAL (${critical.length})`);
    for (const i of critical) {
      console.log(`  - [${i.kind}] ${i.message}`);
      if (i.targets.length > 1) console.log(`      基线: ${i.targets.join(' + ')}`);
      if (i.remedy) console.log(`      处置: ${i.remedy}`);
    }
    console.log('');
  }

  if (info.length > 0) {
    // agint-extra-row 是**预期**的（25 个 agint-* 工具模块 + ralph 超集），
    // 逐行铺开会把真缺口埋掉 —— 按 kind 归并，超集类只报计数。
    const byKind = new Map();
    for (const i of info) {
      if (!byKind.has(i.kind)) byKind.set(i.kind, []);
      byKind.get(i.kind).push(i);
    }
    console.log(`🔵 INFO (${info.length})`);
    for (const [kind, list] of byKind) {
      if (kind === 'agint-extra-row') {
        const perCopy = new Map();
        for (const i of list) perCopy.set(i.copy, (perCopy.get(i.copy) ?? 0) + 1);
        const detail = [...perCopy].map(([c, n]) => `${c} ${n} 行`).join('，');
        console.log(`  - [${kind}] agint 超集：${detail}（智进自带的 agint-* 工具模块，预期内，不需处置）`);
        console.log(`      逐行明细见 --json`);
        continue;
      }
      for (const i of list) {
        console.log(`  - [${kind}] ${i.message}`);
        if (i.remedy) console.log(`      处置: ${i.remedy}`);
      }
    }
    console.log('');
  }
}

const failed = critical.length > 0 || (STRICT && info.length > 0);
process.exit(failed ? 1 : 0);
