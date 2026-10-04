// 身份顺序：顶层真身。它与嵌套的 agint-dup/agint-dup 同名，
// 身份必须归顶层（顶层目录才是宿主 patch 的挂载单位）。
export function apply(ctx) {
  ctx.provide('agint.dup.top', { where: 'top' });
  return ctx.get('agint.dup.top');
}