// 间接取服务：形参直传 ⇒ 认定为薄包装。
// 头部注释刻意不写可被扫描正则命中的调用形态（扫描器会扫到夹具自己）。
// 下面 dep 的形参直传给取服务调用，故经 dep 取的那个键应计 code 边。
export function apply(ctx) {
  const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null);
  const evolve = dep('agint.indirect.svc');
  return evolve;
}