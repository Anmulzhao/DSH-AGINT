/**
 * plugins/_shared/test-stub-dsh-tools.mjs —— dsh-tools / dsh-storage-domain 的**契约替身**（共用一份）。
 *
 * ## 为什么要有这一份
 *
 * 本机仓库工作树里没有 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-storage-domain`
 * （这两个包只在 dsh 运行时提供），裸跑测试会 `ERR_MODULE_NOT_FOUND`。于是每个插件各写一份替身。
 * 而替身一旦**比真宿主宽松**，它的「全绿」就没有判据价值 —— 这是 2026-10-28 提案 `846f4fbb`
 * 的元根因，也是它要求「先抽共用再逐个迁」的理由：
 *
 *   1. `inject` 漏 `'tools'`          ⇒ 插件整个挂不上（真宿主抛 cannot get property "tools"）；
 *   2. `defineTool` 入口写成 `handler` ⇒ 注册成功、真调抛 `TypeError: userExecute is not a function`；
 *   3. `output.render` 未写           ⇒ 真调抛 `output.render failed: userRender is not a function`。
 *
 * 这三条在同一个季度里让 agint-upstream-watch 连续三个版本（v0.1.0→v0.3.0）带着缺陷上线，
 * 而本仓 73 条测试全绿 —— 因为当时的替身是 `return { ...desc }`（原样透传）。
 *
 * ⛔ 三条纪律（改这份文件时先读一遍）：
 *   ① 替身复刻**真实契约**，不做"让它通过"的变形（Playbook §3.5）；
 *   ② 只认 `options.execute` 与 `options.output.render`，其余字段一律不猜；
 *   ③ 值 schema DSL 里 `required` 只要出现就必须是 `true`（真宿主 dsh-tools:602/603 的 authorError）。
 *
 * ## 用法
 *
 * 各插件的 `test/_stub-*.mjs` 一律 `export { ... } from '../../_shared/test-stub-dsh-tools.mjs'`，
 * ⛔ 不要再本地抄一份 —— 三处各抄一份必然漂移（这就是本文件存在的原因）。
 *
 * 真调一次（提交前就该跑到的那一环）：
 *
 *   import { assertToolCallable } from '../../_shared/test-stub-dsh-tools.mjs';
 *   const { value, rendered } = await assertToolCallable(tool, { args: {} });
 */

/**
 * 收紧后的 defineTool：与真 dsh-tools 同紧。
 *
 * 真宿主的关键三行（dsh-tools/lib/index.js）：
 *   :839 `const userExecute = options.execute;`      —— 入口**只**从 options.execute 取
 *   :846 `const userRender = options.output.render;` —— render **只**从 options.output.render 取
 *   :856 `render(args, value) { return userRender(args, value); }`
 *   :869 `return userExecute(args, exec);`
 * ⇒ 写错入口名时，工具对象**照样注册成功**，缺陷要等到真调那一刻才炸。
 */
export function defineTool(desc) {
  if (!desc || typeof desc.name !== 'string') {
    throw new Error('defineTool: desc.name must be a string');
  }
  const userExecute = desc.execute;
  const userRender = desc.output?.render;
  const tool = {
    name: desc.name,
    description: desc.description,
    parameters: desc.parameters ?? {},
    output: {
      schema: desc.output?.schema,
      // 真宿主是「先校验 schema、再调 render」⇒ 只写 schema 不写 render 的缺陷
      // 晚到真调那一刻才炸（2026-10-28 v0.3.0 现场：
      // `output.render failed: userRender is not a function`）。
      render(args, value) {
        if (typeof userRender !== 'function') {
          throw new TypeError('userRender is not a function');
        }
        return userRender(args, value);
      },
    },
    async execute(args, exec) {
      if (typeof userExecute !== 'function') {
        throw new TypeError('userExecute is not a function');
      }
      return userExecute(args, exec);
    },
  };
  assertRequiredTrue(tool.output?.schema, tool.name);
  return tool;
}

/** defineDomain 由真宿主的 ctx.storageDomain.open(spec) 消费：原样返回 spec 就是它的契约。 */
export function defineDomain(spec) {
  if (!spec || typeof spec.name !== 'string') {
    throw new Error('defineDomain: spec.name must be a string');
  }
  return { ...spec };
}

/**
 * 值 schema DSL 约束：`required` 只要出现就必须是 `true`
 * （真宿主 dsh-tools/lib/index.js:602/603 的 authorError）。替身同样拒收。
 */
export function assertRequiredTrue(schema, toolName, path = '') {
  if (!schema || typeof schema !== 'object') return;
  if (Object.hasOwn(schema, 'required') && schema.required !== true) {
    throw new Error(
      `defineTool(${toolName}): schema${path ? `.${path}` : ''}.required 只能是 true（dsh-tools authorError）`,
    );
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    assertRequiredTrue(v, toolName, path ? `${path}.${k}` : k);
  }
  if (schema.items && typeof schema.items === 'object') {
    assertRequiredTrue(schema.items, toolName, `${path}[]`);
  }
}

const USER_EXECUTE_RE = /userExecute is not a function/;
const USER_RENDER_RE = /userRender is not a function/;

/**
 * 真调一次：execute + output.render 都要真的跑一遍。
 *
 * 为什么要它：只断言「工具注册了、名字对」从来抓不到上面那两条缺陷 ——
 * 错注册的工具**在工具表里**（名字、schema 都在），只有真调才会炸。
 *
 * @param {object} tool defineTool 返回的工具对象
 * @param {object} [opts]
 * @param {object} [opts.args] 传给 execute 的参数
 * @param {boolean} [opts.tolerateRuntimeError] 默认 false。
 *   false ⇒ execute/render 抛任何错都算失败；
 *   true  ⇒ 只把「契约类错误」（userExecute / userRender 缺失）判失败，
 *           其它运行时错误放行（给「只想验契约、不想备齐所有服务」的冒烟用）。
 * @returns {Promise<{value:unknown, rendered:unknown, error:Error|null, renderError:Error|null}>}
 */
export async function assertToolCallable(tool, opts = {}) {
  const label = String(tool?.name ?? '(unnamed)');
  const args = opts.args ?? {};
  const tolerate = opts.tolerateRuntimeError === true;

  let value = null;
  let error = null;
  try {
    value = await tool.execute(args, opts.exec ?? {});
  } catch (e) {
    error = e;
  }
  if (error instanceof TypeError && USER_EXECUTE_RE.test(error.message)) {
    throw new Error(`${label} 的入口不是 execute（真宿主会抛 userExecute is not a function）：${error.message}`);
  }
  if (error && !tolerate) throw error;

  let rendered = null;
  let renderError = null;
  try {
    rendered = tool.output.render(args, value ?? opts.value);
  } catch (e) {
    renderError = e;
  }
  if (renderError instanceof TypeError && USER_RENDER_RE.test(renderError.message)) {
    throw new Error(`${label} 缺 output.render（真宿主会抛 userRender is not a function）：${renderError.message}`);
  }
  if (renderError && !tolerate) throw renderError;

  return { value, rendered, error, renderError };
}
