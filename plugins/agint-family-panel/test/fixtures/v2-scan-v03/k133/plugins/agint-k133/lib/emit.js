// K133 收紧判据的**真正自证**（与 eventbus/tricky 的字面量形态互补）：
//
// 这里的取服务实参是**标识符**而非字符串字面量，所以包装识别用的正则会真的命中
// 「函数体内有 ctx.get(形参名)」这个结构 —— 唯一拦住它的是「形参直传」这一条：
// 函数形参是 (topic, payload)，而取服务用的是模块常量 EVENT_BUS，二者对不上，
// ⇒ emit 不是薄包装 ⇒ emit('some.event.name') 里的事件名不得成为服务键。
//
// 为什么必须造这个形态：若取服务实参写成字符串字面量，包装正则压根不命中，
// 判据的「宽」与「严」都测不出来（放宽实现后测试仍然是绿的，等于没有对照）。
const EVENT_BUS = 'agint.bus.publish';

export function apply(ctx) {
  async function emit(topic, payload) {
    const bus = ctx.get(EVENT_BUS);
    if (!bus) return false;
    return bus.publish(topic, payload);
  }
  return emit('some.event.name', { ok: true });
}