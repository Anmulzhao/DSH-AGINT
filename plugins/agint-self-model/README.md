# agint-self-model

AGINT 自我模型插件（Sprint 13 / Part 2，v0.7.1）。

## 定位

**只读观察者**（设计稿 Sprint13 §4.1 / D2）：`自我认知 ≠ 自我修改`。

- ✅ 聚合既有插件数据形成自我画像
- ✅ 输出能力边界供 `agint-curriculum`（Sprint 14）消费
- ✅ 发布 `self.*` 事件（A11 `self.model.updated`）
- ❌ 不写 `qualityPolicy` / `mutator` / `population` 任何状态
- ❌ 不直接修改自身或其他插件代码

由静态检查规则 `self-model-isolation` 强制（§4.7）。

## 存储

独占域 `agint_self_model`（4 表，上限对齐 diagnosis 200/50/50）：

| 表 | 上限 | 内容 |
|---|---|---|
| `capability_map` | 200 | 能力图谱（CAN/CANNOT/UNCERTAIN + `lastVerifiedAt`） |
| `reasoning_profile` | 100 | 推理模式画像 |
| `resource_baseline` | 50 | 资源感知基线（p50/p90） |
| `calibration_log` | 100 | 校准日志（误差护栏数据源） |

## Service

| Service | 说明 |
|---|---|
| `agint.selfModel.snapshot({domain?})` | 返回 SelfModelSnapshot（FROZEN） |
| `agint.selfModel.update({trigger, evidence})` | 轻量更新；trigger ∈ task-completed\|task-failed\|diagnosis-completed\|dream-completed\|weekly |
| `agint.selfModel.calibrate({windowDays?})` | 全量校准，返回 CalibrationResult[] |
| `agint.selfModel.stats()` | 四表计数摘要（辅助） |
| `agint.selfModel.inspectSummary()` | 巡检摘要（辅助） |

## 事件集成

- 消费（影子）：A6 `diagnosis.completed` / A8 `dream.completed` → 轻量 `update`
- 发布（A11）：`self.model.updated`（T1 影子期 publish-only；payload FROZEN）

## 校准误差护栏（§4.6）

`error = |predicted − actual|`；滚动窗口默认 28 天。
- 域内样本 < 10 → `UNCERTAIN`，不计误差（cold-start 守门）
- 任一域误差 > 10% → 写 `failure_pattern`（tag=`self-model-miscalibration`）+ 周复盘告警

## 哲学对齐

- **真实 > 讨好**：能力条目强制 `lastVerifiedAt`；校准暴露原始 p50/p90 与样本数
- **简洁 > 冗余**：不自建采集器（D6），全部复用既有 Service
- **靠谱 > 聪明**：cold-start 守门防小样本伪精度

## Peer 依赖豁免（2026-09-16 验证 + 放宽）

`package.json` peerDependencies 已放宽到「实际最低可用版本」（老板 2026-09-16 决策：保持向后兼容性，不锁定版本）：

| peer | 当前声明 | 实际最低可用版本 | 验证 |
|---|---|---|---|
| `@deepseek-ai/dsh-storage-domain` | `*` | 任意 | cordis host 注入 |
| `agint-diagnosis` | `>=0.1.0` | 0.1.0（`report()` 已存在） | `test/real-compat.mjs` ✓ |
| `agint-event-bus` | `>=0.7.0` | 0.7.0（FROZEN envelope schema 引入点；0.6.x 形态不一致） | 边界 |
| `agint-evolution-memory` | `>=0.6.4` | 0.6.4（shadow ingest schema 冻结点） | 边界 |
| `agint-metrics` | `>=0.1.0` | 0.1.0（`summary()` 已存在） | `test/real-compat.mjs` ✓ |
| `agint-tool-stats` | `>=0.1.0` | 0.1.0（`summary()` 已存在） | `test/real-compat.mjs` ✓ |
| `zod` | `^3.0.0` | zod v3 | 平台统一 |

**放宽理由**：原 `>=0.7.0` / `>=0.6.0` 是 Sprint 13 设计稿的"乐观约束"（当时假设上游会先升），但实际诊断/指标/工具统计这些 API 在更早的 0.1.0 就已稳定。锁定高位版本对历史副本是 npm warn 噪音，没有实际安全价值。

**复测节奏**：每次 metrics / tool-stats / diagnosis 发版前重跑 `test/real-compat.mjs`，失配立刻改 peerDep 或回退 self-model。

证据：`wiki/AGINT/版本依赖分析-2026-09-16.md` §三、`evolve_propose` id `48c5385d-a517-4dcf-9c10-fdb657aa703c`。
