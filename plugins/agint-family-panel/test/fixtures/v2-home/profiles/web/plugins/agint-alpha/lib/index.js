export function apply(ctx) {
  // 消费 beta 的具体子键 → code
  const svc = ctx.get('agint.beta.svc');
  // 文档里提到 ctx.get('agint.alpha') 只是说明 → comment
  const self = ctx.get('agint.alpha');
  const ns = ctx.get('agint.beta'); // 裸命名空间键，beta 只提供子键 → umbrella
  // 第三种取服务形态：可选链 + getService → code
  const probe = ctx.getService?.('agint.beta.svc');
  ctx.provide('agint.alpha', { self, svc, ns, probe });
}
