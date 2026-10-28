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
//   - defineTool(desc)   收窄到与真 dsh-tools 同紧（见共用实现）
//
// ⛔ 2026-10-28 修订：defineTool 的替身原先是 `return { ...desc }` —— 原样透传。
//   这不是契约等价，是**比真宿主宽松**：真 dsh-tools 只读 `options.execute`
//   （dsh-tools/lib/index.js:839 `const userExecute = options.execute;`，
//   :869 `return userExecute(args, exec);`），把结果包成一个 `tool.execute`。
//   于是插件把入口写成 `handler` 时：替身下返回对象里带着 `handler`，测试怎么调都"正常"；
//   真宿主则抛 `TypeError: userExecute is not a function`。
//   后果实测：本插件 v0.1.0→v0.3.0 连续三个版本带着这个缺陷上线，而本仓 73 条测试全绿。
//
// ⛔ 2026-10-28 再修订（提案 `846f4fbb` 单元 2）：收紧后的实现抽成
//   `plugins/_shared/test-stub-dsh-tools.mjs`，三处（本插件 / evolve / input-gateway）
//   共用 —— 本文件只做转发。改契约请改共用那一份，并跑它的阴性对照测试。

export { defineDomain, defineTool, assertRequiredTrue, assertToolCallable } from '../../_shared/test-stub-dsh-tools.mjs';
