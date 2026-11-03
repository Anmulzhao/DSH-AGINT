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
  assertSchemaSubset(tool.output?.schema, tool.name);
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
 * dsh-tools 的 JSON Schema 子集（真宿主 dsh-tools/lib/types/json-schema.js）。
 *
 * ⛔ 为什么必须有这一条（2026-11-03 现场，v0.20.0 上线事故）：
 *   W8-3 给三处 output schema 的可空凭据写成 `type: ['object','null']`。
 *   `assertRequiredTrue` 只查 `required === true`，**完全不看 type**，
 *   于是 evolve 的全部用例全绿；而真宿主在 `tools.register()` 里第一件事就是
 *   `assertSupportedJsonSchema(output.schema)`（dsh-tools/lib/index.js:2978），
 *   type 数组直接抛 `UNSUPPORTED_SCHEMA`。register() 是 tools 插件挂载的入口
 *   ⇒ agint-evolve-tools 整行激活失败 ⇒ agint preset 下所有 agent 起不来，
 *   UI 显示「加载失败」。门禁四连也全绿（它们只查接线/一致性/兼容性，
 *   不调 register）。只有真用户打开 UI 才看得见。
 *
 * 复刻的是**判定规则**，不是报错文案。分两层，因为 DSL 与产物不是一回事：
 *
 *   【A 层：DSL 作者层】DSH 的 output.schema 是 value schema DSL，宿主先用
 *   `valueSchemaSpecToJsonSchema` 编译成 raw JSON Schema，再对它跑
 *   `assertSupportedJsonSchema`。DSL 里属性上的布尔 `required: true` 会在编译期
 *   被**提升**到父级 `required` 数组、不进入子节点产物（index.js:603/604/597），
 *   所以 `{ required: true, oneOf: [...] }` 这种写法在真宿主上是**合法**的 ——
 *   实测 dsh 0.2.1-rc.5 产出 `properties.mandate = { oneOf: [...] }` +
 *   父级 `required: ["mandate"]`，无残留。
 *   ⇒ 本替身查「与 oneOf 同级」时必须把布尔 required 排除在外，否则会误报。
 *
 *   【B 层：产物层】编译后的产物受 raw 子集约束：type 单一字符串、type 与 oneOf
 *   不并存、oneOf 同级不许带 properties/required 数组等。
 *
 * 事故判据在 B 层：`type: ['object','null']` 在 DSL 里就已非法（type 只收单个
 * 类型字符串），编译产物同样非法 ⇒ register() 抛 UNSUPPORTED_SCHEMA。
 */
const SCHEMA_TYPES = Object.freeze([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);
const ONE_OF_SIBLING_KEYWORDS = Object.freeze([
  'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required',
  'additionalProperties', 'items', 'enum', 'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);

/**
 * 断言 schema 落在 dsh-tools 支持的子集内。不合法直接抛（真宿主是注册期硬拒）。
 *
 * @param {object} schema
 * @param {string} [toolName]
 * @param {string} [path]
 */
export function assertSchemaSubset(schema, toolName = '(unnamed)', path = 'schema') {
  if (!schema || typeof schema !== 'object') return;

  for (const key of Object.keys(schema)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    throw new Error(
      `defineTool(${toolName}): ${path}.${key} 不是 dsh-tools 支持的 schema 关键字`
      + '（子集：type/oneOf/properties/required/additionalProperties/items/enum/const + annotations）',
    );
  }

  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');

  if (hasType && hasOneOf) {
    throw new Error(`defineTool(${toolName}): ${path} 不能同时声明 type 与 oneOf`);
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(schema, key)) {
        throw new Error(`defineTool(${toolName}): ${path}.${key} 需要 type 或 oneOf`);
      }
    }
    return;
  }

  if (hasOneOf) {
    const oneOf = schema.oneOf;
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      throw new Error(`defineTool(${toolName}): ${path}.oneOf 至少要有两个分支`);
    }
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (!Object.hasOwn(schema, key)) continue;
      // ⛔ 布尔 required 是 DSL 作者层的 requiredness 标记，不进入子节点产物
      //    （真宿主 index.js:603/604 把它提到父级 required 数组）
      //    ⇒ 与 oneOf 同级是合法的，不能误报。
      if (key === 'required' && schema.required === true) continue;
      throw new Error(
        `defineTool(${toolName}): ${path}.${key} 不能与 oneOf 同级`
        + '（真宿主 json-schema.js:175，布尔 required 除外）',
      );
    }
    oneOf.forEach((branch, i) => assertSchemaSubset(branch, toolName, `${path}.oneOf[${i}]`));
    return;
  }

  // ⛔ 这一条就是 v0.20.0 事故的直接判据：type 数组一律拒。
  if (typeof schema.type !== 'string' || !SCHEMA_TYPES.includes(schema.type)) {
    const hint = Array.isArray(schema.type)
      ? '（type 数组不被支持 —— 可空请用 oneOf: [{...}, { type: \'null\' }]）'
      : '';
    throw new Error(
      `defineTool(${toolName}): ${path}.type 必须是单个类型字符串 `
      + `(${SCHEMA_TYPES.join('/')})${hint}`,
    );
  }

  if (schema.type === 'object') {
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      assertSchemaSubset(v, toolName, `${path}.properties.${k}`);
    }
  }
  if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    assertSchemaSubset(schema.items, toolName, `${path}.items`);
  }
}

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
