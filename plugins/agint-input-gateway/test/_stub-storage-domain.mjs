// 测试期模块替身：本机仓库工作树没有 @deepseek-ai/dsh-storage-domain 与
// @deepseek-ai/dsh-tools（这两个包只在 dsh 运行时提供）。
//
// 取证（2026-10-14 pwsh 实测，本插件自己的两个 import）：
//   lib/storage.js:  import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
//   lib/tools.js:11: import { defineTool }   from '@deepseek-ai/dsh-tools'
//   裸跑 node --test test/gateway.test.mjs →
//     ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-storage-domain'
//   裸跑 node --test test/tools.test.mjs  →
//     ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
//   ⇒ §3.18 纪律：裸工作树要拒测。要么装依赖，要么显式替身。
//
// 用法：node --import ./test/_stub-register.mjs --test test/xxx.test.mjs
//
// ⛔ 纪律（Playbook §3.5）：替身复刻真实契约，不做"让它通过"的变形。
//   - defineDomain(spec) 原样返回 spec（由 ctx.storageDomain.open(spec) 消费）
//   - defineTool(desc)   原样返回 desc（由 ctx.declareTool(desc) 消费）

export function defineDomain(spec) {
  if (!spec || typeof spec.name !== 'string') {
    throw new Error('defineDomain: spec.name must be a string');
  }
  return { ...spec };
}

export function defineTool(desc) {
  if (!desc || typeof desc.name !== 'string') {
    throw new Error('defineTool: desc.name must be a string');
  }
  return { ...desc };
}
