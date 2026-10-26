import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

/**
 * 工具 output.schema 的**语义**护栏（2026-10-21 立项）。
 *
 * ## 为什么不用文本扫描
 *
 * 旧护栏 K21（`test/schema-guard.test.mjs`）用正则扫源码里的 `required: true`，
 * 前提是「`output.schema` 不经过 dsh 的值 schema 编译器」。**这个前提是错的**，
 * 源码级证据（dsh 0.2.1-rc.2，`app.asar` → `dsh-tools/lib/types/json-schema.js`）：
 *
 *   defineTool(options) {
 *     const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
 *     const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);   // ← 编译器在前
 *     ...
 *   }
 *   function valueSchemaSpecToJsonSchema(spec) {
 *     const schema = compileValueSchema(spec, "schema");
 *     assertSupportedJsonSchema(schema);                                        // ← 断言在后
 *     return schema;
 *   }
 *
 * 编译器 `runSchemaCompiler` 的 `allowRequired` 决定哪里能写 `required`：
 *   - `allowRequired: true`  → `properties.X` 这一层（**作者侧 DSL**：`required: true`）
 *   - `allowRequired: false` → output.schema 的根、`array` 的 `items`、`oneOf` 的分支
 * 也就是说：**作者侧写 `properties.X.required: true` 是对的**，
 * 编译器会把它收成父对象的 `required: ["X"]`；父对象上的 `required: [...]` 数组
 * 反而在根层是 author error。
 *
 * ## 本护栏做什么
 *
 * 直接用**宿主真正在跑的那份 dsh-tools**（0.2.1-rc.2）跑一遍每个插件的
 * `defineTool`：编译不过就抛（`authorError` / `assertSupportedJsonSchema`），
 * 抛了就是真 bug。同时再独立断言编译产物的形状（`required` 只能在父对象、
 * 名字必须在 `properties` 里），避免「编译过了但形状不对」。
 *
 * 这比文本扫描强的地方：判据来自 dsh 自己的实现，不是我们复述的规则。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');
/**
 * 扫描根：默认仓库的 `plugins/`；`K19_SCAN_ROOT` 可指向**宿主运行副本**
 * （`$DSH_HOME/profiles/<本机 profile>/plugins`），这样护栏检的是 dsh 真正加载的那份。
 * 部署位的插件文件同样 import `@deepseek-ai/dsh-tools`，解析入口在
 * `profiles/<p>/plugins/node_modules/@deepseek-ai` 与 `.agint-bundle/node_modules/@deepseek-ai`。
 */
const SCAN_ROOT = process.env.K19_SCAN_ROOT ? path.resolve(process.env.K19_SCAN_ROOT) : PLUGINS_DIR;

/** 递归找 plugins 下的 lib/tools.js。 */
function findToolFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findToolFiles(full, out);
    else if (entry.name === 'tools.js') out.push(full);
  }
  return out;
}

/** 任何属性访问都拿到一个「可调用、任意属性都是函数」的替身，避免插件在 apply 期就炸。 */
const dummy = new Proxy(function () {}, {
  get: () => dummy,
  apply: () => dummy,
  construct: () => dummy,
});

function makeCtx(registered) {
  return new Proxy(
    {
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {};
        },
      },
      logger: dummy,
    },
    {
      get: (target, prop) => (prop in target ? target[prop] : dummy),
      has: () => true,
    },
  );
}

/**
 * 断言编译后的 raw schema 形状合规。
 * 判据来自 dsh 的 `checkObjectSchemaTail` 与 `ONE_OF_SIBLING_KEYWORDS`。
 */
function assertRawSchemaShape(node, path, errors) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const isObject = node.type === 'object';
  if (Object.hasOwn(node, 'oneOf')) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) errors.push(`${path}.${key} 不能与 oneOf 同级`);
    }
    (node.oneOf || []).forEach((branch, i) => assertRawSchemaShape(branch, `${path}.oneOf[${i}]`, errors));
    return;
  }
  if (isObject) {
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string')) {
        errors.push(`${path}.required 必须是字符串数组`);
      } else {
        const declared = node.properties && typeof node.properties === 'object' ? node.properties : {};
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) errors.push(`${path}.required 里的 "${key}" 不在 properties 中`);
        }
      }
    }
    for (const [key, value] of Object.entries(node.properties || {})) {
      assertRawSchemaShape(value, `${path}.properties.${key}`, errors);
    }
  }
  if (Array.isArray(node.items)) node.items.forEach((v, i) => assertRawSchemaShape(v, `${path}.items[${i}]`, errors));
  else if (node.items) assertRawSchemaShape(node.items, `${path}.items`, errors);
}

const files = findToolFiles(SCAN_ROOT);

test('找得到插件工具文件', () => {
  assert.ok(files.length >= 20, `只找到 ${files.length} 个 tools.js（扫描根 ${SCAN_ROOT}）`);
});

test('护栏本身不是空转：作者侧写错时 dsh 编译器必须抛错', async () => {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const render = () => [{ type: 'text', text: 'x' }];
  const exec = () => ({ x: 1 });

  // ① 根层写 `required: [...]` —— 根是 allowRequired:false，author error。
  assert.throws(
    () => defineTool({
      name: 'bad_root_required',
      description: 'x',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['x'], properties: { x: { type: 'string' } } },
        render,
      },
      execute: exec,
    }),
    /required/,
    '根层 required 数组必须被拒',
  );

  // ② 属性上写 `required: ['x']`（数组）—— 必须是 `true`。
  assert.throws(
    () => defineTool({
      name: 'bad_prop_required',
      description: 'x',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { x: { type: 'string', required: ['x'] } } },
        render,
      },
      execute: exec,
    }),
    /required/,
    '属性上的 required 数组必须被拒',
  );

  // ③ oneOf 分支里带 required —— 分支是 allowRequired:false。
  assert.throws(
    () => defineTool({
      name: 'bad_oneof_required',
      description: 'x',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { oneOf: [{ type: 'string', required: true }, { type: 'null' }] } },
        },
        render,
      },
      execute: exec,
    }),
    /required/,
    'oneOf 分支里的 required 必须被拒',
  );

  // ④ 合法的作者侧形态（属性上 `required: true`）必须通过。
  const ok = defineTool({
    name: 'good_author_form',
    description: 'x',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'string', required: true },
          y: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render,
    },
    execute: exec,
  });
  assert.deepEqual(ok.output.schema.required, ['x'], '作者侧 required:true 应编译成父级 required 数组');
  assert.equal(ok.output.schema.properties.y.required, undefined, 'oneOf 属性不应带 required');
});

for (const file of files) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  test(`工具 output.schema 能过 dsh 编译器：${rel}`, async () => {    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.apply !== 'function') {
      // 个别文件导出的是别的入口（如 agint-mascot 的 registerMascotTools），本护栏不覆盖。
      return;
    }
    const registered = [];
    await mod.apply(makeCtx(registered));
    assert.ok(registered.length > 0, `${rel} 没有注册任何工具`);
    for (const tool of registered) {
      const errors = [];
      assertRawSchemaShape(tool.output?.schema, `${rel}:${tool.name}`, errors);
      assert.deepEqual(errors, [], errors.join('; '));
    }
  });
}
