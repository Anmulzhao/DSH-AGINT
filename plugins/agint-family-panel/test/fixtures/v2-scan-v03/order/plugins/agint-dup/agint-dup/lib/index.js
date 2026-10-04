// 身份顺序：嵌套同名者。身份已被顶层占用 ⇒ 整个文件不应被扫到
//（若注册顺序反了，这里会抢走 agint-dup，顶层真身被挤掉）。
export function apply(ctx) {
  ctx.provide('agint.dup.nested', { where: 'nested' });
  return ctx.get('agint.dup.nested');
}