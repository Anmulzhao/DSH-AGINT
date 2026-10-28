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
//   - defineTool(desc)   **收窄到与真 dsh-tools 同紧**（见下）
//
// ⛔ 2026-10-28 修订：defineTool 的替身原先是 `return { ...desc }` —— 原样透传。
//   这不是契约等价，是**比真宿主宽松**：真 dsh-tools 只读 `options.execute`
//   （dsh-tools/lib/index.js:839 `const userExecute = options.execute;`，
//   :869 `return userExecute(args, exec);`），把结果包成一个 `tool.execute`。
//   于是插件把入口写成 `handler` 时：
//     · 替身下 → 返回对象里带着 `handler`，测试怎么调都"正常"；
//     · 真宿主 → `tool.execute` 内部调 `userExecute` 是 undefined，
//                抛 `TypeError: userExecute is not a function`。
//   后果实测：agint-upstream-watch v0.1.0→v0.3.0 连续三个版本带着这个缺陷上线，
//   而本仓 73 条测试全绿。**替身比真宿主宽松 ⇒ 它的"全绿"没有判据价值。**
//   ⇒ 现在替身按真契约收窄：只认 `options.execute`，缺了就跟真宿主一样抛。

export function defineDomain(spec) {
  if (!spec || typeof spec.name !== 'string') {
    throw new Error('defineDomain: spec.name must be a string');
  }
  return { ...spec };
}

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
      // 与真 dsh-tools 一致：render 只从 options.output.render 取
      // （dsh-tools/lib/index.js:846 `const userRender = options.output.render;`，
      //  :856 `render(args, value) { return userRender(args, value); }`）。
      // 真宿主是**先校验 schema、再调 render** ⇒ 只写 schema 不写 render，
      // 缺陷会晚到真调那一刻才炸（2026-10-28 v0.3.0 的第二个现场：
      // `tool "upstream_status" returned invalid output: output.render failed: userRender is not a function`）。
      render(args, value) {
        if (typeof userRender !== 'function') {
          throw new TypeError('userRender is not a function');
        }
        return userRender(args, value);
      },
    },
    // 与真 dsh-tools 一致：入口只从 options.execute 取。
    // 少了它 ⇒ 调用即抛 TypeError: userExecute is not a function（真宿主的原话）。
    async execute(args, exec) {
      if (typeof userExecute !== 'function') {
        throw new TypeError('userExecute is not a function');
      }
      return userExecute(args, exec);
    },
  };
  // 真 dsh-tools 的值 schema DSL：`required` 只要出现就必须是 true
  // （dsh-tools/lib/index.js:602 authorError）。替身同样拒收，别让插件踩坑。
  assertRequiredTrue(tool.output?.schema, tool.name);
  return tool;
}

function assertRequiredTrue(schema, toolName, path = '') {
  if (!schema || typeof schema !== 'object') return;
  if (Object.hasOwn(schema, 'required') && schema.required !== true) {
    throw new Error(
      `defineTool(${toolName}): schema${path ? '.' + path : ''}.required 只能是 true（dsh-tools authorError）`,
    );
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    assertRequiredTrue(v, toolName, path ? `${path}.${k}` : k);
  }
  if (schema.items && typeof schema.items === 'object') {
    assertRequiredTrue(schema.items, toolName, `${path}[]`);
  }
}
