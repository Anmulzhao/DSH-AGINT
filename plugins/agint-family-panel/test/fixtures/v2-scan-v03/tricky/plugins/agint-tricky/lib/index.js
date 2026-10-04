// 形参名不匹配的包装**不算**包装：
//   dep 的形参是 n，但函数体里取服务时的实参是**字面量**，形参 n 根本没直传
//   ⇒ dep 不被认定为薄包装（判据是「形参直传」）。
// 于是经 dep 取的那个键不产生任何边；而字面量那次取服务是真的，计 code。
export function apply(ctx) {
  const dep = (n) => ctx.get('agint.literal.svc');
  return dep('agint.tricky.svc');
}