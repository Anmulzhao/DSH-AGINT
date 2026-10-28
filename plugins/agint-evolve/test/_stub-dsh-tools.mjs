// 测试期模块替身：裸包 '@deepseek-ai/dsh-tools' 的重定向目标。
//
// 为什么要它（取证，2026-10-27）：
//   lib/tools.js:12 `import { defineTool } from '@deepseek-ai/dsh-tools'`
//   而本仓 plugins/agint-evolve/node_modules 不存在（该包只在 dsh 运行时提供），
//   ⇒ 裸工作树直接 import lib/tools.js 会 ERR_MODULE_NOT_FOUND。
//
// ⛔ 纪律（Playbook §3.5）：替身必须复刻真实契约，不是复读被测代码的期望。
//   真实的 defineTool（dsh-tools/lib/index.js:838）做三件事：
//     ① 参数/输出 schema 从「value schema DSL」编译成 JSON Schema
//        （valueSchemaSpecToJsonSchema）；
//     ② 参数侧做 validateArgs；
//     ③ 输出侧交给宿主做 strict 校验（additionalProperties:false ⇒ 返回体里有
//        而 schema 里没声明的字段直接判失败）。
//   本替身仍**不编译 DSL**（schema 保持 value schema DSL 形态），因为用例要校验的正是
//   「声明字段集 ⊇ 实际返回字段集」，校验对象就是 DSL 形态本身；
//   真实侧 DSL→JSON Schema 的转换是机械的（required:true 移到父级 required 数组），
//   字段集不变。本用例不依赖宿主校验器，避开替身与真实校验器的语义差。
//
// ⛔ 2026-10-28 修订（提案 `846f4fbb` 单元 1+2）：defineTool 的替身原先是
//   `return { ...options }` —— 原样透传，比真宿主宽松（真 dsh-tools 只读
//   `options.execute` 与 `options.output.render`）。收紧后的实现现与
//   upstream-watch / input-gateway 两处**共用** —— 三处各抄一份必然漂移，
//   本文件只做转发。
//   ⛔ 改契约请改 `plugins/_shared/test-stub-dsh-tools.mjs`，并跑它的阴性对照
//     （plugins/_shared/test-stub-contract.test.mjs）。

export { defineTool, assertRequiredTrue, assertToolCallable } from '../../_shared/test-stub-dsh-tools.mjs';
