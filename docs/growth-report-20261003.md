# AGINT Growth Report

> 生成时间：2026-10-03T14:23:30.889Z · schema 1.0
> 数据源：evolution_ledger 6 行（选中 6 行）· prediction_outcomes 0 行

> ⛔ 读法：本报告里「**无数据**」与数字同样重要。它表示**没有测过**，
> 不表示「效果为零」。本报告从不把缺数据渲染成 0。

## 1. 期间与决策

- 代际区间：GEN-000（仅 1 个取值，无代际跨度） _(n=1)_
- 决策总数：6 条 _(n=6)_
  - AUTO_DEPLOY 3 · PENDING_REVIEW 1 · REJECT 2 · ABSTAIN 0
  - 部署率：50.0%（分母 = 全部决策，ABSTAIN 不从分母剔除）
- 部署率趋势：期初 0.0% → 期末 100.0%（+100.0pp） _(n=6)_
- 回滚数：0 次 _(n=0)_

## 2. 证据来源（这条决定报告能怎么读）

- 条目构成：共 6 条 · 历史重建 6 · 实时 0 _(n=6)_

## 3. 预测准确度

- 实测读数：**无数据** — OUTCOMES_TABLE_ABSENT: 生产存储里没有 prediction_outcomes 表 ⇒ 表可能尚未被宿主懒建（不确定，不当「无数据」而当「无表」）
- 挂链情况：**无数据** — NO_OUTCOMES: prediction_outcomes 0 条 ⇒ 没有任何实测读数（1.1 未出数）
- 预测准确度：**无数据** — OUTCOMES_TABLE_ABSENT: 生产存储里没有 prediction_outcomes 表 ⇒ 表可能尚未被宿主懒建（不确定，不当「无数据」而当「无表」）

## 4. 本报告不能回答什么

- **outcomes** — OUTCOMES_TABLE_ABSENT: 生产存储里没有 prediction_outcomes 表 ⇒ 表可能尚未被宿主懒建（不确定，不当「无数据」而当「无表」）
- **predictionAccuracy** — OUTCOMES_TABLE_ABSENT: 生产存储里没有 prediction_outcomes 表 ⇒ 表可能尚未被宿主懒建（不确定，不当「无数据」而当「无表」）
- **linkage** — NO_OUTCOMES: prediction_outcomes 0 条 ⇒ 没有任何实测读数（1.1 未出数）

## 5. 读这份报告时必须知道的事

> 以下不是缺口 —— 这些指标**有数据**，但数据有前提。

- **provenance** — ⛔ 全部条目都是 reconstructed（历史重建）⇒ 本报告不含任何「系统当时自动裁决」的实时决策 _（样本 6）_
- **rollbacks** — rollback_log 表存在且 0 行 ⇒ 期间内无回滚记录（这是真 0，不是缺数据）
- **successRateTrend** — ⛔ 全部条目都是历史重建 ⇒ 该趋势反映「重建脚本读到的事件分布」，**不是**系统的学习曲线 _（样本 6）_

---

*本报告由 `bin/growth-report.mjs` 生成（只读）。PQ 口径复用 `prediction-scoring.js`，未二次实现。*
