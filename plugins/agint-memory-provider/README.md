# agint-memory-provider

P1-1 可插拔记忆 Provider 架构（阶段 1 基础抽象层 + 阶段 2 降级与检查点 + **阶段 3 定期健康检查 / 开发指南 / 示例 provider**）。把 AGINT 的记忆系统从「硬编码内置」升级为「可插拔 Provider 架构」：定义统一的 `ExternalProvider` 抽象基类，把现有 `agint-memory` 封装为始终可用的 `builtin` provider，外部 provider（Honcho/Hindsight/Mem0/Zep 等）可激活并自动降级。

设计稿：`wiki/设计-P1-1-可插拔记忆Provider架构.md`（v0.1-draft，作者：智进）。
外部 provider 开发指南：`docs/plugins/agint-memory-provider.md`；可运行示例：`examples/file-provider.js`。

## 当前能力

**阶段 1 + 2：**

- **ExternalProvider 抽象基类**（`lib/provider.js`）：完整生命周期接口（initialize → prefetch → syncTurn → shutdown）+ 可选 hooks（onTurnStart / onSessionEnd / onSessionSwitch / onPreCompress / onDelegation / onMemoryWrite）+ 实现完整性校验（`validateProvider`，同一性比较识破「继承 stub 却声称已实现」）。
- **BuiltinProvider**（`lib/builtin-provider.js`）：封装 `agint.memory` 服务，不重开 `agint` 域（进程内独占）、prefetch 默认只读不写回（不改 decay.js 衰减输入）→ 行为与现有 agint-memory 完全一致（§12.1 验收标准）。
- **MemoryManager**（`lib/manager.js`）：provider 选择/激活/降级（激活失败自动回 builtin）、生命周期调度、琐碎输入过滤、确定性召回指示器（RecallStatus）、pause/resume 内存态开关。
- **ProviderRegistry**（`lib/registry.js`）：注册即校验实现完整性；`builtin` 为保留名（§9.1 L0 护栏）；单外部 provider 限制由激活逻辑保证。
- **琐碎输入过滤**（`lib/trivial.js`）：中英文词表 + 锚定正则（「好的」「继续」「谢谢」跳过召回，「k8s」「好的呀我们开始」不误判）。
- **存储域 `agint_memory_provider`**（`lib/storage.js`）：6 表（provider_config / activation_log / fallback_events / pre_compress_checkpoints / audit_log / **health_checks**），上限与滚动清理按设计稿 §4。
- **preset 工具**（`lib/tools.js`）：`memory_provider_list` / `memory_provider_status`（read-only 裸调）、`memory_provider_activate` / `memory_provider_deactivate`（write，ask 门禁）。

**阶段 3（2026-10-01）：**

- **定期健康检查**（`manager.runHealthCheck()`）：cron 与手动工具共用同一实现，逐条落 `health_checks` 表；连续未通过达阈值**只告警不自动切换**（§9.3）。
- **诚实探活**：只有 provider 实现 `healthCheck()` hook 才做真实探活，记录里 `networkProbed` 如实标注（默认 false）。
- **新工具**：`memory_provider_health_check` / `memory_provider_health` / `memory_provider_pause` / `memory_provider_resume`。
- **示例 provider**：`examples/file-provider.js`（本地 JSONL，装上就能激活跑通全链路）。
- **开发指南**：`docs/plugins/agint-memory-provider.md`。
- **事件**（软依赖 agint-event-bus，不可用降级为仅写 audit_log）：`memory.provider-activated` / `memory.provider-activation-failed` / `memory.recall-injected`。

## Service：`agint.memoryProvider`

| 方法 | 说明 | 状态 |
|---|---|---|
| `listProviders()` | 列出所有已注册 provider 及可用性快照 | ✅ |
| `getActiveProvider()` | 当前激活的 provider + 召回状态 + 最近激活结果 | ✅ |
| `activate(name, opts)` | 激活指定 provider（isAvailable → initialize → 失败降级 builtin） | ✅ |
| `deactivate(opts)` | 停用外部 provider，回 builtin（先 shutdown 旧 provider） | ✅ |
| `getConfig(name)` / `setConfig(name, values)` | provider 配置读写；secrets 只收 env var 名（§9.1 L2） | ✅ |
| `getRecallStatus()` | 最近一次召回状态（确定性指示器） | ✅ |
| `getFallbackStats()` | 降级统计（近 7 天聚合 + 当前降级态） | ✅ |
| `runHealthCheck(opts)` | 跑一次健康检查并落 `health_checks`（cron / 工具共用） | ✅ 阶段 3 |
| `getHealthHistory(opts)` | 最近巡检记录（倒序，硬上限 200 条） | ✅ 阶段 3 |
| `pause(actor)` / `resume(actor)` | 暂停/恢复记忆召回（内存态，重启还原） | ✅ |
| `start` / `beginTurn` / `endTurn` | 会话/对话循环入口（供 preset 或 dsh 集成层调用） | ✅ |
| `onSessionSwitch` / `onSessionEnd` / `shutdown` | 会话边界 hook | ✅ |
| `registerProvider(provider)` | 注册外部 provider 实例（Sprint 17/18 插件扫描前的显式通道） | ✅ |
| `stats()` | 全状态快照（表计数/上限/配置） | ✅ |
| `config(patch?)` | 运行时配置读/改（只接受 §8.2 子集；active_provider 必须走 activate） | ✅ |
| `testConnection` / `runPreCompressCheckpoint` / `registerProviderTools` / `routeToolCall` | 阶段 2 交付 | ✅ |

## preset 工具（阶段 3：10 只读裸调 + 4 写 ask）

| 工具 | 门禁 | 说明 |
|---|---|---|
| `memory_provider_list` | read-only，裸调 | 列出所有已注册 provider 及其状态 |
| `memory_provider_status` | read-only，裸调 | 当前激活 provider + 召回状态 + 最近激活结果 |
| `memory_provider_activate` | write，ask | 激活指定 provider（失败自动降级 builtin） |
| `memory_provider_deactivate` | write，ask | 停用外部 provider 回 builtin |
| `memory_provider_test` | read-only | 配置/凭证级可用性校验（不做网络探活） |
| `memory_provider_config_get` | read-only | 读 provider 配置（敏感项只回 env var 名） |
| `memory_provider_config_set` | write，ask | 写 provider 配置（secrets 只收 env var 名） |
| `memory_provider_fallback_stats` | read-only | 近 7 天降级统计 + 当前降级态 |
| `memory_provider_health_check` | read-only | 手动跑一次健康检查（不改激活态/配置） |
| `memory_provider_health` | read-only | 巡检历史 + 每个 provider 最近一次 + 连续未通过 |
| `memory_provider_pause` | write，ask | 暂停召回（内存态，重启还原） |
| `memory_provider_resume` | write，ask | 恢复召回 |

**注意**：现有记忆工具（`memory_write` / `memory_search` / `memory_read` / `memory_stats` / `memory_forget_scan`）**不在此注册**——按 §14.1 决策 B，它们继续由 `agint-memory` 的 preset 平面提供，行为完全不变。`BuiltinProvider.getToolSchemas()` 返回 `[]` 即此意的显式声明。

## 存储域与上限

`agint_memory_provider`（与 `agint` / `agint_evolution` 等互斥）：

| 表 | 上限 | 超限策略 |
|---|---|---|
| provider_config | 20 | warn（不自动 prune） |
| activation_log | 1000 | 滚动清理最旧 |
| fallback_events | 5000 | 滚动清理最旧（Sprint 16 写入） |
| pre_compress_checkpoints | 500 | warn（Sprint 16 写入） |
| audit_log | 1000 | 滚动清理最旧 |
| health_checks | 2000 | 滚动清理最旧（阶段 3 写入） |

## 安全护栏（设计稿 §9.1）

- **L0**：builtin 始终可用（`builtin` 保留名不可被外部 provider 顶替）；单外部 provider 限制。
- **L1**：激活失败自动降级 builtin，不中断对话；prefetch 失败本轮空上下文不抛错。
- **L2**：secrets 只存 env var 名，疑似凭证字面量拒绝；日志不落敏感数据（prefetch 失败只记 `prefetch failed`）。
- **L3**：activate/deactivate 为 write 操作，preset 平面配 ask 门禁。
- **L4**：激活/停用/配置修改全流程写 audit_log。
- **§9.3 自我评估禁止**：管理器不自动切换 provider、不自动改配置（唯一自动降级是「激活失败 → builtin」护栏兜底）。

## 阶段 3 之后的接力（未做）

- 与 `agint-metrics` 集成（召回次数 / 降级次数 / 同步成功率 / 平均召回耗时）。
- 与 `agint-evolution-memory` 集成（provider 使用历史）。
- 配置管理向导（`.env` 集成的完整 setup 流程）。
- 第一个**真实**外部 provider（设计稿 M4，如 Honcho）——FileProvider 只是示例，
  不是生产后端。

## 测试

```bash
node --test test/smoke.mjs   # 95 PASS（导出契约 / schema / storage / provider 校验 /
                             # registry / trivial / builtin / manager / mock /
                             # 阶段 3 健康检查 5 组 / 示例 FileProvider 全链路）
```

## 挂载

Loader row（顶层 `cordis.patch.yml`，走 safe-update SOP）：

```yaml
- id: agint-memory-provider
  name: ./plugins/agint-memory-provider/lib/index.js
  config: {}
```

preset 工具行（`presets/agint/agent.cordis.yml`）：

```yaml
- id: agint-memory-provider-tools
  name: ../../profiles/web/plugins/agint-memory-provider/lib/tools.js
```
