// 与 client.js 同目录的 node 半：必须照常扫描（证明 skip 是按 basename 精确到文件，
// 不是「整个 lib 目录里的浏览器插件一律不扫」这种泛化启发式）。
export function apply(ctx) {
  const store = ctx.get('agint.browser.svc');
  return store;
}