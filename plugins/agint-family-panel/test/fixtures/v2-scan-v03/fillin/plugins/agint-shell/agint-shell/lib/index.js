// 顶层无lib/（同目录只有 manifest.json），嵌套单元必须补位成功。
// 若实现只扫顶层 lib，本文件完全扫不到 ⇒ provided 为空。
export function apply(ctx) {
  ctx.provide('agint.shell.svc', { where: 'nested' });
  return ctx.get('agint.shell.svc');
}