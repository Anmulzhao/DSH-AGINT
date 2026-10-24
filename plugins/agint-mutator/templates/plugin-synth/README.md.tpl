# {{PLUGIN_ID}}

> AGINT **TOOL_SYNTHESIS** 合成产物。骨架由 agint-mutator 提供，方法体来自 payload 的 stubs。

## 这是什么

`agint-mutator` 在归因根因 = `TOOL_GAP`（缺工具）时产出 TOOL_SYNTHESIS 变异，
合成为**完整 Cordis 插件包**，再送进
`quality-static(l0-isolation) → quality-sandbox(SMOKE) → mount` 三段式。

⛔ **stubs 会拼进 `src/index.js` 作为方法体**（2026-10-25 起，不再限制代码生成方式）。
内容引入的 import / 存储域 / 权限能否过关，**由下游 quality-static 与 quality-sandbox 真拦**。

## 意图（Intent）

{{INTENT}}

## 声明的签名（signature）

```
{{SIGNATURE}}
```

## 原始 stubs（产物方法体来源）

stubs 会被拼进 `src/index.js` 的 service 对象作为方法体。

{{STUBS}}

## L0 隔离三项（产物必须全部满足）

| 项 | 本产物取值 | 判据 |
|---|---|---|
| 签名兼容 | `{{SERVICE_KEY}}` | 落在 `agint.synth.*`，与 L0 FROZEN 签名空间无交集 |
| 域隔离 | `{{DOMAIN}}` | `agint_synth_*` 前缀的全新域 |
| 依赖白名单 | `inject = ['storageDomain']` | 零 `agint.*` host service 依赖 |

## 生成信息

| 字段 | 值 |
|---|---|
| 生成器 | `agint-mutator/templates/plugin-synth` |
| 骨架版本 | 1 |
| 代码生成方式 | `skeleton + stubs`（方法体来自 payload，不限制生成方式） |
| 工具名 | `{{TOOL_NAME}}` |
| 版本 | {{VERSION}} |
