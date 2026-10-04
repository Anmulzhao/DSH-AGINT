// 键前缀放开 + 可选链 + 注释态三合一。
// 头部注释刻意不写可被扫描正则命中的调用形态（扫描器会扫到夹具自己）。
//   L6 可选链双问号形态 → 应为 code
//   L7 宿主键（非家族前缀）→ 应为 code，且键原样透传
//   L8 另一个宿主键 → 同上
//   L11 行注释里的取服务 → 应为 comment，且不建 code 边
export function apply(ctx) {
  const layout = null;
  const opt = ctx?.get?.('agint.optional.svc');
  const agents = ctx.get('agents');
  const subs = ctx.get('subagents');
  void layout;
  void subs;
  // ctx.get('agint.cmt.svc')
  ctx.provide('agint.keys.svc', { opt, agents });
  return agents;
}