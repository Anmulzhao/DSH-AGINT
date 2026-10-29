/**
 * 工具契约：每个已注册工具都要**真调一次** execute + output.render（2026-10-28，提案 `846f4fbb` 单元 3）。
 *
 * ## 补的是哪个洞
 *
 * 真 dsh-tools 的 `defineTool` 只读 `options.execute` 与 `options.output.render`
 * （dsh-tools/lib/index.js:839 / :846 / :856 / :869）。插件把入口写成 `handler`
 * 或漏写 `render` 时，工具**照样注册成功**（名字、schema 都在工具表里），
 * 缺陷要等到真调那一刻才炸 —— agint-upstream-watch 就是带着它连上了三个版本，
 * 而本仓 73 条测试全绿。只断言「注册了 N 个工具、名字对」永远抓不到这类错。
 *
 * ⛔ 本文件自己注册 module hook（不依赖外部 `--import`），这样任何跑法
 *    （`node --test test/*.mjs`、`plugin-check`、CI）都会带上替身，不会因为
 *    "忘了加参数" 而退化成 ERR_MODULE_NOT_FOUND。
 *
 * 为什么容忍 execute 的运行时错误：这里验的是**契约**（入口名 / render 在不在），
 * 不是业务逻辑 —— 备齐 6 个工具各自依赖的服务不是本文件的职责。
 * `assertToolCallable(..., { tolerateRuntimeError: true })` 只把契约类错误判失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

register(pathToFileURL(join(import.meta.dirname, '_stub-loader.mjs')).href);

const toolsMod = await import('../lib/tools.js');

function registerAll() {
  const registered = [];
  // ⛔ ctx 只给 tools.register：注册路径不该依赖任何服务，
  //    依赖服务 ⇒ 说明注册逻辑本身写歪了（真宿主也是先注册后注入）。
  toolsMod.apply({ tools: { register: (t) => registered.push(t) } });
  return registered;
}

// ⛔ 2026-10-30：这段必须放在 test() **之前**。原来它在文件末尾（test 之后），
//    而 `const { assertToolCallable } = await import(...)` 是**顶层 await** ——
//    node:test 会在模块让出执行权的那一刻开始跑已注册的用例，于是用例撞上
//    TDZ：`Cannot access 'assertToolCallable' before initialization`。
//    这条一直没红只是因为「让出时机」凑巧站在后面；2026-10-30 一次重跑就翻。
// 用动态 import 拿到共用替身里的断言助手（本文件已注册 hook ⇒ 裸包可解析）。
const { assertToolCallable } = await import('../../_shared/test-stub-dsh-tools.mjs');

test('工具注册：6 个工具全部进来，且都带 execute 与 output.render', () => {
  const registered = registerAll();
  assert.equal(registered.length, 6, `注册数不对：${registered.map((t) => t.name).join(', ')}`);
  const names = registered.map((t) => t.name);
  for (const n of ['evolve_review', 'evolve_read', 'evolve_propose', 'evolve_proposals', 'evolve_set_status', 'evolve_executions']) {
    assert.ok(names.includes(n), `缺工具 ${n}`);
  }
  for (const t of registered) {
    assert.equal(typeof t.execute, 'function', `${t.name} 没有 execute`);
    assert.equal(typeof t.output?.render, 'function', `${t.name} 没有 output.render`);
  }
});

test('真调一次：每个工具的入口必须是 execute，render 必须真的存在', async () => {
  const registered = registerAll();
  for (const tool of registered) {
    // tolerateRuntimeError=true：只判契约类错误（userExecute / userRender 缺失）。
    const { error, renderError } = await assertToolCallableSafe(tool);
    assert.ok(
      !(error instanceof TypeError && /userExecute is not a function/.test(error.message)),
      `${tool.name} 的入口不是 execute（真宿主会抛 userExecute is not a function）`,
    );
    assert.ok(
      !(renderError instanceof TypeError && /userRender is not a function/.test(renderError.message)),
      `${tool.name} 缺 output.render（真宿主会抛 userRender is not a function）`,
    );
  }
});

async function assertToolCallableSafe(tool) {
  return assertToolCallable(tool, { args: {}, tolerateRuntimeError: true });
}
