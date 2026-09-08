# eval 存量失败归因报告（2026-09-09）

> 任务来源：v0.7.1 发版说明遗留待办——「12 存量 eval fail 归因 ≥80%」。
> 结论先行：**12 个存量失败 100% 归因，0 个是产品 bug**；全是评估基础设施问题。
> 归因过程中额外发现并修复 2 个真产品缺陷（见 §3）。

## 1. 存量 12 个失败的归因（12/12 = 100%）

| # | 失败场景 | 归因 | 修复/验证方式 |
|---|---------|------|--------------|
| 1–10 | `classify-*` ×8 + `service-*` ×2（agint-diagnosis） | **主 driver 从未实现 diagnosis dispatcher**，场景 JSON 是"孤儿"。功能本身由专用评估器 `run-diagnosis-eval.mjs` 覆盖 | 专用评估器实测 **10/10 PASS**（本机） |
| 11 | `agint-mutator.scenario.json` | 同类：无 `plugin` 字段的**独立评估场景文件**被主 driver 自动发现并误当 driver 场景执行。它归属 `run-mutator-eval.mjs` | driver 加载器改为 SKIP（⊘）；专用 runner 实测 **19/19 PASS** |
| 12 | `agint-diagnosis-counterfactual.scenario.json` | 同上，归属 `run-counterfactual-stress.mjs` | SKIP；专用 runner 实测反事实 wouldSucceed 70%，双门槛 PASS |

**判定：可以关闭 v0.7.1 的这条挂账**——12 个失败没有一个是产品缺陷，全部是评估基建（driver 覆盖范围 + 场景文件归属）问题。

## 2. 为什么全量数字一度"看起来很糟"

在 Windows 上首跑全量 driver 得到 112/125 FAIL，远超存量 12。逐层剥离后确认分三类：

1. **Windows ESM URL bug（评估基建，~77 个）**：driver/runner 用 `D:/...` 绝对路径做动态 `import()`，Windows ESM 加载器要求 `file://` URL（Linux 不受影响，所以历史数字没暴露）。v0.7.1 修过 quality-static 同款问题，但 driver + 4 个专用 runner + quality-eval smoke 漏了。已全部修（`pathToFileURL`）。
2. **写死首台开发机路径（5 处）**：`/home/anmul/projects/AGINT` 硬编码在 3 个场景 JSON + s12-05 branch 文件 + sprint4 e2e。已改为 `$AGINT_ROOT` 令牌（driver 加载时替换）或从 `import.meta.url` 推导。
3. **依赖布局缺失（11 个）**：agint-quality-sdk 按 install.sh 约定从 `plugins/agint-quality/node_modules/zod` 引依赖，仓库 checkout 无此目录 → zod 找不到。已按约定路径补齐（gitignored）。

## 3. 归因过程中发现的 2 个真产品缺陷（已修复）

1. **`agint-quality-sdk/lib/check-all.js`：路径正则只认正斜杠**
   `filePath.replace(/\/manifest\.json$/, '')` 在 Windows（反斜杠 join）下永远不命中 → 模板路径拼错 → `discoverPromptTargets` **静默返回 0 个扫描目标**（scanned=0）。典型静默失败。已改为分隔符无关正则。Linux 行为不变。
2. **`agint-self-model/lib/storage.js`：存储打开同步 throw 穿透（59aa952 引入的回归）**
   `openStore` 注释承诺「失败时保持内存降级，绝不让异常逃逸成 fatal」，但 `ctx.storageDomain.open(spec).then(ok, fail)` 只接得住异步 rejection；**同步 throw 直接炸掉 apply()**。smoke（19 项断言）在第 9 项处整文件崩溃。已补 try/catch 按原契约降级内存。修复后 self-model smoke **19/19 恢复**。

## 4. 顺带修的过时项

- cron 场景期望任务列表少了 Sprint 14/15 新增的 `skill-autocreate-aggregate`、`curator-weekly`（2 个场景文件已更新）。
- driver 新增 **SKIP 语义**（无 `plugin` 字段 → 不归 driver 管的文件记 ⊘，不再污染 FAIL 数）；`file-executable` 检查在 win32 下跳过（NTFS 无 POSIX 执行位，恒为 666）。

## 5. 最终数字（本机实测 2026-09-09）

| 套件 | 结果 |
|------|------|
| 主 driver（125 场景） | **98 PASS / 25 FAIL / 2 SKIP** |
| └ 25 个 FAIL 构成 | diagnosis 10 + self-model 10 + deploy-budget 5，**全部是 driver 缺 dispatcher**（功能各由专用套件兜住，见下） |
| run-diagnosis-eval | 10/10 PASS |
| run-counterfactual-stress | wouldSucceed 70%，软门槛+路线图门槛双 PASS |
| run-mutator-eval | 19/19 PASS |
| run-baseline-regression | PASS |
| sprint4 闭环 e2e | 10/10 PASS |
| self-model smoke | 19/19 PASS（修复后恢复） |
| quality-eval smoke + deploy-budget | 4/4 + 11/11 PASS |
| agint-quality-sdk 自身套件 | 0 fail |

## 6. 剩余挂账（移交后续 Sprint 决策）

1. **driver 缺 3 个 dispatcher**（diagnosis / self-model / deploy-budget，共 25 场景）。这些场景 JSON 自 Sprint 13 起就存在但从未接入 driver——**VERSION 里「99/111」的数字自 Sprint 13 后没有再全量跑过，评估基线已过期**。选择：要么补 dispatcher 让 driver 成为唯一门禁，要么正式把这几族场景划归专用 runner 并从 `scenarios/` 挪走。
2. `eval/e2e/` 其余文件、host 挂载端（NAS 容器）未在本轮范围；本报告全部数字为本机（Windows）实测。
3. self-model 插件目录下裸跑 `node --test` 会把**故意做坏的测试夹具**（`test/fixtures/broken-*`）当测试执行而报 2 个"失败"——应从插件目录根运行指定文件，或给 fixtures 加命名约定规避。

## 改动文件清单

- `eval/scenarios/driver.js`（AGINT_URL + SKIP 语义 + $AGINT_ROOT 替换 + win32 exec-bit 跳过）
- `eval/run-{diagnosis-eval,mutator-eval,counterfactual-stress,baseline-regression}.mjs`（URL 修复）
- `eval/scenarios/*.scenario.json` ×5（$AGINT_ROOT 化 + cron 期望更新）
- `eval/scenarios/agint-event-bus-s12-05-policy.branch.mjs`、`eval/e2e/sprint4-closed-loop.js`（根目录推导）
- `plugins/agint-quality-sdk/lib/check-all.js`（真缺陷 1）
- `plugins/agint-self-model/lib/storage.js`（真缺陷 2）
- `plugins/agint-quality/agint-quality-eval/test/smoke.mjs`（URL 修复）
