# Changelog — agint-self-model

## v0.7.2 (Sprint 16 / T2 准备件)
- A7 `metrics.snapshot` 消费方落地（此前订阅方为 0，见 wiki `T2-切边清单.md` §3）。
- 新模块 `lib/metricsIngest.js`：影子对账器 —— 订阅 A7（async，不占 sync 配额），
  按 `generatedAt` 攒批，批切换时用事件重建 snapshot 与直连 `metrics.snapshot()` 对账。
- **影子期纪律**：只记数不写任何表；资源基线权威路径仍是直连（observation.js 不动）。
  `mode='apply'` 留给 T2 拍板后启用，本版不实现写库。
- 判定口径：只判结构不对称（latency 条目单侧缺失）；值漂移仅记录不判定
  （事件批次与直连快照有时差，按值相等判定会让一致率永远不达标）。
- 对账统计经 `inspectSummary()` 的 `metricsIngest` 字段暴露（events / batches /
  compared / matched / mismatched / valueDrift / consistencyRate / lastMismatch）。
- 消费方落点修正：设计稿建议 evolve/dream，实际落 self-model —— 唯一有直连可切
  且在 prod 有流量的位置（observation.js:119 的 `metrics.snapshot()` 直连）。
- 测试：`test/a7-ingest.test.mjs` 28/28 PASS；原 smoke 19/19 无回归。

## v0.7.1 (Sprint 13 / Part 2)
- 全新插件：只读观察者自我模型。
- FROZEN schema：`self-model.schema.yaml`（CapabilityEntry / SelfModelSnapshot / CalibrationResult）+ `self-model-updated.schema.yaml`（A11 payload）。
- 独占存储域 `agint_self_model`（4 表：capability_map / reasoning_profile / resource_baseline / calibration_log）。
- 5 Service：snapshot / update / calibrate / stats / inspectSummary。
- 四大模块：capability（CAN/CANNOT/UNCERTAIN + lastVerifiedAt）、observation（推理画像 + 资源 p50/p90）、calibration（误差 ≤10% 护栏 + cold-start 守门）。
- 事件集成：影子消费 A6 diagnosis.completed / A8 dream.completed；发布 A11 self.model.updated（T1 publish-only）。
- 写路径隔离：禁止 inject/write `qualityPolicy` / `mutator` / `population`（由 `self-model-isolation` 静态检查强制，§4.7）。

## 诚实代价（边界）
- 首版是统计聚合画像，非真元认知；推理链断裂检测复用 diagnosis REASONING_ERROR 特征。
- 资源感知不含系统级测量（只统计工具调用时长/token/上下文）。
- 校准为启发式预测（历史滑动平均），样本 <10 输出 UNCERTAIN。
- A11 payload 在 T1 期影子运行，未经真实消费者检验（Sprint 14 预留 ADJUSTABLE 扩展）。
