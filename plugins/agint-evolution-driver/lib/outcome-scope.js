/**
 * agint-evolution-driver —— outcome-scope.js
 *
 * 1b R1′ 的判据层：一次变异**该用哪些测试来量**，以及**量不了**时怎么如实说。
 *
 * ## 为什么是这个形状（2026-10-03 实测换来的，见 `_1b_actualDelta尺子方案_20261003.md` §8）
 *
 * 拿一次真实历史变异（2026-09-29 自改给 `bin/plugin-check.sh` 加维度 11，与 HEAD 差 160 行）做对照：
 *   - `eval/scenarios` 场景集 123 条**逐条零差异** ⇒ 场景集看不见这处改动。
 *   - `bin/plugin-check-dim11.test.mjs` 从 3/3 变 2/3 ⇒ **测试语料看得见**。
 *   - 同一处改动放进全仓 1928 条的 passRate 只动 0.05pp，远小于死区 1.5pp ⇒ 全仓 passRate 会把它读成"无实质变化"。
 *
 * ⇒ 度量集必须是**按被改文件筛出的测试子集**，不是场景集，也不是全仓。
 *
 * ## 覆盖门（本模块存在的一半理由）
 *
 * 筛不出任何测试触达被改文件 ⇒ 调用方必须记 `NO_EVIDENCE`，⛔ 不许记 `actualDelta = 0`。
 * 设计 §4.2.5 明令"不得写入 0 或 null 冒充无改进"。没有这道门，尺子会把"测不到"
 * 系统性地写成"没效果"，校准分随之整体下偏 —— 那比没有尺子更糟。
 *
 * ## 纯函数纪律
 *
 * 全部只吃数组与字符串，不读盘、不读时钟、不读 env。文件清单由调用方（outcome-measurer）注入。
 * ⛔ 不要在这里 import node:fs —— 一旦这样，判据就只能活在有文件系统的那一层。
 */

/** preimage 命名（生产者：`index.js` 的 commitToRepo）
 *  `.agint-preimage/<repoRelPath 的 / 换成 __>__<ISO 时间，: 与 . 换成 ->.bak` */
const PREIMAGE_RE = /^\.agint-preimage\/(.+)__(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/;

/**
 * 从 preimagePath 反解出被改文件的仓库相对路径。
 *
 * ⚠️ 有损编码：原路径里本就含 `__` 的段解不回来（`plugins/a__b/x.js` 会被解成 `plugins/a/b/x.js`）。
 * 不猜、不修 —— 调用方拿解出的路径去 repoFiles 里核，核不上就是 NO_EVIDENCE。
 *
 * @param {string|null|undefined} preimagePath
 * @returns {{ok: true, repoRelPath: string, stamp: string} | {ok: false, reason: string}}
 */
export function parsePreimagePath(preimagePath) {
  if (typeof preimagePath !== 'string' || preimagePath === '') {
    return { ok: false, reason: 'NO_PREIMAGE_PATH' };
  }
  const m = PREIMAGE_RE.exec(preimagePath.replace(/\\/g, '/'));
  if (!m) return { ok: false, reason: 'PREIMAGE_NAME_UNPARSEABLE' };
  const flat = m[1];
  if (!flat) return { ok: false, reason: 'PREIMAGE_NAME_UNPARSEABLE' };
  return { ok: true, repoRelPath: flat.split('__').join('/'), stamp: m[2] };
}

/** 插件目录里"实现代码所在"的段名：见到它就把前一段当插件根。 */
const PLUGIN_SUBDIRS = new Set(['lib', 'test', 'bin', 'src', 'scripts', 'schema']);

/** 没有代码仪器的目标类型（改了也没有测试能测）。 */
const UNMEASURABLE_PREFIXES = ['presets/', 'docs/', 'wiki/', 'proposals/'];
const UNMEASURABLE_EXT = ['.md', '.json', '.yml', '.yaml', '.txt'];

/**
 * 从仓库文件清单里筛出"可跑的测试文件"全集。
 *
 * 认两种：`*.test.mjs`（node:test 单元）与插件自己 `test/smoke.mjs`（driver 的集成件即此形状）。
 * ⛔ 不认 `eval/scenarios`：§8 实测它对真实变异不可见。
 *
 * @param {string[]} repoFiles 仓库相对路径清单（调用方扫盘注入）
 * @returns {string[]} 排序去重
 */
export function deriveTestFiles(repoFiles) {
  const list = Array.isArray(repoFiles) ? repoFiles : [];
  const out = new Set();
  for (const f of list) {
    if (typeof f !== 'string' || f === '') continue;
    const p = f.replace(/\\/g, '/').replace(/^\.\//, '');
    if (p.endsWith('.test.mjs')) out.add(p);
    else if (/^plugins\/.+\/test\/smoke\.mjs$/.test(p)) out.add(p);
  }
  return [...out].sort();
}

/** 定位被改文件属于哪个插件根；不在 plugins/ 下返回 null。 */
function pluginRootOf(segments) {
  if (segments[0] !== 'plugins') return null;
  for (let i = 1; i < segments.length - 1; i++) {
    if (PLUGIN_SUBDIRS.has(segments[i])) return segments.slice(0, i).join('/');
  }
  // plugins/<name>/<file>（扁平插件）：插件根就是 plugins/<name>
  return segments.slice(0, Math.min(2, segments.length - 1)).join('/');
}

/**
 * 一次变异该跑哪些测试。
 *
 * 规则按序命中即停（顺序=具体度，不是优先级游戏）：
 *   1. `plugins/**`        ⇒ 同插件 `test/` 目录下的全部测试
 *   2. `bin/<base>.*`      ⇒ `bin/<base>*.test.mjs`（前缀匹配，如 plugin-check.sh ⇒ plugin-check-dim11.test.mjs）
 *   3. `test/**` 根级      ⇒ 仓库根 test/ 下的测试
 *   4. presets/docs/纯文本 ⇒ NO_INSTRUMENT（今天没有能测它的仪器）
 *   5. 其它                ⇒ NO_MAPPING
 *
 * @param {object} input
 * @param {string} input.changedPath 仓库相对路径（parsePreimagePath 的产物）
 * @param {string[]} input.testFiles deriveTestFiles 的产物
 * @param {string[]} [input.repoFiles] 用于核验解出的路径真实存在（防 `__` 有损编码骗过判据）
 * @returns {{files: string[], rule: string, covered: boolean, reason: string|null, changedPath: string}}
 */
export function planTestScope({ changedPath, testFiles, repoFiles = null } = {}) {
  const empty = (rule, reason) => ({ files: [], rule, covered: false, reason, changedPath: changedPath ?? null });
  if (typeof changedPath !== 'string' || changedPath === '') return empty('NO_PATH', 'NO_CHANGED_PATH');
  const p = changedPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = p.split('/');
  const base = segments[segments.length - 1];

  // 路径必须真在仓库里（preimage 反解是有损编码，这里兜住）
  if (Array.isArray(repoFiles) && repoFiles.length > 0 && !repoFiles.includes(p)) {
    return empty('PATH_NOT_IN_REPO', 'CHANGED_PATH_NOT_FOUND');
  }

  const pool = Array.isArray(testFiles) ? testFiles : [];

  if (p.startsWith('plugins/')) {
    const root = pluginRootOf(segments);
    const prefix = `${root}/test/`;
    const files = pool.filter((f) => f.startsWith(prefix));
    if (files.length === 0) return empty('PLUGIN_NO_TEST_DIR', 'NO_EVIDENCE');
    return { files, rule: 'PLUGIN_TEST_DIR', covered: true, reason: null, changedPath: p };
  }

  if (p.startsWith('bin/')) {
    const stem = base.split('.')[0];
    const files = pool.filter((f) => f.startsWith('bin/') && f.startsWith(`bin/${stem}`) && f.endsWith('.test.mjs'));
    if (files.length === 0) return empty('BIN_NO_TEST', 'NO_EVIDENCE');
    return { files, rule: 'BIN_PREFIX_MATCH', covered: true, reason: null, changedPath: p };
  }

  if (p.startsWith('test/')) {
    const files = pool.filter((f) => f.startsWith('test/'));
    if (files.length === 0) return empty('ROOT_TEST_EMPTY', 'NO_EVIDENCE');
    return { files, rule: 'ROOT_TEST_DIR', covered: true, reason: null, changedPath: p };
  }

  const isPreset = UNMEASURABLE_PREFIXES.some((pre) => p.startsWith(pre));
  const isText = UNMEASURABLE_EXT.some((ext) => p.endsWith(ext));
  if (isPreset || isText) {
    // 与 v0.2.14 的期望声明同一条纪律：技能/preset 类今天没有仪器，就别假装量得到。
    return empty('NO_INSTRUMENT', 'NO_INSTRUMENT_FOR_TARGET_KIND');
  }

  return empty('NO_MAPPING', 'NO_TEST_MAPPING');
}

export const SCOPE_RULES = Object.freeze({
  PLUGIN_TEST_DIR: 'PLUGIN_TEST_DIR',
  BIN_PREFIX_MATCH: 'BIN_PREFIX_MATCH',
  ROOT_TEST_DIR: 'ROOT_TEST_DIR',
});

export default { parsePreimagePath, deriveTestFiles, planTestScope, SCOPE_RULES };
