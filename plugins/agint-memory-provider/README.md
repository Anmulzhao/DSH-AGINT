# agint-memory-provider

P1-1 可插拔记忆 Provider 架构（Sprint 15 基础抽象层）。把 AGINT 的记忆系统从「硬编码内置」升级为「可插拔 Provider 架构」：定义统一的 `ExternalProvider` 抽象基类，把现有 `agint-memory` 封装为始终可用的 `builtin` provider，外部 provider（Honcho/Hindsight/Mem0/Zep 等）可激活并自动降级。

设计稿：`wiki/设计-P1-1-可插拔记忆Provider架构.md`（v0.1-draft，作者：智进）。

## 当前能力（Sprint 15 基础抽象层）

- **ExternalProvider 抽象基类**（`lib/provider.js`）：完整生命周期接口（initialize → prefetch → syncTurn → shutdown）+ 可选 hooks（onTurnStart / onSessionEnd / onSessionSwitch / onPreCompress / onDelegation / onMemoryWrite）+ 实现完整性校验（`validateProvider`，同一性比较识破「继承 stub 却声称已实现」）。
- **BuiltinProvider**（`lib/builtin-provider.js`）：封装 `agint.memory` 服务，不重开 `agint` 域（进程内独占）、prefetch 默认只读不写回（不改 decay.js 衰减输入）→ 行为与现有 agint-memory 完全一致（§12.1 验收标准）。
- **MemoryManager**（`lib/manager.js`）：provider 选择/激活/降级（激活失败自动回 builtin）、生命周期调度、琐碎输入过滤、确定性召回指示器（RecallStatus）、pause/resume 内存态开关。
- **ProviderRegistry**（`lib/registry.js`）：注册即校验实现完整性；`builtin` 为保留名（§9.1 L0 护栏）；单外部 provider 限制由激活逻辑保证。
- **琐碎输入过滤**（`lib/trivial.js`）：中英文词表 + 锚定正则（「好的」「继续」「谢谢」跳过召回，「k8s」「好的呀我们开始」不误判）。
- **存储域 `agint_memory_provider`**（`lib/storage.js`）：5 表（provider_config / activation_log / fallback_events / pre_compress_checkpoints / audit_log），上限与滚动清理按设计稿 §4。
- **preset 工具**（`lib/tools.js`）：`memory_provider_list` / `memory_provider_status`（read-only 裸调）、`memory_provider_activate` / `memory_provider_deactivate`（write，ask 门禁）。
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
| `getFallbackStats()` | 降级统计（Sprint 16 才有数据，现返回空态 + 说明） | ✅ |
| `pause(actor)` / `resume(actor)` | 暂停/恢复记忆召回（内存态，重启还原） | ✅ |
| `start` / `beginTurn` / `endTurn` | 会话/对话循环入口（供 preset 或 dsh 集成层调用） | ✅ |
| `onSessionSwitch` / `onSessionEnd` / `shutdown` | 会话边界 hook | ✅ |
| `registerProvider(provider)` | 注册外部 provider 实例（Sprint 17/18 插件扫描前的显式通道） | ✅ |
| `stats()` | 全状态快照（表计数/上限/配置） | ✅ |
| `config(patch?)` | 运行时配置读/改（只接受 §8.2 子集；active_provider 必须走 activate） | ✅ |
| `testConnection` / `runPreCompressCheckpoint` / `registerProviderTools` / `routeToolCall` | Sprint 16 交付，显式抛「未实现」，绝不静默 | Sprint 16 |

## preset 工具（Sprint 15：2 只读裸调 + 2 写 ask）

| 工具 | 门禁 | 说明 |
|---|---|---|
| `memory_provider_list` | read-only，裸调 | 列出所有已注册 provider 及其状态 |
| `memory_provider_status` | read-only，裸调 | 当前激活 provider + 召回状态 + 最近激活结果 |
| `memory_provider_activate` | write，ask | 激活指定 provider（失败自动降级 builtin） |
| `memory_provider_deactivate` | write，ask | 停用外部 provider 回 builtin |

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

## 安全护栏（设计稿 §9.1）

- **L0**：builtin 始终可用（`builtin` 保留名不可被外部 provider 顶替）；单外部 provider 限制。
- **L1**：激活失败自动降级 builtin，不中断对话；prefetch 失败本轮空上下文不抛错。
- **L2**：secrets 只存 env var 名，疑似凭证字面量拒绝；日志不落敏感数据（prefetch 失败只记 `prefetch failed`）。
- **L3**：activate/deactivate 为 write 操作，preset 平面配 ask 门禁。
- **L4**：激活/停用/配置修改全流程写 audit_log。
- **§9.3 自我评估禁止**：管理器不自动切换 provider、不自动改配置（唯一自动降级是「激活失败 → builtin」护栏兜底）。

## Sprint 16/17 接力

- **Sprint 16**（§12.2）：运行时降级（单次失败 + 连续失败切换 + 自动恢复）、prefetch 超时保护、pre_compress 检查点（fail-closed，api_version=2）、fallback_events / pre_compress_checkpoints 表写入、provider 工具动态注册（加前缀防冲突）——`lib/manager.js` 中已显式占位。
- **Sprint 17**（§12.3）：配置管理向导（getConfigSchema + saveConfig + .env 集成）、定期健康检查、pause/resume 工具化、与 agint-metrics / agint-evolution-memory 集成、外部 provider 插件开发指南 + 示例 provider。

## 测试

```bash
node --test test/smoke.mjs   # 67 PASS（导出契约 / schema / storage / provider 校验 / registry / trivial / builtin / manager / mock）
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
