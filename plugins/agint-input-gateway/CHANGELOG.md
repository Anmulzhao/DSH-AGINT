# Changelog

## 0.1.0 — 2026-09-29

### 新增

- **agint-input-gateway** 插件 v0.1.0（P0）：多源输入网关核心框架
  - Gateway 七模块：scheduler / normalizer / filter / router / quota / security / observability
  - C2 系统自观测 Channel（5 子源）：
    - toolStats 异常检测（失败率 >30% 触发信号）
    - metrics 退化检测（错误计数 >10 触发信号）
    - 规则高频命中（deny 规则 ≥10 条报告）
    - 压缩丢失（调用 agint.compressGuard.stats() 检测 BLOCKED/DEGRADED）
    - session 完整性（P0 留接口，P1 实现）
  - eventBus 集成：信号归一化为 `input.signal.<channelType>.<signalType>` topic 发布
  - 软降级：eventBus 不可用时静默，不影响主流程
  - publish accepted 检查：历史教训（skill-autocreate 不检查导致静默丢弃）
  - 去重：24h 滚动窗口，channelId+signalId 唯一
  - 噪声抑制：同 source+signalType 1h 内最多 5 条
  - 配额：每 Channel 日上限（C2 默认 50 条/日）
  - payload 截断：超过 2KB 自动截断为 summary

- **6 个 model 工具**：
  - 只读：`input_gateway_status` / `input_gateway_channel_status`
  - 写操作（ask 门禁）：`input_gateway_force_fetch` / `input_gateway_set_quota` / `input_gateway_channel_enable` / `input_gateway_channel_disable`

- **存储域**：`agint_input_gateway`（4 表：config / counters / dedup / channel_state，schemaVersion 1）

### 设计决策（v1.1 方案确认）

- Q1=B：人类意图不经过 Gateway，反馈旁路发布
- Q2=C：Channel 初评 relevance，Gateway 调整
- Q3=C：主动拉为主，事件驱动用推送（P0 全拉模式）
- Q4=B：写操作工具 P0 即暴露，走 rule_check ask 门禁
- Q5=A：payload ≤2KB

### 不做什么（P0 边界）

- 不接 C3 外部世界（git/web/依赖）——P1
- 不接 C4 对抗挑战——P2
- 不接 C5 跨 Agent/OpenViking——P3
- 不修改 memory/evolve/dream 的消费端订阅——P1
- security 模块为接口预留（C2 是内部信号，不需要 rules 门禁；P1 C3 外部信号启用）
