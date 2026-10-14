// 测试期模块替身：本机仓库根没有 @deepseek-ai/dsh-storage-domain（该包只在
// dsh 运行时提供；plugins/agint-evolve/node_modules 不存在，§3.18「裸工作树要拒测」）。
//
// 用法：node --import ./test/_stub-storage-domain.mjs --test test/xxx.test.mjs
//
// ⛔ 纪律（Playbook §3.5）：替身必须复刻真实契约，不是复读被测代码的期望。
//   真实 dsh-storage-domain 的 defineDomain 返回一个 domain spec 对象
//   （{ name, version, tables }），由 ctx.storageDomain.open(spec) 消费。
//   这里原样返回入参，不做任何"让它通过"的变形。

export function defineDomain(spec) {
  if (!spec || typeof spec.name !== 'string') {
    throw new Error('defineDomain: spec.name must be a string');
  }
  return { ...spec };
}
