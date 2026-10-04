export function apply(ctx) {
  ctx.provide('agint.skip.top', { via: 'top' });
  return ctx.get('agint.skip.top');
}