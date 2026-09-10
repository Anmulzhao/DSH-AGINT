# agint-dream CHANGELOG

> 每次发版/修破坏性变更在这里追加一条目。
> 旧条目不删，加新条目在上。

---

## v0.3.0-C4 — dream_status schema 补同步（2026-09-11，工具从「不可用」恢复）

**根因**：`lib/index.js` 的 `status()` 返回 `counts.evolutionTemplates`（v0.3 / task 3，2026-09-06 加），但 `lib/tools.js` 里 **`dream_status`** 的 output schema 漏声明该字段，而 counts 是 `additionalProperties: false` → host 端 output 校验直接报 `value.counts.evolutionTemplates is not a declared property` → **整个工具调用失败**（不是降级，是完全不可用；排查梦境状态只能绕道读 diary 文件 + cron 表）。

**为什么 09-06 没修干净**：同日 task 1 声称「dream_status schema 同步（consolidationMode/Reason + qualityEval + evolutionTemplates）✅」，实际只把 `evolutionTemplates` 加进了 **`dream_run_now`** 的 schema（tools.js:181）—— 同一插件里有**两个工具的 counts schema 需要同步**，只改了一个却按整项验收为 ✅。`复盘-2026-09-06.md:19` 的 ✅ 是假✅。

**修复**：`dream_status` 的 counts.properties 补 `evolutionTemplates: { status, count, topConfidence, boost }`，shape 与 `dream_run_now`（tools.js:181-189）及 `lib/sweep.js:1049` 完全一致。仓库 + host 副本同步，纯 schema 补声明，无行为变更。

**验证**：repo↔host 哈希一致 `2C9743DD134035E3394A55DC76136045E03B6B0F311607D0C1E7FBF5B914DC6E`；`node --check` exit 0。运行期验证需重启 dsh（host 插件非热重载）。

**教训**：schema 同步的验收单位是「**每个 tool × 每个返回字段**」，不是「每个新增字段」。同一 service 被多个工具暴露时（dream_status / dream_run_now）必须逐工具核对，漏一个就是整工具不可用；复盘报告里的 ✅ 必须附 host 实测输出，否则是假✅。

---

## v0.3.0-C3 — compositeMean 真正修复（2026-09-06，path=undefined）

**根因**（3 轮 debug 定位）：dream bridge `resolveEvalTargets` 的 `target.path` 传 `null`，但 quality-eval 的 `EvalTargetSchema` 里 `path: z.string().optional()` —— **zod .optional() 接受 undefined 但拒绝 null** → `path: null` 触发 `invalid_type` → `EvalTargetSchema.parse` 抛错 → `evaluate()` 抛错 → status='error' → compositeScore=null → compositeMean=n/a。

**修复**：`resolveEvalTargets` 不传 `path` 字段（undefined）。EvalTargetSchema 通过 + evaluate() 的 sandbox gate（`if (sandbox && ... && target.path)`）因 path undefined 跳过 → 直接走 `evaluateAll` 完整评分。

**host 验证（2026-09-06）**：`dream_run_now` 输出 `qualityEval=ok · compositeMean=71.4 · ok=9/9`；dream_diary 第 47 行 `v0.2 qualityEval: status=ok · compositeMean=71.4 · harmMean=0.5 · 评估 9 个 plugin (9 ok)`。

**已移除**：3 轮 debug 代码（debugInfo / summaryReason）——排查完成后清理干净。

**教训**：zod `.optional()` 字段传 null 会校验失败（invalid_type），应传 undefined / 不传字段。见 memory id=`e5609e0c-...`。

---

## sandbox smoke.js Windows 修复（外部依赖 bug fix，2026-09-06）

**根因**（排查 dream compositeMean=n/a 时发现）：`agint-quality-sandbox/lib/smoke.js` line 89 用 `await import(\`file://${mainPath}\`)`，Windows 下生成 `file://C:/...`（两斜杠）是无效 URL → ERR_UNSUPPORTED_ESM_URL_SCHEME → 所有 plugin import 失败 → makeSandboxRejectedResult → 只有 safety=0 维度 → compositeScore null → dream compositeMean=n/a。

**修复**：`file://${mainPath}` → `pathToFileURL(mainPath).href`（三斜杠），共 2 处（Check5 import + CLI 入口判断）。文件：`agint-quality/agint-quality-sandbox/lib/smoke.js`。

**验证**：runSmoke 对 8 个 plugin ok=true；只剩 agint-quality-contract（嵌套 monorepo 无 package.json 设计使然）。

**影响**：dream 的 qualityEval compositeScore 将能正常算出（sandbox REJECT 不再全触发）。需重启 dsh 使 smoke.js 修复生效。**在打包 agint-dream 时可能需同步 smoke.js 到 quality 子家族。**

---

## v0.3.0-B — 2026-09-06 — compositeMean 中性兜底 + status 语义修正（老板拍板 B）

**核心变更**：`quality-bridge.js` 的 `evaluatePlugin` 增加 compositeScore null 时的 B 兜底 + 修正 status 判定。

**B 兜底逻辑**（compositeScore null 时）：
- 真 safety veto（sandbox REJECT，safety.score < 0.5 或 null）→ 保留 null（诚实）
- 非 veto（safety 健康但数据源不可用）→ 给中性 50（0-100 标量）

**status 判定修正**：
- 原：`dimensions.length > 0` → ok（sandbox REJECT 只有 1 个 safety=0 维度也标 ok → 误导 ok=8/9）
- 修正：`dimensionCount >= 2 || (composite !== null && !isReject)` → ok；否则 degraded

**原因**：C3 host 验证报 `compositeMean=n/a`，根因是 quality-eval 对 9 个 plugin 的 sandbox gate 可能 REJECT（makeSandboxRejectedResult 只给 safety 维度）→ compositeScore null → compositeMean n/a。B 兜底让「数据源缺但非 veto」的 target 给中性 50，compositeMean 不再 n/a。

**文档**：插件规格 / docs 已同步 B 兜底 + status 修正。

**提案**：[78dbb9e3-...] C3 任务

---

## v0.3.0 — 2026-09-06 — Deep 阶段读 evolution success-templates（task 3）

**核心变更**：`sweep.js` Deep 阶段调 `collectEvolutionSummary()` 读 `agint.evolution.queryTemplates` 的 success-templates，作为全局 score boost（±0.02）影响候选打分。

**新增**：
- `lib/evolution-bridge.js`（新建，126 行）：evolutionPluginIds / fetchEvolutionTemplates / computeEvolutionBoost / collectEvolutionSummary
- `sweep.js` import evolution-bridge / 新参数 `evolution = true` / Deep 阶段调 collectEvolutionSummary + 应用 evolutionBoost / result.counts 加 `evolutionTemplates` 字段 / renderDiary 加 evolution 摘要段
- `sweep.js` 对 `scored` 每个 candidate 应用 `c.components.evolutionBoost`

**同步 schema**（task 1 教训）：
- `lib/tools.js` dream_run_now schema + render 加 `evolutionTemplates` 字段
- `lib/index.js` status() 兜底 counts 加 `evolutionTemplates` 字段

**映射决策**（老板 2026-09-06 拍板）：
- 映射 = A: **按 plugin id 精确匹配**（`appliesTo: ['agint-memory', ...]`）
- 前置验证 = 要：rule_check + 读 evolution-memory/lib/index.js 确认 service key `agint.evolution` + queryTemplates API

**关键前置验证结论**：
- service key：`agint.evolution`（agint-evolution-memory/lib/index.js line 332）
- API：`evo.queryTemplates({ appliesTo, query, limit })` → `[{id, template, confidence, appliesTo, sampleSize, level, ...}]`
- evolution-memory host 已挂载（cordis.patch.yml line 165-166）

**降级路径**（永不抛错，不阻断 sweep）：
- ctx 不可用 / evolution service 不可用 → `{ status: 'unavailable', reason }`
- queryTemplates 抛错 → `{ status: 'unavailable', reason: 'queryTemplates threw' }`
- 返回空模板 → `{ status: 'ok', count: 0, templates: [] }`（正常，空库）
- 任何抛错 → `errors.push(...)` + 返回 unavailable summary

**host 验证（2026-09-06）**：`dream_run_now` 输出 `evolution=ok · templates=0 · topConfidence=n/a · boost=0`；dream_diary 第48 行 `- v0.3 evolution: status=ok · templates=0· topConfidence=n/a`。`templates=0` 是 evolution 库空（周复盘蒸馏未跑），非 bug。

**语义**（重要）：
- success-templates 评估 plugin 质量（appliesTo: plugin id），不是 dream candidate——与 qualityEval 同构
- evolution 模板作为全局信号：模板多/置信度高 → 系统自进化健康 → 候选可信

**提案**：[ba3e1800-c686-45fe-8141-d20ab9e2c6fb] task 3 + [78dbb9e3-...] C3 相关

---

## v0.3.0-C3 — 2026-09-06 — C3 compositeScore 真值接入（task 2 后续）

**核心变更**：`quality-bridge.js` 的 `evaluatePlugin` 改用 `evaluator.score(result)` 拿真 composite（0-100），替代 C2 的 `safety?.score?.score` 代理。

**关键发现（纠正 C3 提案 78dbb9e3-... 的判断错误）**：
- quality-eval evaluator service 已有 `score(evalResult)` 方法（agint-quality-eval/lib/index.js line 272）——**0 行上游改动**
- dream bridge 直接 `evaluator.score(result)` 即可
- 之前 C3 提案说"必须改 quality-eval 源码暴露 service"是**错的**

**变更**：
- `lib/quality-bridge.js` `evaluatePlugin`：`compositeScore = await evaluator.score(result)`（0-100）
- `lib/sweep.js` `computeQualityBoost` 阈值：0.7→70 / 0.3→30（0-100 标量）
- `lib/sweep.js` renderDiary 精度：0.00→0.1（1 位小数对齐）
- `lib/index.js` bridgeVersion：`C3 (REM integrated; real compositeScore via evaluator.score(); 0-100 scale)`

**host 验证（2026-09-06）**：`dream_run_now` 输出 `qualityEval=degraded · compositeMean=n/a · ok=8/9`——compositeMean=n/a 是诚实 null（quality-eval 对 9 个 plugin 的 trust/reliability 等维度数据源不可用，compositeScore() 无法合成）。**老板拍板接受 n/a（不修数据源，超 task 3 scope）**。

**提案**：[78dbb9e3-...] C3 任务

**下个 commit**：拆 tools.js（410+ 行）提案 a9d3b567-... 保持 proposed

---

## v0.2.0-C2 — 2026-09-06 — REM 阶段 qualityEvaluator 实际接入（task 2 / C2）

**核心变更**：`sweep.js` REM 阶段调 `collectQualityEvalSummary()` 评估 9 个 BASELINE_TARGETS，结果作为全局 score boost（±0.02）影响候选打分。

**新增**：
- `sweep.js` import quality-bridge 的 `resolveEvalTargets` / `evaluatePlugins`
- `sweep.js` 新参数 `qualityEval = true`（默认开，false 可关闭应急回滚）
- `sweep.js` 新函数 `collectQualityEvalSummary({ ctx, enabled, errors })` —— 永不抛错，聚合 9 个 target 的 compositeScore / harmScore 均值
- `sweep.js` 新函数 `computeQualityBoost(summary)` —— compositeMean ≥ 0.7 → +0.02，≤ 0.3 → -0.02，其他 → 0
- `sweep.js` `scoreCandidates` 加 `opts.qualityEvalSummary` 参数，candidate 加 `components.qualityBoost` 字段
- `sweep.js` `result.counts` 加 `qualityEval: { status, compositeMean, harmMean, targetCount, okCount }`
- `sweep.js` `renderDiary` 加 qualityEval 摘要段（status / compositeMean / okCount）

**同步 schema**（避免 task 1 / C1 覆辙）：
- `lib/tools.js` dream_status schema 加 `qualityEval` 字段
- `lib/tools.js` dream_run_now schema 加 `qualityEval` 字段
- `lib/tools.js` dream_run_now render 加 qualityEval 行
- `lib/index.js` status() 兜底 counts 对象补 qualityEval 字段

**降级路径**（重要：qualityEvaluator 不可用时不阻断 sweep）：
- `enabled === false` → `{ status: 'unavailable', reason: 'disabled by sweep opts' }`
- ctx 不可用 / service 不可用 → `{ status: 'unavailable', reason: 'ctx unavailable' / '...' }`
- 部分 target 评估失败 → `{ status: 'degraded', compositeMean 用成功子集均值 }`
- 全部失败 → `{ status: 'unavailable' or 'degraded' }`
- 任何抛错 → `errors.push(...)` + 返回 unavailable summary

**性能**：
- 9 个 target 并发 4（bridge 默认 evaluateConcurrency）
- 单 target timeout 30s
- 评估失败不影响 sweep，sweep 总时长增量 = 「实际成功 target 评估耗时」

**已知边界**：
- `compositeScore` 在 bridge 里用 `safety?.score?.score` 作粗略代理（C1 没解析真 composite）。C2 沿用此代理，**C3 应直接调 `agint-quality-eval/lib/evaluators.js` 的 `compositeScore()` 纯函数**（同包内 import）拿真 composite。
- qualityEval boost 是**全局**（所有候选同样调整），不是 per-candidate —— 因为 qualityEval 评估的是 plugin，不是 dream candidate（参见 memory id=e7f0290e-...「真实语义」教训）

**提案**：[ba3e1800-c686-45fe-8141-d20ab9e2c6fb] task 2

**下个 commit（C3 草案）**：
- bridge `compositeScore` 改成调 quality-eval 真 compositeScore 函数
- 加 `qualityEval.test.js`：mock qualityEvaluator + 测试 4 条降级路径
- 文档：`插件规格-agint-dream.md` / `docs/plugins/agint-dream.md` 从「C1 meta only」改成「C2 部分实现（meta + REM 接入，待 C3 compositeScore 真值）」

---

## v0.2.0-C1 — 2026-09-06 — qualityEvaluator 桥接元数据（task 2 / C1）

**新增**：`lib/quality-bridge.js`（薄包装层，194 行）+ status() 透出 qualityEval bridge meta + tools.js schema 同步 qualityEval 字段。

**范围**：C1 只显示配置 + target 列表，REM 阶段实际 evaluate 调用留到 **C2**。

**关键决策**（代码注释里有详细论证）：
- Q1 (target 范围) = **A1**：所有 9 个 BASELINE_TARGETS（每次 sweep 9 次 evaluate ≈ 1-2s，简单稳定）
- Q2 (target.path) = **B3**：优先 host 副本（`$DSH_HOME/profiles/web/plugins/...`），回退 AGINT_HOME 仓路径（`$AGINT_HOME/plugins/...`）

**变更**：
- `lib/quality-bridge.js` 新建（`evaluatePlugin` / `evaluatePlugins` / `resolveEvalTargets` / `resolveTargetPath` / `toCandidateQualityField` / `getBridgeDefaults` / `DREAM_BASELINE_TARGETS` / `SELF_PLUGIN_ID`）
- `lib/index.js` status() 加 `qualityEval` 字段（`{bridgeVersion, targetsPlanned, targets, serviceKey, note, bridgeDefaults}`）
- `lib/tools.js` dream_status schema 加 `qualityEval` 字段定义（同步 schema，避免重蹈 task 1 覆辙）
- `lib/tools.js` dream_status render 多 2 行 qualityEval 透出

**降级路径**：
- ctx 不可用 → `status: 'unavailable', reason: 'ctx unavailable'`
- qualityEvaluator service 不可用 → `status: 'unavailable', reason: 'agint.qualityEvaluator service unavailable'`
- target 形状错误 → `status: 'error', reason: 'invalid target kind'` / `'missing target.id'`
- 自评约束 → `status: 'error', reason: 'self-evaluation refused'`
- 评估超时（30s）→ `status: 'error', reason: 'evaluate timeout after Xms'`
- evaluate 抛错 → `status: 'error', reason: 'evaluate threw: ...'`

**已知边界**（C2 实施前必须验证）：
- qualityEvaluator 是 Sprint 12 A1 T1 影子期（评估结果写 shadow ring buffer，不进 model 工具）—— 当前 host 端可能在跑 shadow 模式，evaluate() 拿到的是 shadow snapshot 还是真 EvalResult 以 host 实际为准。C2 接 REM 时必先实测 `dream_status` 输出是否能看到真实 qualityEval.targets 列表（确认 service 装载），再决定是否调 evaluate。
- `compositeScore` 在 C1 里用 `safety?.score?.score` 作粗略代理（C1 没解析真 composite）—— quality-eval 没暴露 `compositeScore` service，**C2 应直接调 `agint-quality-eval/lib/evaluators.js` 的 `compositeScore()` 纯函数**（同包内 import OK；不跨插件 import）。
- `harmScore` 是 4 维平均（homogeneity/alignment/reduction/mutability）—— C2 可改为加权或保留平均。

**提案**：[ba3e1800-c686-45fe-8141-d20ab9e2c6fb] task 2

**下一个 commit（C2 草案）**：
- sweep.js REM 阶段调 `evaluatePlugins(ctx, resolveEvalTargets())`，把结果写入 `candidate.qualityEval` 字段
- dream_diary render 加「REM 阶段 qualityEval 摘要」段落
- 测试：mock qualityEvaluator + 429 / service-unavailable 降级路径
- 文档：`插件规格-agint-dream.md` / `docs/plugins/agint-dream.md` 从「v0.2 计划」改成「v0.2 部分实现（C1 meta only，REM 接入留 C2）」

---

## v0.1.1 — 2026-09-06 — schema 同步补丁

**修复**：dream_status 输出 schema 与 sweep.js 返回值不同步。
- 现象：调 `dream_status` 报 `counts.consolidationMode / consolidationReason is not a declared property`（additionalProperties: false 严格校验）。
- 根因：Sprint13（2026-09-05）P1 LLM consolidation 上线时，sweep.js result.counts 加了 `consolidationMode` / `consolidationReason` 字段，但 `lib/tools.js` dream_status 输出 schema 与 `lib/index.js` status() 兜底对象都忘了同步——典型「服务方法返回值改 schema 没同步」坑。
- 修复：
  - `lib/tools.js` dream_status schema `counts.properties` 补两个字段（consolidationMode: string, consolidationReason: string|null）
  - `lib/tools.js` dream_status render 多一行 `consolidation=... · validation=...`
  - `lib/index.js` status() 兜底 counts 对象补两个字段（`consolidationMode: 'n/a', consolidationReason: null`）
- **2026-09-06 host 验证 OK**：老板按 `bin/restart-runbook.ps1` 重启 dsh web，`dream_status` 不再报 `counts.consolidationMode / consolidationReason is not a declared property`，render 输出多一行 `consolidation=... · validation=...`。
- 提案：[ba3e1800-c686-45fe-8141-d20ab9e2c6fb] task 1
- 教训：AGINT 已有 lesson `agint-tools-additionalProperties-strict-schema`，v0.1 收口后再次踩中——**任何 sweep.js / service 方法返回值字段变更，必须同步 preset tools.js 的 schema + render + 兜底对象**。下个 sprint 应自动检查。

---

## v0.1.0 — 2026-09-05 — Sprint13 收口

**特性**（P0/P1/P2 三方向）：
- **P0**：Validation Gate + Loss Fraction Budget（`lib/validation-gate.js`）—— 写 agint.memory 前强校验 loss fraction ≤ 0.25 + lineageKey + 1 candidate → 1 operation
- **P1**：LLM Consolidation（`lib/consolidation.js` + `lib/verify.js`）—— sweep 主体插入 consolidation（gate → unpromoted filter → consolidation → validation），用 `ctx.agents.create({meta:{cwd,origin:'subagent'}})` + `ctx.subagents.start('spawn', {outputSchema})` 调 LLM 决策 add/merge/supersede；8 条退化路径永不抛错
- **P2**：Short-Term Recall Store（`lib/recall-store.js`）—— JSONL append-only 跨 sweep 累积 + dedupe + 30 天剪枝 + markPromoted；inspection tool `recall_store_inspect` 支持 key/type/since/until/limit/json 6 参数

**新工具**：5 个 preset model tool（`dream_status` / `dream_run_now` / `dream_diary` / `recall_store_inspect` / `dream_verify_consolidation`）

**事件**：`dream.completed`（Sprint12 T1 影子期）+ `dream.rejected`（P0 校验失败）

**断电恢复**：`lastSweep` 从 on-disk diary mtime fallback，counts 老实为 0

**测试**：5 个文件（`sweep.test.js` / `validation-gate.test.js` / `recall-store.test.js` / `consolidation.test.js` / `sweep-integration.test.js` / `dream-completed-publish.test.mjs`）

**已知 gap（v0.1.0 不包含，待未来 sprint）**：
- **v0.2** REM 阶段调 `agint.qualityEvaluator` 评估候选 Plugin/Skill + HARM 简版计算（提案 ba3e1800-... task 2）
- **v0.3** Deep 阶段读 `agint_evolution/success-templates` 作为评分参考 + 归档 evaluation summaries（提案 ba3e1800-... task 3）
- **运行时常态断层**：当前 sweep 跑成 `heuristic-degraded` 因 LLM 429 Token Plan 用量上限（详见 `wiki/参考-openclaw-dreaming实现.md` §7）

---

## 更早

v0.0.x 早期版本无 CHANGELOG 记录（host service 初装，含 dream_status/dream_run_now/dream_diary 三件）。