// 测试期裸包重定向（module customization hook）。
//
// 为什么需要它（取证，2026-10-14 pwsh 实测）：
//   Test-Path "D:\DSH\project源码\DSH-AGINT\plugins\agint-evolve\node_modules" → False
//   Test-Path "D:\DSH\project源码\DSH-AGINT\node_modules\@deepseek-ai\dsh-storage-domain" → False
//   lib/index.js:30 里 `import { defineDomain } from '@deepseek-ai/dsh-storage-domain'`
//   ⇒ 本机仓库工作树直接 `node --test` 会 ERR_MODULE_NOT_FOUND。
//   §3.18 纪律：裸工作树要拒测，不是量了再解释。所以要么装依赖，要么显式替身。
//
// 用法：node --import ./test/_stub-register.mjs --test test/xxx.test.mjs
//
// ⛔ 只重定向这一个裸包，其余全部 next() 放行。不拦截 zod、不拦 node: 内建。

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const STUB = pathToFileURL(join(import.meta.dirname, '_stub-storage-domain.mjs')).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-storage-domain') {
    return { url: STUB, shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}
