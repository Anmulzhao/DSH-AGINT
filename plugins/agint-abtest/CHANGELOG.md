# Changelog — agint-abtest

## 0.7.0 (2026-11-18) — 打分机制接线（方案 v2.1，老板三拍板）

### Added
- **`lib/scoring.js`** 三层打分：L1-check 检查器通过率 / L1-exec verifySpec 断言（复用 curriculum verdict.judge，扩 `expected-failure` 类型供阴性对照）/ L2 pointwise 盲评 judge（复用 llm-verdict 管道层，新输出契约，meta.agentPreset 必传 K114）/ L3 校准一致率（<0.7 建议关闸）。
- **`lib/observe.js`** 观察编排：候选对（oldText=A/newText=B）→ 语料 gating → 隔离执行（文档类子会话答题 / 代码类原位物化备份还原）→ 预算帽 60 → 幂等注入 → report 恰一次 → 24h stale abort。judge 默认 preset `agint-zgs`（老板拍板：老板分身，判据口径对齐）。
- **`_internal.putSample / abort / listSamples / results`**：注入入口（确定性 id `smp-<testId>-<taskId>-<variant>` 幂等、score 夹 0..1、终态拒注）；results 只读最新终态结论供 policy 软取（不标状态不发事件）。
- **`tasks/`** 6 份任务语料 ×10 任务（plugin-preflight / plugin-check-sh / agint-mascot-fork-license-2026 / cordis-patch-yml / skill-authoring-test-mjs / tool-output-conformance-test-m），各 ≥2 区分度 + ≥1 阴性对照，断言经实跑校准。

### Changed
- **`lib/statistics.js`** 四处修复：p 值改 t 分布 CDF（不完全贝塔连分式，临界值表对拍 <1e-4）；零方差 epsilon 护栏（VAR_EPS=1e-12，常数组浮点噪声曾造出 d=4.8e15 假显著）；Bonferroni 按 numExperiments（不再除任务数）；新增 decideWinnerPaired 配对检验。
- **`report`** 切配对取样（按 taskId 配对，孤儿样本不计入）。FROZEN 服务签名 start/report/listTests 不变。

### Fixed（2026-11-18 首轮实跑揪出，同版本收口）
- **entries() 对语义**：真实 dsh-storage-domain `table.entries()` 产 **[key, value] 对**（Map.entries 语义），不是值迭代器。旧测试 mock 返 `values()` 遮住此洞 ⇒ 生产 putSample 恒「testId 在 abtests 表里查不到」、report/listTests/listSamples/results 全失真。index.js 全部消费点改解构 `[, record]`；6 个测试 mock 改真实语义（RED 9/10 复现后修）。
- **执行器/评审超时**：全 preset 子会话把答题当真实工作（60s 内 60 次工具调用后被 abort）。executor/judge prompt 加封闭卷面指令（「不要调用任何工具，直接输出结构化结果」），超时 60s→300s。

### Tests
- 新增 statistics-v2 / abtest-v2 / scoring / observe / tasks-corpus 五套；全套 105/105。

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