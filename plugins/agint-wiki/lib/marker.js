/**
 * 生成页标记（阶段 3，2026-11-07）。
 *
 * 为什么需要一个独立小模块：生成页和人工页在同一个 wiki 根里，两处代码要
 * 用同一个判据 ——
 *   1. 构建器：目标文件已存在但**没有** marker ⇒ 拒绝覆盖（人工页不可被机器冲掉）。
 *   2. linter：生成页里带 ⚠️ 的行是**引用的原文**，不是本页的主张，不该算
 *      「本页自相矛盾」（否则聚合页一生成就把 healthy 打成 false）。
 *
 * ⛔ 判据必须只有一份。两个文件各写一遍正则 = 第二种口径，迟早漂移。
 */

export const GEN_MARKER_PREFIX = '<!-- agint-wiki-gen:';

/** 人类可读的生成页头。at 是易变字段，比对时会被 strip。 */
export function genMarker({ at, sources }) {
  const stamp = at instanceof Date ? at.toISOString() : String(at);
  return `${GEN_MARKER_PREFIX} v1 at=${stamp} sources=${sources} -->`;
}

/** 判断一段正文是否是本构建器产出的页。 */
export function isGenerated(content) {
  return typeof content === 'string' && content.startsWith(GEN_MARKER_PREFIX);
}

/**
 * 把 marker 里的时间戳抹掉，用于判断「内容是否真的变了」。
 * 只有时间戳变、内容没变时，重构不该报 drift，也不该重写文件。
 */
export function stripVolatile(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/^(<!-- agint-wiki-gen: v\d+ )at=\S+/m, '$1at=*');
}
