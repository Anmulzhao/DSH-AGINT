# Changelog — agint-quality-policy

## 0.6.4 (2026-08-27) — Sprint 10 #10 收口

### Added

- **abtest 加权综合分接入**（设计稿 §二.6 + §七 L0-frozen）：
  - contract QualityConfigSchema 加 `abtest`块（ADJUSTABLE）：enabled/weight/minSamples/pValueThreshold
  - `abtestResultsToDimension({ abtestResults, abtestConfig })` helper：winner/pValue 映射为 abtest dimension score
  - `injectAbtestDimension(results, dim)` mutate-safe 注入到所有 results 的 dimensions
  - `decidePolicy` 在 config.abtest.enabled=true 时把 abtest dimension prepend 到 results，权重来自 config.abtest.weight（默认 0.10）
- **abtest dimension 不参与 safety/trust 一票否决**（设计稿 §十.2 + 简洁 > 冗余）
- **14 个新单测**（test/abtest-weighted.test.mjs）：覆盖 abtestResultsToDimension 4 映射分支 + injectAbtestDimension mutate-safe + decidePolicy 4 集成场景 + QualityConfigSchema 接受 abtest 块

### Compatibility

- abtest.enabled 默认 false（向后兼容）：现有 190 测试全过
- L0-frozen 接口签名（QualityEvaluator / QualityPolicy / QualityReporter / QualityLifecycle）未触动
- AGINT 工程文件 manifest.json + README.md + CHANGELOG.md + cordis.patch.yml 补齐（PLUGIN-SPEC 8 维度）

## 0.4.0 — Sprint 4 完整版（v0.4.0 / v0.5.x 沿用）

- 完整 4 决策 + 加权综合分 + 反和谐 + 元评估委员会 + HARM 报告
- 详见 git log v0.4.0 / Sprint 4 设计稿