# agint-quality-policy

> D-QAF Phase 4 策略引擎（基座 plugin，位于 `plugins/agint-quality/` 下）。

## 是什么

实现 QualityPolicyIface（contract FROZEN 接口）—— `decide({results, config, options}) → Decision`。

- 完整 4 决策：AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN
- 加权综合分：trust / reliability / effectiveness / safety / integrability + v0.6.4 #10 abtest 维度
- 反和谐检测器（falseHarmonyDetector.js）
- 元评估委员会（committee.js）：shadow run + auto-promote + rollback
- thresholds 走 contract.setConfig 审计

## Service 契约（FROZEN）

```js
agint.qualityPolicy = {
  decide({ results, config, options }) → Decision,
  ... committee / shadow / audit helpers
};
```

## Sprint 10 v0.6.4 #10 增强

A/B 测试结果作为加权综合分的额外输入维度：

```js
config.abtest = {
  enabled: true,           // 默认 false（向后兼容）
  weight: 0.10,            // 默认权重
  minSamples: 10,          // 任务集最小门槛（与 agint-abtest 对齐）
  pValueThreshold: 0.05,   // Bonferroni 校正前
};

options.abtestResults = [
  { winner: 'A', pValue: 0.01, effectSize: 0.5, samples: 20 },
  // ... 多 test 取 pValue 最小者
];
```

abtest → dimension 映射（decide.js `abtestResultsToDimension`）：
- winner='A'/'B' + pValue ≤ threshold → score=1.0
- winner='A'/'B' + pValue > threshold → score 在 [0, 0.5] 线性衰减
- winner='inconclusive' / null → score=0.5（中性，不强制 REJECT）

abtest dimension 不参与 safety/trust 一票否决（设计稿 §二.6 + §十.2）。

## 验证

```sh
node --test plugins/agint-quality/agint-quality-policy/test/abtest-weighted.test.mjs
bin/plugin-check.sh plugins/agint-quality/agint-quality-policy
```

## L0-frozen 保护

- ADJUSTABLE 字段（harmWeights / thresholds / abtest）由 policy 调整 + 写审计日志
- FROZEN 接口签名（QualityEvaluator/Policy/Reporter/Lifecycle）**绝不动**

## 行数预算

不在 Sprint 10 #10 单独预算范围（基座 plugin 与 quality 基座共同维护）。

## 相关

- `plugins/agint-quality/agint-quality-contract/` —— FROZEN 契约（绝不动）
- `plugins/agint-abtest/` —— A/B 测试独立 plugin（Sprint 10 v0.6.4 #9）
- `AGINT.wiki/Sprint10-设计稿.md` §二.6 + §七 L0-frozen