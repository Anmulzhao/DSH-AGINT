// 测试期裸包重定向（module customization hook）。
//
// ## 为什么需要它
//
// 仓库工作树没有 `node_modules`，而 lib/ 里有三个只在 dsh 运行时提供的裸包：
//   lib/storage.js: import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
//   lib/storage.js: import { z }           from 'zod'
//   lib/tools.js:   import { defineTool }  from '@deepseek-ai/dsh-tools'
// 裸跑 `node --test test/smoke.mjs` ⇒ ERR_MODULE_NOT_FOUND: Cannot find package ...
//
// 用法：`node --import ./test/_stub-register.mjs --test test/*.mjs`
// （manifest 的 tests.command 写的就是这条）
//
// 方案与本仓 `agint-input-gateway/test/` 同源；差别是**多处理一个 zod**：
// 那个插件的测试不 import lib/index.js，碰不到 storage.js 的 zod 依赖；
// 本插件的冒烟要跑 apply()，必须穿过 storage.js。
//
// ## 三类包不同处置
//
//   dsh-storage-domain / dsh-tools → 替身（`_stub-storage-domain.mjs`）：
//     它们只是 defineDomain / defineTool 两个纯函数，替身能做到契约等价。
//   zod → **重定向到 dsh 运行时那份真实实现**，不替身：
//     schema 校验是本插件存储域的唯一约束，替身等于把这层测试测空。
//     路径从 node 可执行文件反推（nvm / 系统安装都是 bin 与 lib/node_modules 平级），
//     ⛔ 不写死绝对路径 —— 仓库要能跨机器。
//   其余（node: 内建、cordis 等）→ 一律 next() 放行。

import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const STUB = pathToFileURL(join(import.meta.dirname, '_stub-storage-domain.mjs')).href;
const STUBBED = new Set([
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
]);

/** 从 node 自己的位置反推 dsh 安装树，再解析 zod 的真实入口 */
export function resolveZodUrl() {
  const execDir = dirname(process.execPath);
  const roots = [
    process.env.DSH_ROOT,
    join(execDir, '..', 'lib', 'node_modules'),
    join(execDir, 'node_modules'),
    join(execDir, '..', 'node_modules'),
  ].filter(Boolean);
  for (const root of roots) {
    const dshPkg = join(root, '@deepseek-ai', 'dsh', 'package.json');
    if (!existsSync(dshPkg)) continue;
    try {
      const req = createRequire(dshPkg);
      return pathToFileURL(req.resolve('zod')).href;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

let zodUrl;

export async function resolve(specifier, context, next) {
  if (STUBBED.has(specifier)) {
    return { url: STUB, shortCircuit: true, format: 'module' };
  }
  if (specifier === 'zod') {
    if (zodUrl === undefined) zodUrl = resolveZodUrl();
    // 找不到就抛一条能看懂的错，别让下游报 ERR_MODULE_NOT_FOUND 猜半天
    if (!zodUrl) {
      throw new Error(
        'agint-upstream-watch/test: 找不到 zod。设 DSH_ROOT=<dsh 安装根> 后重跑 —— '
        + '本插件存储域依赖 zod 做 schema 校验，替身会让这一层测试失去意义。',
      );
    }
    return { url: zodUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
