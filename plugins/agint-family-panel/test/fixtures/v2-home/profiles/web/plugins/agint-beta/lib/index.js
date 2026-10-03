export function apply(ctx) {
  ctx.provide('agint.beta.svc', () => 1);
  // 注释里的 ctx.get('agint.alpha') → comment
}
