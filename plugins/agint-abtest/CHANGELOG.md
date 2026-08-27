# Changelog — agint-abtest

## 0.6.4 (2026-08-27) — Sprint 10 #9 收口

### Added

- **新增独立 Cordis 插件**：Prompt-A/B 测试基础设施（设计稿 §二.6 + §四子任务 #9）
- **FROZEN Service 契约**：
  - `start({ variantA, variantB, taskSuite, significanceThreshold? }) → { testId, status: 'running' }`
  - `report({ testId }) → { winner, pValue, effectSize, samples }`
  - `listTests() → { tests: [...] }`
- **4 个统计纯函数**（`lib/statistics.js` 独立可测）：
  - `welchTTest(samplesA, samplesB) → { t, df, pValue }`
  - `bonferroniAdjust(alpha, numTests) → adjustedAlpha`
  - `cohensD(samplesA, samplesB) → number`
  - `decideWinner({ samplesA, samplesB, threshold, taskSuite }) → 终态`
- **统计护栏**（设计稿 §二.6 + §六 §6.4）：
  - 任务集 ≥10 启动（老板拍板初版宽松，跑 2 周后收紧到 ≥30）
  - Bonferroni 校正：adjustedAlpha = α / taskSuite.length
  - Cohen's d ≥0.3 才判 winner
  - 样本量不足 → 'inconclusive'（不强行判 winner）
- **独立存储域** `agint_abtest`（2 表：abtests 50 + samples 10000）
- **PLUGIN-SPEC 8 维度** manifest（顶层 cordis/storage/dependencies/permissions 字段；与 Sprint 10 #3 #4 新插件一致）

### Security

- 与 SDK 模板级 static-check 形成双轨（SDK 管模板；本插件管 prompt A/B 行为）
- 不引入第三方统计库（jStat / simple-statistics）—— 纯 JS 自写 normal CDF 近似

### Compatibility

- 不挂顶层 `cordis.patch.yml`（Sprint 10 仅仓库发版）
- 不引用 quality-contract FROZEN 接口（实测 `grep -rn 'agint-quality-contract' plugins/agint-abtest/{lib,test}/` 0 命中）