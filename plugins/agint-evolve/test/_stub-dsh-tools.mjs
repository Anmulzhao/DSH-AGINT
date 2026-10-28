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
// ⛔ 2026-10-28 修订：defineTool 的替身原先是 `return { ...options }` —— 原样透传。
//   那不是契约等价，是**比真宿主宽松**：真 dsh-tools 只读 `options.execute`
//   （dsh-tools/lib/index.js:839 `const userExecute = options.execute;`，
//   :869 `return userExecute(args, exec);`），并把结果包成一个 `tool.execute`。
//   于是插件把入口写成 `handler` 时：
//     · 替身下 → 返回对象里带着 `handler`，测试怎么调都「正常」；
//     · 真宿主 → `tool.execute` 内部调 `userExecute` 是 undefined，
//                抛 `TypeError: userExecute is not a function`。
//   后果实测：agint-upstream-watch v0.1.0→v0.3.0 连续三个版本带着这个缺陷上线，
//   而本仓测试全绿。**替身比真宿主宽松 ⇒ 它的「全绿」没有判据价值。**
//   ⇒ 现在替身按真契约收窄：只认 `options.execute`，缺了就跟真宿主一样抛；
//     output.render 同理（真宿主 :842 `const userRender = options.output.render;`，
//     :858 `return userRender(args, value);`）。
//   （与 plugins/agint-upstream-watch/test/_stub-storage-domain.mjs 那份逐条对齐，
//     便于后续抽成一份共用替身。）

export function defineTool(options) {
  if (!options || typeof options.name !== 'string') {
    throw new Error('defineTool: options.name must be a string');
  }
  const userExecute = options.execute;
  const userRender = options.output?.render;
  const tool = {
    name: options.name,
    description: options.description,
    parameters: options.parameters ?? {},
    output: {
      schema: options.output?.schema,
      // 与真 dsh-tools 一致：render 只从 options.output.render 取
      // （dsh-tools/lib/index.js:842 / :858）。
      // 真宿主是**先校验 schema、再调 render** ⇒ 只写 schema 不写 render，
      // 缺陷会晚到真调那一刻才炸（2026-10-28 v0.3.0 现场：
      // `output.render failed: userRender is not a function`）。
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
  // （dsh-tools/lib/index.js:603 authorError）。替身同样拒收，别让插件踩坑。
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
