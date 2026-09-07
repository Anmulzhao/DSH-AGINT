# Changelog — agint-abtest

## 0.6.5 (2026-09-07) — K19 round-trip + ask-abtest-report

### Changed
- **`lib/tools.js`** 新增并入仓（之前仓库缺此文件；host `~/.dsh/profiles/web/plugins/agint-abtest/lib/tools.js` 存在但无源码 source-of-truth）。
  - 所有 `execute()` 用 `JSON.parse(JSON.stringify(v))` round-trip 兜底，防 host 返回 Date/Map/BigInt/undefined 时 dsh-tools 的 lossless-JSON 检查 fail。
  - render 函数防 null 嵌套字段（`t.variantA?.promptId ?? '?'` 风格不再裸属性访问）。
- 工具描述补"已被 ask-abtest-report / ask-abtest-start 规则门禁，调用前 rule_check 会返回 ASK"。

### Added
- **`ask-abtest-report`** 规则通过 agint-rules 注册（action=ask, level=L2, pattern=`^abtest_report$`）。`abtest_report` 会写 `abtests.status`（completed/inconclusive） + 返回 winner 判断，下游 pipeline 据此推进 → 必须 ask gate（不是裸读）。

### Fixed
- **`abtest_list_tests` 实测 `value is not lossless JSON`** 根因：render 函数对 `t.variantA?.promptId` 链式可选访问时，若 `t.variantA === null` 会抛错，error path 不再满足 JSON-lossless 契约。0.6.5 用 `?? {}` 兜底。

### Migration
- Host 同步延后：当前工具运行时 `tools/post-execute accept decision cannot replace both value and content` 错挡 `Copy-Item` + `danger-full-access`。下次 install.sh 或 restart-runbook.ps1 重启时再覆盖 `~/.dsh/profiles/web/plugins/agint-abtest/lib/tools.js`。期间 host 端 list_tests 仍可能报 K19。

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