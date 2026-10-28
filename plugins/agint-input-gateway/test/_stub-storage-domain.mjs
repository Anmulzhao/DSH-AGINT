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
// ⛔ 2026-10-28 修订（提案 `846f4fbb` 单元 1+2）：本文件的 defineTool 原先是
//   `return { ...desc }` —— **原样透传**，比真宿主宽松：
//     · 插件把入口写成 `handler` ⇒ 替身下对象里照样带着 handler，测试怎么调都"正常"；
//     · 真宿主只读 `options.execute`（dsh-tools/lib/index.js:839），真调必抛
//       `TypeError: userExecute is not a function`；
//     · `output.render` 同理（:846 / :856），只写 schema 不写 render 的缺陷
//       要等到真调那一刻才炸（upstream-watch v0.3.0 的现场）。
//   同类替身共三份（upstream-watch / evolve / 本插件），各抄一份必然漂移 ⇒
//   现在共用 `plugins/_shared/test-stub-dsh-tools.mjs`，本文件只做转发。
//   ⛔ 不要在这里恢复本地实现：改契约请改共用那一份，并跑它的阴性对照
//     （plugins/_shared/test-stub-contract.test.mjs）。

export { defineDomain, defineTool, assertRequiredTrue, assertToolCallable } from '../../_shared/test-stub-dsh-tools.mjs';
