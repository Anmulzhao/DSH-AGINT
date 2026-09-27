# agint-ov-strategy

AGINT × OpenViking **策略层**（v0.1.0）。设计稿：`proposals/agint-ov-strategy.md`。

## 一句话

官方 `@openviking/dsh-memory-plugin` bundle 已做「传输 + 生命周期」（捕获/提交/队列/drainer），
本插件是 AGINT 侧**唯一**消费它的缝：**经验沉淀写入 + 按域过滤 + 策略侧召回**。

## 四条硬规则

| 规则 | 含义 |
|---|---|
| R1 单缝原则 | 全仓只许本插件 `ctx.get('openvikingMemory')`；其他插件只消费 `agint.ovStrategy` |
| R2 正本与投影 | 不持有 storageDomain；数据先落生产者自己的域，本插件只 write-through |
| R3 召回是增益不是依赖 | 所有接口软失败（返回 `{ok:false, reason}`），绝不抛；OV 挂了 AGINT 照常跑 |
| R4 不重建传输 | 不直连 OV REST、不自建队列；一切经 `runtime.client` + 官方 pending/drainer |

红线（绝不触碰）：`runtime.capture()`（双写）、`mcp__openviking__remember`（不 session-scoped）、
ExternalProvider 插槽（§10.7 已拍板不接）。

## Service：`ctx.get('agint.ovStrategy')`

```js
const ov = ctx.get('agint.ovStrategy');

// 经验沉淀：投影一条记忆进 OV（scope 白名单：dream/diagnosis/evolution/manual）
await ov.remember({ scope: 'evolution', text: '跨域迁移结论：……', traceId: 'evo-123' });
// → { ok: true, ovSessionId: 'dsh-agint-evolution-evo-123' }（软失败时 { ok:false, reason }）

// 策略侧召回：不经过 pre-step 的显式查询
await ov.recall('上次 mount 失败的根因是什么');
// → { ok: true, entries: [...] } 或 { ok: false, reason }（消费方必须能处理后者）

// 健康
ov.status(); // { enabled, runtimeAvailable, scopes, autoTopics, counters, disposed }
```

## 自动沉淀（总线订阅，零侵入 dream/diagnosis）

订阅 `dream.completed`（仅 `countPromoted > 0` 时记）与 `diagnosis.completed`（恒记），
payload → 摘要文本 → `remember()`。async 模式订阅，不占全系统 sync ≤3 配额。
总线不可用 → 静默降级，手动 remember 不受影响。

## 配置与开关

| 项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | kill-switch；env `AGINT_OV_STRATEGY=off` 总闸（**出厂即开**，K51） |
| `scopes` | `['dream','diagnosis','evolution','manual']` | scope 白名单 |
| `autoTopics` | `['dream.completed','diagnosis.completed']` | 自动沉淀订阅 |
| `minTextLength` / `maxTextLength` | 20 / 4000 | 噪声过滤 |
| `peerCwd` | `null`（= process.cwd()） | 伪会话 cwd；dsh 启动目录漂移时钉死（peer 解析依赖 `D:/DSH/.openviking/config.json`） |

注意：官方全局 `syncTurns:false` 会同时停掉 teardown commit（本插件尊重它，不自建第二套写开关语义）。

## 已知限制

见设计稿 §6：提交依赖 capture 开关、检索闭环待 OV embedding 队列恢复（K112）、
订阅为精确匹配（总线无 wildcard）。

## 测试

```bash
node test/smoke.mjs   # 软降级 / kill-switch / 写入链 / 过滤 / 订阅 / 卸载
```
