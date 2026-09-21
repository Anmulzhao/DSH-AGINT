# dsh tool schema 方言速查（权威版）

> **本文是 K19 / K21 的单一事实源。** 别处引用 K19/K21 时以本文为准。
> 2026-09-21 事故（commit `b03d919` 引入、`7a81f71` 修复）的直接原因就是
> "K21" 被记成了 raw JSON Schema 形式 —— 而 output.schema 的作者侧**根本不是** raw。

## 一、两套方言，别混

dsh 的 schema **不是"一种方言两处用"**，而是**两条独立通道，要求正好相反**。
用错通道 = 挂载失败或校验失效。**先判断你的 schema 喂给谁。**

### ⭐⭐ 先判通道（2026-09-21 实测，这是最容易错的一步）

| 通道 | 代码入口 | 校验器 | `required` 形态 | 典型位置 |
|---|---|---|---|---|
| **A. 工具 schema** | `defineTool({ parameters, output })` | `valueSchemaSpecToJsonSchema` | **属性布尔** `required: true` | `plugins/*/lib/tools.js` |
| **B. 结构化输出** | `ctx.subagents.start({ outputSchema })`<br>`ctx.agents.create({ outputSchema })` | `assertObjectJsonSchema` | **父对象数组** `required: ['a','b']` | `agint-dream/lib/consolidation.js` |

实测对照（同一份 schema 喂两条通道）：

```
--- 通道 A：工具 schema (valueSchemaSpecToJsonSchema) ---
  数组形态: FAIL — schema.required is not supported by the value schema DSL
  布尔形态: PASS
--- 通道 B：结构化输出 (assertObjectJsonSchema) ---
  数组形态: PASS
  布尔形态: FAIL — schema.properties.a.required is not supported on type "string"
```

**⚠️ 所以「统一写法」是错误动作。** 改 schema 前**必须先确认它走哪条通道**，
否则会把本来正确的 B 通道 schema "修坏"。

判通道的可靠办法：grep 这个 schema 常量**被谁消费**：
```bash
grep -rn "MY_SCHEMA_NAME" plugins/<name>/lib/
# → 传给了 defineTool 的 output.schema → 通道 A
# → 传给了 subagents.start / agents.create 的 outputSchema → 通道 B
```

### 通道 A 的两套子方言（不要和上面混淆）

通道 A 内部**自己也有两道**：作者侧（值 schema DSL）与产物侧（raw JSON Schema）。
见下节。

### 对照表

| | **值 schema DSL**（作者侧） | **raw JSON Schema**（产物侧） |
|---|---|---|
| `required` 形态 | **属性上的布尔** `required: true` | **父对象上的字符串数组** `required: ['a','b']` |
| 用在 `parameters` | ✅ 这是唯一入口 | ❌ |
| 用在 `output.schema`（通道 A） | ✅ **作者写这个** | ⚠️ 只是编译器**输出**，不手写 |
| 谁实现 | `dsh-tools/lib/index.js` `compile*Schema` | `dsh-tools/lib/types/json-schema.js` |

**通道 A（工具 schema）的关键：`output.schema` 的作者侧也必须写"值 schema DSL"形态。**

## 二、output.schema 的真实链路（两道串联）

```
output: {
  schema: { ...你写的... }
}
   │
   ├─① compileValueSchema(spec, "schema")      ← 值 schema DSL 编译器（index.js:772）
   │      校验你写的原文。`required` 只认属性上的布尔 true（index.js:603）；
   │      写在非 object 值节点上 → index.js:556 assertAuthorKeys 拒绝。
   │
   └─② assertSupportedJsonSchema(compiled)     ← raw 断言（types/json-schema.js）
          校验的是 ① 的**输出**，不是你的原文。
```

`parameters` 是单道：`parameterSchemaSpecToJsonSchema(spec)` → 直接编译属性表。

### 为什么老记反

`assertSupportedJsonSchema` 的文档与源码明明白白写着 "`required` is an array of
property names"，看着就是权威 —— 但它管的是**产物**。把产物规则套到作者侧，
就会写出 `required: ['a','b']`，然后被 ① 拦下：

```
unsupported JSON schema: schema.required is not supported by the value schema DSL
```

这个错误会让整个 loader entry 挂载失败 → **整个 preset 起不来**。

## 三、K19：object 节点必须显式声明 additionalProperties

`type: 'object'` 节点**必须**带 `additionalProperties: true | false`，
缺了会 `authorError`：

```js
// ❌
items: { type: 'object', properties: { ... } }
// ✅
items: { type: 'object', additionalProperties: false, properties: { ... } }
```

## 四、K21：必填的写法（修正版）

```js
// ❌ 错：父对象数组 —— 被 ① 拒绝
output: {
  schema: {
    type: 'object', additionalProperties: false,
    required: ['path', 'bytes'],
    properties: {
      path: { type: 'string' },
      bytes: { type: 'integer' },
    },
  },
}

// ✅ 对：必填挂在属性上
output: {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      path: { required: true, type: 'string' },
      bytes: { required: true, type: 'integer' },
    },
  },
}
```

`parameters` 同理（本来就是对的形式，别改）：

```js
parameters: {
  query: { required: true, type: 'string', description: '...' },
  limit: { type: 'integer', description: '...' },   // 可选：别写 required: false
}
```

### 硬约束与代价

- **`required` 只要出现就必须是 `true`** —— `required: false` 会被 `authorError`
  （index.js:603）。可选参数**什么都不写**。
- **属性节点带 `oneOf` 时不能带 `required`** —— 两者互斥。
  → 这类"可空字段"在**本 DSL 下无法表达必填**，只能放弃必填（校验略松）。
  2026-09-21 修复中共 31 处属此类，已如实记账。
- `type` 只能是单个字符串；`type` 与 `oneOf` 不能共存。

## 五、护栏

```bash
node bin/check-tool-schemas.mjs
# → scanned 24 file(s), compiled 109 schema literal(s), 0 invalid.
```

它加载**宿主真实的** `valueSchemaSpecToJsonSchema` 对全部 `plugins/**/tools.js`
的 schema 字面量真编译一遍。阴性对照已验证有效（喂入坏版本 → exit 1 + 精确行号）。

**改任何 tool schema 后必跑。** 这是把"看起来对"变成"宿主编译器认"的唯一低成本手段。

## 六、教训（写给未来的我）

`b03d919` 的 commit message 里那条"验收"是：

> 仓库改动与宿主部署位逐文件 `cmp` 全部一致 → 确认改动已在生产生效

**这条验收是假的。** 文件一致只证明「改了、部署了」，不证明「部署的版本合法」。
当时若对宿主那份字节跑一次 `apply()`，40 个工具全部注册失败会立刻暴露 ——
但他们只对了文件哈希，于是 10 个插件带着"已验收"的标签挂了一天，直到 dsh 再也起不来。

**规则：改 schema / 改契约类代码，"与部署位一致"不算验收；必须真编译或真导入。**
