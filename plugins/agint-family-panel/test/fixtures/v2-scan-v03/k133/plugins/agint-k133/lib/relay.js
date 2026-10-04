// 同上形态的箭头函数版：形参直传判据在 DEP_DEF_ARROW 上也要成立。
// relay 的形参 n 没有直传给取服务（那里用的是模块常量 UPSTREAM_BUS），
// ⇒ relay 不是薄包装 ⇒ relay('some.other.event') 的事件名不得成为服务键。
const UPSTREAM_BUS = 'agint.bus.upstream';

export function apply(ctx) {
  const relay = (n) => ctx.get(UPSTREAM_BUS);
  return relay('some.other.event');
}