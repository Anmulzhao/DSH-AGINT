// K133 自证（反向用例）：publishEvent **不是**薄包装——
// 它的形参都没直传到取服务调用，那句取的是字面量、只服务它自己。
// 所以 publishEvent 的实参是**事件名**，绝不能被记成服务键
//（早期版本用「函数体任意位置有取服务调用」当包装，会多出这条假边）。
export function apply(ctx) {
  async function publishEvent(topic, payload) {
    const p = ctx.get('agint.bus.publish');
    if (!p) return false;
    return p.publish(topic, payload);
  }
  return publishEvent('some.event.name', { ok: true });
}