// SKIP_DIRS 里的 'docs' ⇒ 不是插件身份，不该被扫。
export function apply(ctx) {
  ctx.provide('agint.skip.leaked.docs', {});
  return ctx;
}