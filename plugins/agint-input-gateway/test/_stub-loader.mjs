// 测试期裸包重定向（module customization hook）。
//
// 为什么需要它（取证，2026-10-14 pwsh 实测，本插件自己的报错）：
//   裸跑 node --test test/gateway.test.mjs → ERR_MODULE_NOT_FOUND:
//     Cannot find package '@deepseek-ai/dsh-storage-domain' (from lib/storage.js)
//   裸跑 node --test test/tools.test.mjs → ERR_MODULE_NOT_FOUND:
//     Cannot find package '@deepseek-ai/dsh-tools' (from lib/tools.js:11)
//   ⇒ 本机仓库工作树缺这两个只在 dsh 运行时提供的包。
//   §3.18 纪律：裸工作树要拒测，不是量了再解释。要么装依赖，要么显式替身。
//
// 用法：node --import ./test/_stub-register.mjs --test test/xxx.test.mjs
//
// ⛔ 只重定向这两个裸包，其余全部 next() 放行。不拦 zod、不拦 node: 内建。

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const STUB = pathToFileURL(join(import.meta.dirname, '_stub-storage-domain.mjs')).href;
const TARGETS = new Set([
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
]);

export async function resolve(specifier, context, next) {
  if (TARGETS.has(specifier)) {
    return { url: STUB, shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}
