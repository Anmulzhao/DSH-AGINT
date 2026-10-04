// 浏览器半：ctx 来自组件 props，不是 cordis 上下文。
// 这里取的是宿主 GUI 壳层的布局服务，不在 node 面服务存储里，
// 按 provide 表判「无提供方」必假 ⇒ BROWSER_HALF_FILES 扫到就 skip。
export function FamilyPanel({ ctx }) {
  const layout = ctx.get('layout');
  return layout;
}