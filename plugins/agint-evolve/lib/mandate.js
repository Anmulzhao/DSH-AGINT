// 审批凭据（Mandate）：把「批准时的改动范围」固化下来，执行前核对。
//
// 要解决的形态
// ─────────────
// `approved` 现在只说「同意做」，没说「同意改哪些东西」。执行器把 proposalId 交给
// driver，driver 从**提案正文里抽路径**（`extractRepoPaths`）再写仓库 ——
// 也就是说「改哪里」是在执行的那一刻才被决定的。
//
// 两个真实的口子：
//   ① 正文在批准之后被编辑（面板/工具都能改），多写一个路径 ⇒ 这次执行就改到了
//      没人批过的文件，而台账上看不出任何异常 —— status 是 approved，凭据一直"在"。
//   ② 抽取规则本身变宽（比如认了新的路径形态），历史批准的语义随之扩大。
//      这不是假设：`normalizeRepoPath` 就是因为部署位路径认不出来而加过一轮壳剥离。
//
// 凭据 = policyVersion + proposalId + 允许路径集合。执行前用它核对，
// 超出范围的那个瞬间原来那份批准就**不再覆盖**新的改动，必须重新走审批。
//
// ⛔ 跨插件不许 import
// ─────────────────────
// `extractRepoPaths` / `normalizeRepoPath` 在 agint-evolution-driver 里。
// 本仓硬约定：跨插件源码 import 在部署位（各自独立目录）会直接 ENOENT。
// 所以这里保留一份**等价但更窄**的实现，并由
// `test/mandate.test.mjs` 与 driver 侧用例各自钉住行为一致。
// 窄的地方：只认反引号包裹的路径 token（driver 那份还要处理"反引号里夹命令"），
// 因为凭据的用途是「范围核对」，漏认一个路径会让范围偏小 —— 偏小是**安全**方向
// （多出来的路径会被判 mismatch，走重新审批），比偏大安全。
// 这个取向必须写下来，否则后人会以为是实现不全。

/** 判定结果三态。⛔ 不要合并成布尔：unknown 不等于 mismatch。 */
export const MANDATE_STATES = Object.freeze({
  /** 在批准范围内（或范围收窄）。 */
  OK: 'ok',
  /** 超出批准范围，或凭据归属不对 —— 原批准不覆盖，须重新审批。 */
  MISMATCH: 'mismatch',
  /** 没有凭据可比（老提案）或两边都空 —— 不能宣称"验过了"。 */
  UNKNOWN: 'unknown',
});

/**
 * 路径 token：至少含一个 `/` 的相对路径，允许常见源码后缀。
 * 与 driver 的 `PATH_TOKEN` 保持同一形态（不引它，见文件头）。
 */
const PATH_TOKEN = '[A-Za-z0-9_.\\-/]+\\.[A-Za-z0-9]+';

/**
 * 把路径归一成仓库相对形态。
 *
 * 只剥**已知的壳**，不做模糊猜测（与 driver `normalizeRepoPath` 同口径）：
 * 行号后缀、Windows 分隔符、`./`、`$DSH_HOME/`、`~/`、部署 bundle 前缀、
 * host 包位前缀。剥完还不认识就原样返回 —— 由调用方判「定位不到」，
 * 不在这里猜。
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizePath(raw) {
  let p = String(raw ?? '').trim();
  if (!p) return '';
  p = p.replace(/:\d+(?:-\d+)?$/, '');         // index.js:793 / index.js:107-167
  p = p.replace(/\\/g, '/');                    // Windows 分隔符
  p = p.replace(/^\.\//, '');
  p = p.replace(/^\$\{?DSH_HOME\}?\/?/, '');    // $DSH_HOME / ${DSH_HOME}
  p = p.replace(/^~\//, '');
  // 尾斜杠：正文里写目录常带 `/`（`plugins/agint-evolve/lib/`），
  // 与不带写法的应是同一个路径，否则同一范围会被判成两个。
  p = p.replace(/\/+$/, '');
  let m = p.match(/\.agint-bundle\/(.+)$/);     // <任意>/.agint-bundle/plugins/x → plugins/x
  if (m) return m[1].replace(/^\.\//, '').replace(/\/+$/, '');
  m = p.match(/node_modules\/@agint\/host\/(.+)$/); // host 包位
  if (m) return m[1].replace(/\/+$/, '');
  return p;
}

/**
 * 从提案正文抽路径，归一、去重、排序。
 *
 * 返回值**总是数组**（抽不到就是 `[]`）—— 上层需要用「空」和「有」区分，
 * 而不是用 undefined 表示两种意思。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractPaths(text) {
  const src = String(text ?? '');
  const re = new RegExp('`(' + PATH_TOKEN + ')`', 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const p = normalizePath(m[1]);
    // 至少含一个 `/` 才当仓库路径：裸文件名（`package.json`）在正文里太常见，
    // 当范围会引入大量误判。
    if (p && p.includes('/') && !p.includes('://') && !out.includes(p)) out.push(p);
  }
  return out.sort();
}

/**
 * 归一一个路径数组：只留非空字符串，剥壳、去重、排序。
 * @param {unknown} list
 * @returns {string[]}
 */
export function mandatePaths(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const p = normalizePath(item);
    if (p && !out.includes(p)) out.push(p);
  }
  return out.sort();
}

/**
 * 生成一份凭据。在 `approved` 落库的那一刻调用。
 *
 * @param {{id:string, body?:string}} rec 提案行
 * @param {string} policyVersion 当前判尺口径（取不到就空串 = 口径未知，不猜）
 * @returns {{proposalId:string, paths:string[], grantedAt:string, policyVersion:string}}
 */
export function grantMandate(rec, policyVersion = '') {
  return {
    proposalId: String(rec?.id ?? ''),
    paths: extractPaths(rec?.body),
    grantedAt: new Date().toISOString(),
    policyVersion: typeof policyVersion === 'string' ? policyVersion : '',
  };
}

/**
 * 核对一条提案此刻的改动范围是否仍在批准范围内。
 *
 * ⛔ 只读：不修改入参、不落盘、不读时钟以外的外部状态。
 *
 * 判据（三态，见 MANDATE_STATES）：
 *   凭据缺失 / 两边都空           ⇒ unknown（**不是** mismatch）
 *   凭据的 proposalId 与提案不符  ⇒ mismatch（凭据归属错了）
 *   正文路径 ⊆ 凭据路径            ⇒ ok（收窄也 ok）
 *   有正文路径不在凭据里           ⇒ mismatch（越权，须重新审批）
 *
 * @param {object} rec 提案行
 * @returns {{state:string, extra:string[], granted:string[], current:string[], reason:string}}
 */
export function checkMandate(rec) {
  const empty = { extra: [], granted: [], current: [] };
  if (!rec || typeof rec !== 'object') {
    return { state: MANDATE_STATES.UNKNOWN, ...empty, reason: '没有提案行，无从核对' };
  }
  const m = rec.mandate;
  if (!m || typeof m !== 'object' || !Array.isArray(m.paths)) {
    return {
      state: MANDATE_STATES.UNKNOWN, ...empty,
      reason: '这条提案没有审批凭据（批准发生在凭据机制之前）—— 不判越权，但也不能宣称验过',
    };
  }
  if (String(m.proposalId ?? '') !== String(rec.id ?? '')) {
    return {
      state: MANDATE_STATES.MISMATCH, ...empty,
      granted: mandatePaths(m.paths),
      reason: `审批凭据不属于这条提案（凭据记的是 ${String(m.proposalId ?? '（空）')}）`,
    };
  }
  const granted = mandatePaths(m.paths);
  const current = extractPaths(rec.body);
  if (granted.length === 0 && current.length === 0) {
    return {
      state: MANDATE_STATES.UNKNOWN, ...empty,
      reason: '批准时与现在都没识别出可改路径 —— 没有范围可比',
    };
  }
  const extra = current.filter((p) => !granted.includes(p));
  if (extra.length > 0) {
    return {
      state: MANDATE_STATES.MISMATCH,
      extra, granted, current,
      reason: `正文路径超出批准范围（${extra.join('、')}）—— 原有批准不覆盖这些改动，须重新审批`,
    };
  }
  return {
    state: MANDATE_STATES.OK,
    extra: [], granted, current,
    reason: granted.length === 0
      ? '批准时无路径（正文后来才写出路径），但当前无越界'
      : `改动范围在批准范围内（${current.length}/${granted.length} 个路径）`,
  };
}
