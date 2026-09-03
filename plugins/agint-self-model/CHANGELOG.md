# Changelog — agint-self-model

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
