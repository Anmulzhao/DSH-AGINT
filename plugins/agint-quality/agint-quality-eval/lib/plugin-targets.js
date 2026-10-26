/**
 * agint-quality-eval/lib/plugin-targets.js
 * — 从宿主 loader 名册枚举 plugin 评估目标（0.3.5，老板 2026-10-14 拍板方案 2）。
 *
 * 为什么独立成文件：服务逻辑放 `lib/<name>.js` 才隔离得出来测
 * （Playbook §3.22：别内联进 index.js，否则拿不到注入）。
 *
 * 为什么用 ctx.loader.entries() 而不是扫目录：
 *   - family-panel 的口径（lib/index.js:176）：patch 只说"要什么"，
 *     **loader 才说明"挂上了什么"**。扫目录会把"没挂载的插件"也算进来，
 *     评估一个没在跑的东西没有意义。
 *   - 部署位有三个副本（仓库 / profiles/web/plugins / .agint-bundle/plugins），
 *     扫目录无法判断哪个才是活的。
 *
 * ⚠️ 两个已踩过的坑，这里都有兜底：
 *   1. `entries()` 是**迭代器不是数组** —— agint-mascot v0.1.1 踩过：
 *      用 `Array.isArray` 判形状会把一个健康的宿主读成 warn。
 *   2. entry 的 id 在 `entry.options.id`，fallback `entry.id`
 *      （family-panel/lib/index.js:191 同款取值顺序）。
 */

/**
 * 把 iterable / array 归一化成数组；不是集合就返回 null。
 * 照 agint-mascot/lib/index.js:123 的 toArray() 先例，不自创。
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' || value === null || value === undefined) return null;
  if (typeof value[Symbol.iterator] !== 'function') return null;
  try {
    return [...value];
  } catch {
    return null;
  }
}

/**
 * 从 loader 名册枚举 plugin 目标。
 *
 * ⛔ 读不到就是读不到：返回空数组 + reason，绝不编造名册
 * （family-panel 的同款纪律：空名册要带 stated reason，不能用 0 冒充健康）。
 *
 * @param {object} ctx cordis context（需要 ctx.loader）
 * @param {string} idPrefix 命名空间过滤（默认 'agint-'）
 * @returns {{ targets: Array<{id:string, kind:'plugin', version:'0.0.0'}>, reason: string|null }}
 */
export function enumeratePluginTargets(ctx, idPrefix = 'agint-', selfId = null) {
  // loader 缺失（非宿主环境 / 单测注入）⇒ 显式降级，不静默返回空
  if (!ctx || !ctx.loader || typeof ctx.loader.entries !== 'function') {
    return { targets: [], reason: 'loader-unavailable' };
  }

  let entries;
  try {
    entries = toArray(ctx.loader.entries());
  } catch (err) {
    return { targets: [], reason: `loader-threw:${String(err?.message ?? err).slice(0, 120)}` };
  }
  if (entries === null) {
    return { targets: [], reason: 'loader-entries-not-iterable' };
  }

  const targets = [];
  const seen = new Set();
  for (const entry of entries) {
    const options = entry && entry.options;
    const id = (options && options.id) ?? (entry && entry.id);
    if (typeof id !== 'string' || id === '') continue;
    // 显式 disabled 的不评估 —— 它没在跑
    if (entry && entry.disabled === true) continue;
    // 命名空间过滤：宿主其它 plugin 不在本系统评估范围
    if (idPrefix && !id.startsWith(idPrefix)) continue;
    // 排除自评：枚举层就剔掉，别让它变成一条"拒绝自评"的失败记录
    // （evaluate() 里的 SELF_PLUGIN_ID 拒绝仍是兜底，两层都留）
    if (selfId && id === selfId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({ id, kind: 'plugin', version: '0.0.0' });
  }
  return { targets, reason: null };
}
