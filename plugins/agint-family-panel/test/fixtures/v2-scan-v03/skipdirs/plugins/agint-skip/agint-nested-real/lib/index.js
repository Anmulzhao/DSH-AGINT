// 唯一该被扫到的嵌套单元：名字不在 SKIP_DIRS 里。
export function apply(ctx) {
  ctx.provide('agint.skip.nested', { via: 'nested' });
  return ctx.get('agint.skip.nested');
}