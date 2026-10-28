/**
 * agint-upstream-watch — 版本语义（纯函数，零依赖）。
 *
 * ## 为什么不引 semver
 *
 * 仓库有 `docs/zero-deps-allowlist.json` 约束，且我们只需要三件事：
 * 解析、比较、判级别。`semver` 包的 90% 能力（range / 交集 / coerce）在这里全是负担，
 * 而且 npm 安装会跟着 install.sh 的 rsync 走，升级时多一处冲突面。
 *
 * ## 与 semver 的一致性边界
 *
 * 实现的规则（与 https://semver.org §11 一致）：
 *   - 比 major → minor → patch
 *   - 有 prerelease 的 < 无 prerelease 的（`1.0.0-rc.1 < 1.0.0`）
 *   - 两边都有 prerelease：逐段比，数字段按数值、字符串段按字典序，
 *     且「数字段 < 字符串段」（`1.0.0-1 < 1.0.0-alpha`）
 *   - 短的一方更小（`1.0.0-alpha < 1.0.0-alpha.1`）
 *
 * 不支持：build metadata（`+xxx` 直接忽略）、`v` 前缀以外的修饰、range 语法。
 * dsh 的 tag 形如 `dsh-v0.2.2-alpha.2`，需要一个剥前缀的入口。
 */

/** 剥掉 tag 前缀：`dsh-v0.2.2-alpha.2` → `0.2.2-alpha.2` */
export function normalizeTag(tag) {
  return String(tag ?? '').trim().replace(/^.*?v(?=\d)/i, '').replace(/^v(?=\d)/i, '');
}

/**
 * 解析版本号。解析不出来返回 null（⛔ 不返回一个「看起来像 0.0.0」的默认值 ——
 * 那会让「解析失败」和「真的是 0.0.0」混在一起）。
 */
export function parseVersion(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  // build metadata 丢掉，不参与比较
  const noBuild = s.split('+')[0];
  const dashIdx = noBuild.indexOf('-');
  const core = dashIdx >= 0 ? noBuild.slice(0, dashIdx) : noBuild;
  const pre = dashIdx >= 0 ? noBuild.slice(dashIdx + 1) : '';

  const parts = core.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  while (nums.length < 3) nums.push(0);

  const preIds = pre
    ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : [];

  return {
    raw: s,
    major: nums[0],
    minor: nums[1],
    patch: nums[2],
    pre: preIds,
    isPrerelease: preIds.length > 0,
  };
}

/** 比较两个 prerelease 标识符段 */
function comparePreIds(a, b) {
  const an = typeof a === 'number';
  const bn = typeof b === 'number';
  if (an && bn) return a === b ? 0 : (a < b ? -1 : 1);
  // 数字段 < 字符串段
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  return a === b ? 0 : (a < b ? -1 : 1);
}

/**
 * 比较两个版本。返回 -1 / 0 / 1。
 * 任一侧解析失败 ⇒ 抛错（⛔ 不返回 0 冒充「相同」）。
 */
export function compareVersion(a, b) {
  const va = typeof a === 'object' && a ? a : parseVersion(a);
  const vb = typeof b === 'object' && b ? b : parseVersion(b);
  if (!va) throw new Error(`compareVersion: 无法解析版本 "${a}"`);
  if (!vb) throw new Error(`compareVersion: 无法解析版本 "${b}"`);

  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }

  // 主体相同：无 prerelease 的更大
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;

  const len = Math.min(va.pre.length, vb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const c = comparePreIds(va.pre[i], vb.pre[i]);
    if (c !== 0) return c;
  }
  if (va.pre.length === vb.pre.length) return 0;
  // 短的一方更小
  return va.pre.length < vb.pre.length ? -1 : 1;
}

/**
 * 判级别。返回 'same' | 'downgrade' | 'prerelease' | 'patch' | 'minor' | 'major' | 'unknown'。
 *
 * 'prerelease' 是刻意单独一档：从 `0.2.1-rc.3` 到 `0.2.1-rc.4` 主体没动，只换了预发布号，
 * 处置策略与「主体变了」完全不同 —— 前者通常是无风险小修。
 *
 * ⛔ 本函数**只表达版本号语义**，不掺「稳不稳」的判断。`0.2.1-rc.3 → 0.2.2-alpha.2`
 *    在 semver 里是合法的 patch 前进（0.2.1 → 0.2.2），但发布阶段从 rc 退回了 alpha。
 *    这件事由 `preStageChange()` 单独回答，别在这里混成一个复合标签 ——
 *    混了之后调用方就没法只问「主体动了多少」或只问「阶段退了没」。
 */
export function classifyLevel(from, to) {
  const va = parseVersion(normalizeTag(from));
  const vb = parseVersion(normalizeTag(to));
  if (!va || !vb) return 'unknown';

  const cmp = compareVersion(va, vb);
  if (cmp === 0) return 'same';
  if (cmp > 0) return 'downgrade';

  if (vb.major !== va.major) return 'major';
  if (vb.minor !== va.minor) return 'minor';
  if (vb.patch !== va.patch) return 'patch';
  // 主体相同、只动 prerelease（rc.3 → rc.4，或 alpha.2 → alpha.3）
  return 'prerelease';
}

/**
 * 预发布阶段序。dsh 用的是 alpha → (beta) → rc → 正式版。
 * 字母序恰好与阶段序一致，但别依赖字母序 —— 显式写出来，将来加 beta 也不用改逻辑。
 */
const PRE_STAGES = { alpha: 0, beta: 1, rc: 2 };

/** 取预发布阶段名（`0.2.2-alpha.2` → 'alpha'；正式版 → null） */
export function preStage(version) {
  const v = typeof version === 'object' && version ? version : parseVersion(normalizeTag(version));
  if (!v || !v.isPrerelease) return null;
  const head = String(v.pre[0] ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRE_STAGES, head) ? head : head || null;
}

/**
 * 发布阶段怎么变了。
 *
 * @returns {'regressed'|'advanced'|'same'|'unknown'}
 *   从 rc 到 alpha = `regressed` —— 版本号在涨，但成熟度在退。
 *   2026-10-28 的实例：`0.2.1-rc.3`（本机）之后最新是 `0.2.2-alpha.2`，
 *   版本前进但阶段倒退，这正是「别急着跟」的信号。
 */
export function preStageChange(from, to) {
  const a = preStage(from);
  const b = preStage(to);
  if (a === null && b === null) return 'same';
  if (a === null && b !== null) return 'regressed';   // 正式版 → 预发布
  if (a !== null && b === null) return 'advanced';    // 预发布 → 正式版
  const ra = PRE_STAGES[a];
  const rb = PRE_STAGES[b];
  if (ra === undefined || rb === undefined) return 'unknown';
  if (rb === ra) return 'same';
  return rb > ra ? 'advanced' : 'regressed';
}

/** 从一组 tag 里挑最新的（按 semver，不是按字符串） */
export function pickLatest(tags) {
  const list = (Array.isArray(tags) ? tags : []).filter((t) => parseVersion(normalizeTag(t)));
  if (list.length === 0) return null;
  return list.reduce((best, cur) => (
    compareVersion(parseVersion(normalizeTag(cur)), parseVersion(normalizeTag(best))) > 0 ? cur : best
  ));
}

/** 计算落后多少个版本（仅同一轨道内计数，跨轨道返回 null —— 无意义） */
export function countLag(from, to) {
  const va = parseVersion(normalizeTag(from));
  const vb = parseVersion(normalizeTag(to));
  if (!va || !vb) return null;
  if (compareVersion(va, vb) >= 0) return 0;
  if ((va.isPrerelease) !== (vb.isPrerelease)) return null;
  // 只对 patch 级差距给数字；major/minor 差距用「差几个版本」是误导
  if (va.major !== vb.major || va.minor !== vb.minor) return null;
  return vb.patch - va.patch;
}
