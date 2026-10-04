// SKIP_DIRS 里的 'test' ⇒ 不是插件身份，不该被扫（若扫了，units 会多出 'agint-skipped-test'）。
export function apply(ctx) {
  ctx.provide('agint.skip.leaked.test', {});
  return ctx;
}