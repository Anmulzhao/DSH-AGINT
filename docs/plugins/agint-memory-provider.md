# agint-memory-provider

> P1-1：可插拔记忆 Provider 架构。把「记忆怎么存」从 AGINT 内核里剥离成可插拔 provider，
> 内置 `builtin` 恒可用，外部 provider（Honcho / Hindsight / Mem0 / Zep …）可激活并自动降级。
>
> 设计稿：`DSH-AGINT.wiki/设计-P1-1-可插拔记忆Provider架构.md`
> 插件 README：`plugins/agint-memory-provider/README.md`
> 示例 provider：`plugins/agint-memory-provider/examples/file-provider.js`

## 职责边界

- ✅ 管**记忆的组织方式**：provider 抽象、激活/降级、压缩检查点、召回指示器、进化记忆接口
- ✅ 管**外部 provider 的接入契约与安全约束**
- ❌ 不做记忆存储后端本身（那是 provider 的事；dsh 官方「个性化长期记忆」GA 后，
  按 Wiki 路线图「融合采用 · dsh 官方路线」的 **S1** 作为一个 provider 接入）
- ❌ 不改 `agint-memory` 的实现（BuiltinProvider 只做封装，行为与原有完全一致）

## 三阶段交付状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段 1（Sprint 15） | 抽象层 + BuiltinProvider + MemoryManager + Registry + 琐碎过滤 | ✅ |
| 阶段 2（Sprint 16） | 运行时降级 + pre_compress fail-closed 检查点 + provider 工具动态注册 | ✅ |
| **阶段 3（2026-10-01）** | **定期健康检查 + 外部 provider 开发指南 + 示例 provider** | ✅ |

---

# 外部 Provider 开发指南

> 面向要在 AGINT 上接入一个新记忆后端的人。**照着 `examples/file-provider.js` 抄即可**，
> 那是实现了全部可选 hook 的活样例（本地 JSONL 存储，不依赖任何外部服务，装上就能跑）。

## 0. 三步跑起来

```js
import { ExternalProvider } from 'agint-memory-provider/lib/provider.js';

class MyProvider extends ExternalProvider {
  get name() { return 'my'; }
  isAvailable() { return Boolean(process.env.MY_API_KEY); }
  async initialize(sessionId, kwargs) { /* 建连、准备会话线程 */ }
  getToolSchemas() { return []; }          // 没有工具就返回 []（显式声明，不是忘了实现）
}

// 注册（注册即校验，不合格当场拒绝并给理由）
const svc = ctx.get('agint.memoryProvider');
const r = svc.registerProvider(new MyProvider());
// → { registered, name, reason, missing, errors, recommendedOverrides }

// 激活（write 操作，走 ask 门禁）
await svc.activate('my', { actor: 'human', reason: '试用 MyProvider' });
```

## 1. 接口契约

继承 `ExternalProvider`（`lib/provider.js`）。方法分三类：

### 必须实现（缺一个就注册失败）

| 方法 | 契约 |
|---|---|
| `get name()` | 非空字符串短标识。`builtin` 是**保留名**，外部 provider 用了会被拒（§9.1 L0） |
| `isAvailable()` | **同步**、**不得发网络请求**（§9.2 约束 6），只判配置/凭证是否齐备 |
| `initialize(sessionId, kwargs)` | 建连、准备资源。失败会被 MemoryManager 捕获并降级到 builtin |
| `getToolSchemas()` | 返回 OpenAI function-calling 形态的数组；**没有工具返回 `[]`** |

> 校验用「与基类 stub 的同一性比较」：`function isAvailable() {}` 但内部没实现也算没实现
> ——继承基类抛错 stub 却照样注册，这条路被堵死。

### 建议实现（缺失不阻断注册，只在报告里提示）

`prefetch`（召回）/ `syncTurn`（后台写入）/ `shutdown`（清理）/ `recallStatus`（召回指示器）。

### 可选 hook（override 才生效）

`unavailableReason` / `systemPromptBlock` / `queuePrefetch` / `onTurnStart` /
`onSessionEnd` / `onSessionSwitch` / `onPreCompress` / `onDelegation` / `onMemoryWrite` /
`getConfigSchema` / `saveConfig` / `backupPaths`。

### 阶段 3 新增：`healthCheck()`

```js
async healthCheck() {
  // 唯一允许做真实 I/O 探活的地方。返回 false / { ok:false, reason } 都算不健康。
  // 超时上限 health_check_probe_timeout_ms（默认 5000ms）。
  return { ok: true, reason: '目录可读写', details: { lines: 42 } };
}
```

- **没实现 `healthCheck()` 就等于没探活**。健康检查仍会跑，但只做配置/凭证级校验，
  记录里 `networkProbed: false` —— 不假装探过（真实 > 讨好）。
- 实现了才置 `networkProbed: true`，`memory_provider_health` 里能一眼看出哪条是真探活。

## 2. 工具暴露

- 返回 **OpenAI 格式**：`{ type:'object', properties:{…}, required:[…] }`；
  `type:'object'` 必须显式带 `additionalProperties`（K19，否则 dsh 严格模式拒收）。
- 工具名统一加前缀（配置 `external_tool_prefix`），撞下列保留名会**跳过注册**：
  `memory_write / memory_search / memory_read / memory_stats / memory_forget_scan`
  与全部 `memory_provider_*`。
- `handleToolCall(name, args)` 处理调用；**未声明的工具必须显式抛错**，不得静默吞掉。

## 3. 配置与密钥

- 非敏感配置走 `getConfigSchema()` + `saveConfig(values, dshHome)`，由 `memory_provider_config_set` 写入。
- **敏感值只收 env var 名**（如 `{ apiKeyEnv: 'MY_API_KEY' }`）。传实际凭证会被直接拒绝
  （长度 >64、含 `=`/`/` 组合、`sk-`/`pk-`/`api-` 前缀都判为疑似凭证，不落库）。
- `backupPaths()` 声明 DSH_HOME 之外的备份路径，供备份工具收录。

## 4. 安全约束（硬性）

| 约束 | 说明 |
|---|---|
| L0 | `builtin` 恒可用，不可被顶替；一次只激活一个外部 provider |
| L1 | 调用失败一律降级到 builtin，对话不中断；召回超时不阻塞 |
| L2 | 日志与存储**不落凭证**；`log_sensitive_data` 默认 false |
| L3 | provider 切换是 write 操作，必须走 ask 人工确认 |
| — | provider 只能通过接口交互，**不得直连 AGINT 存储域、不得改其他插件状态** |
| §9.3 | **系统绝不自动切换 provider**：连续健康检查失败只告警（事件 + audit_log） |

## 5. 健康检查怎么接

- 定期：cron `memory-provider-health`（daily 08:30）自动跑全量巡检，落 `health_checks` 表。
- 手动：`memory_provider_health_check`（不改激活态与配置）触发一次。
- 查看：`memory_provider_health`（历史 + 每个 provider 最近一次结果 + 连续未通过次数）。
- 连续未通过达 `health_check_fail_threshold`（默认 3）→ 发一次 `memory.provider-unhealthy`
  事件 + 一条 audit_log。**仅此而已，不自动切换**（切不切人说了算）。

### `health_checks` 表（§4.7）

| 字段 | 说明 |
|---|---|
| `providerName` / `timestamp` / `trigger` | 谁、何时、谁发起（`cron` / `tool` / `startup`） |
| `result` | `healthy` / `unhealthy` / `skipped` / `error` |
| `networkProbed` | 是否做了真实探活（见上文 `healthCheck()`） |
| `durationMs` / `reason` / `consecutiveFailures` | 耗时、原因（截断 500 字）、连续未通过次数 |
| `activeProvider` / `sessionId` | 巡检当时的上下文 |

上限 2000 条，超限滚动清理最旧的。

## 6. 排障速查

| 现象 | 先看 |
|---|---|
| 「记忆为什么没召回」 | `memory_provider_status`（initialized / paused / recall / lastActivation） |
| 「是不是早就悄悄不可用了」 | `memory_provider_health`（历史 + 连续未通过次数） |
| 「最近老降级」 | `memory_provider_fallback_stats`（近 7 天按操作/错误类型分布） |
| 「provider 为什么注册不上」 | `registerProvider` 返回的 `missing` / `errors` / `recommendedOverrides` |
| 「配置有没有生效」 | `memory_provider_config_get`（只回 env var 名，不回凭证） |
