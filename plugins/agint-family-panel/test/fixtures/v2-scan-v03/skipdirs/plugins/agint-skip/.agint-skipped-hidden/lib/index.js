// '.' 开头的目录 ⇒ 不是插件身份，不该被扫。
export function apply(ctx) {
  ctx.provide('agint.skip.leaked.hidden', {});
  return ctx;
}