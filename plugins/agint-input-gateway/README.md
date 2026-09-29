# agint-input-gateway

AGINT 多源输入网关 v0.1.1。

## 一句话

统一接入异构信息 Channel，经归一化、去重、过滤、配额后发布到 eventBus，让自进化系统不再只依赖用户会话输入。

## 架构

```
Channels → Gateway（filter/dedup/quota/route）→ eventBus → memory/evolve/dream/curriculum
```

## P0 包含

- C2 系统自观测 Channel：toolStats 异常 / metrics 退化 / 规则高频命中 / 压缩丢失 / **session 完整性（0.1.1 实装）**
- **security 门禁（0.1.1）**：8 条外部信号 prompt injection 规则，`securityAction=flag/drop/off`
- **C4 对抗挑战 Channel**（已落地）：diagnosis / curriculum 事件转发，空壳事件默认转发（`forwardEmptyDiagnosis=true`）
- **C5 跨 Agent Channel**（已落地）：OV 检索增量 diff + 会话聚类 + 跨 preset 概览，每周日 05:00
- 6 个 model 工具（2 只读 + 4 写操作 ask 门禁）
- 存储域 `agint_input_gateway`（4 表）

## 后续阶段

- P1：C3 外部世界（git 仓库变更 / 依赖版本）+ 消费端订阅
- P4：C3 web 监控 + Gateway 自动降级

## 测试

```bash
node --test "test/*.test.mjs" test/smoke.mjs
```
