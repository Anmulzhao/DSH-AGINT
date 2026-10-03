# Changelog — agint-evolution-memory

## 0.6.11 (2026-10-04) — ledger-anchor 锚点写盘根支持 config.repoRoot

### 症状
cron `ledger-anchor` 在部署位实跑（重启后，服务接线已通）抛
`ENOENT ... \.agint-bundle\docs\evolution-ledger-anchor.md.tmp-*`。

### 根因
`lib/ledger-anchor.js` 的默认 `REPO_ROOT` 从模块文件位置退三级。全仓 checkout 里成立；
部署位（`.agint-bundle/plugins/...`）退出来指向 bundle 根——那里没有 `docs/`。
构造点（`lib/index.js` createLedgerAnchorService）此前不传 repoRoot/anchorFile。

### 修法
`apply(ctx, config)` 接第二参数；`config.repoRoot` 在场时同时注入
`repoRoot` 与 `anchorFile = <repoRoot>/docs/evolution-ledger-anchor.md`。
缺省仍走模块默认（开发直跑不变）。本机值走 HOME cordis override（与 cron/driver
同值同机制，⛔ 不入库；麒麟机须自配，否则同样 ENOENT 出声）。
`test/` 全量 180/180 绿（anchor 相关测试本就显式注入 anchorFile/repoRoot，
本修法与测试形状一致）。

## 0.6.10 (2026-10-03) — `prediction_outcomes` 接第二把尺子（R2 技能门禁）

### 变更

- `OUTCOME_METHODS` 加 `SKILL_GATE_PAIR_RUN`（原 `TEST_CORPUS_PAIR_RUN` 保留）。
  值必须与 driver `outcome-measurer.js` 的 `OUTCOME_METHOD` 一字不差 —— 那边是生产者，这里是 zod 硬门。
- `evidence` 加 `entryTargetMetric`（nullable，缺省 null）：技能条目链上写的是 `'unspecified'`，
  而门禁集按构造产出通过率 ⇒ 记录 `targetMetric` 写 `SUCCESS_RATE`。
  没有这一栏，读的人只看见"指标被改过"，看不见依据。
- `testFiles` 注释改语义：它是**触达面文件**（R1′ 填测试文件，R2 填 `[SKILL.md, .cases.json]`），
  `.min(1)` 与"空数组到不了这里 = 覆盖门先拦"这条都没变。

### 未变（有意）

- **descriptor.version 保持 1**：加表/加字段不升版本，严格相等校验会把整个域锁在门外（`lib/index.js:51-73` 取证注释）。
- 同 `contractId` 不可覆盖、超限只 warn 不 prune、⛔ 不存 `NO_EVIDENCE` 行 —— 三条都没动。

### 测试

- 新增 T11：`SKILL_GATE_PAIR_RUN` 被接受、`entryTargetMetric` 缺省补 null 且传入值留得住、
  method 拼错被 zod 拦下且表里不留半成品。套件 176 绿（原 175 + 1）。

## 0.6.9 (2026-10-03) — 新增 `prediction_outcomes` 表（Phase 1.1 支点 1b / R1′）

### 新增

- `lib/schema.js`：`predictionOutcomeEntrySchema` + `OUTCOME_METHODS=['TEST_CORPUS_PAIR_RUN']`
  + `outcomeSideSchema`（`passed`/`failed`/`total≥1`/`passRate 0..1`）+ `LIMITS.PREDICTION_OUTCOMES = 2000`。
- `lib/index.js`：表注册 + `recordPredictionOutcome` / `getPredictionOutcome` / `listPredictionOutcomes`，
  一并挂进 `agint.evolution` 服务。**加表不升 descriptor.version**（沿用 51-73 行取证注释：
  整单元格式做严格相等校验，升版本会让整个域打不开）。

### 三条纪律

1. **同 `contractId` 不可覆盖**：已存在即抛 `prediction-outcome-already-exists`。
   可覆盖 = 事后能挑一次好看的数字重写它 —— 正是设计 §4.2.5 要拦的「反事后偏」。
2. ⛔ **不回填链**（§4.3.4 裁定「度量不回填链」）：本表不参与 Ledger 链哈希，
   用 `contractId` 与链上条目交叉引用。代价如实记录：这张表**可以合法地晚于链**，
   读侧必须能处理"有锁、有条目、还没测"。
3. **超限只 warn 不 prune**：度量记录是历史事实，删一条等于抹掉一段校准史。

字段形状的两条理由：

- `baseline` / `candidate` 都存**原始计数**不只存比率 —— 90.9% 是 10/11 还是 100/110 可信度不同。
- `restoreVerified` 必填 —— 双态对照临时换过文件，护栏没核过的那条不可信，标记必须随数据走。
- ⛔ 不存 `NO_EVIDENCE` 这类"测不到"：测不到不是度量，表里每一行都必须是一次真测量。

### 修

- `evidence` 的内层默认值改为**逐个写全**。实测（zod 4.6.5）：对象字段的 `.default({})`
  在 key 缺失时只塞 `{}`，不会把 `{}` 再送回内层 schema ⇒ 内层 `.default(null)` 不生效，
  读出来是 `undefined` 而不是 `null` —— 而这条纪律要的正是「缺失显式为 null」。

### 测试

- `test/prediction-outcomes.test.mjs`（11）：真插件起真服务，覆盖不可覆盖性、schema 拒收九种脏值、
  表间隔离（锁与实测同 key 不串表）、超限不 prune。本插件 175/175 绿。


## 0.6.8 (2026-10-03) — Phase 1 交付物 3：evolution_ledger 防篡改链 + Git 外部锚定 + 历史重建

设计依据 `Phase-1 Evidence-Based Evolution 设计方案.md` §4（v1.2），Sprint 22。

### 新增

| 文件 | 职责 |
|---|---|
| `lib/canonical.js` | 插件侧 canonical 序列化 / 量化 / `assertUtcMillisIso` / `GENESIS_PARENT_HASH`（⛔ 不 import `bin/lib/`，`bin/` 不随 bundle 部署） |
| `lib/ledger-hash.js` | `ENTRY_HASH_FIELD_ORDER`（7 字段单点定义）+ `computeEntryHash` + 批内 Merkle + roll-up 根链 + `buildProof`/`verifyProof` |
| `lib/ledger.js` | 链的**唯一写入口**：逐条同步、进程内 appendLock、CAS 复核、contractId 幂等、`markAnchored` 只回写非哈希字段 |
| `lib/ledger-anchor.js` | §4.4.2 外部锚定（宿主内跑；pathspec 提交、失败还原、⛔ 从不 push） |
| `lib/ledger-rebuild.js` | §4.3.5 历史重建：纯函数 `buildRebuildPlan` + `apply()`（时序窗口 / dry-run / <5 拒写） |
| `lib/ledger-rebuild-sources.js` | 三个证据源的只读取数器（整单元 JSON + preimage 探测，路径限定仓内） |
| `fixtures/ledger-hash-vectors.json` | S22-0 golden hash 向量（≥8 条边界形态），钉住三份 canonical 实现不漂移 |
| tools | `evolution_ledgerRebuildPlan`（只读）/ `evolution_ledgerRebuildApply`（写，缺省 dry-run） |

### 关键取舍（改这里之前先读）

- **`evolution_ledger` 以 `version: 1` 加表，不升域版本**：整单元格式是严格相等校验，
  升版 ⇒ 整个域打不开 ⇒ 202 行 evolution_log 全读不出（取证见 `lib/index.js` 注释）。
- **`anchorStatus` / `anchorSeq` / `integrity` / `reconstructed` / `evidenceCompleteness`
  不参与 entryHash**（v1.2 勘误 #8）：否则锚定回写那一刻条目自证为被篡改。
- **⛔ 不重建 Contract / contract_locks**：`hypothesisLock` 证明的是"预测先于执行"，
  今天补算一份写去 9 月就是伪造证据。重建条目 `contractHash` / `lockEventId` 恒 null。
- **证据取不到即拒绝该条**，不补默认值。生产实测：可重建 6 条（全 FULL）+ 拒 1 条
  （`NO_VARIANT_ROW`，09-27 validate 阶段被拒的那条从未生成变体）。
- **`log-buffer.js` 顺手修了两个"进程被空挂定时器拖住"的 bug**：
  ① `node:timers/promises` 的 `setTimeout` 返回 Promise，`clearTimeout` 对它为空操作
  ⇒ 定时器根本撤不掉；改用 `node:timers`（返回 Timeout 句柄）。
  ② flush 完成后不撤销那条定时器 ⇒ 缓冲已空却还在空等 `flushMs`。现在 flush 即撤、
  下次 enqueue 重新 arm，并加 `_hasTimer()` + 一条断言把这个不变量钉住。
  实测：`test/smoke.mjs` 60233ms → 314ms，`test/log-buffer.test.mjs` 60461ms → 578ms。
  （这不是性能优化：60s 挂在 `check-wiring` 的查 I smoke 超时上，会让门禁恒红。）

### Tests

`test/ledger-vectors.test.mjs` / `ledger-canonical.test.mjs` / `ledger-service.test.mjs` /
`ledger-proof.test.mjs` / `ledger-anchor.test.mjs` / `ledger-rebuild.test.mjs` /
`domain-race.test.mjs` + `bin/verify-ledger-chain.test.mjs` /
`bin/rebuild-ledger-history.test.mjs`。端到端一条：真 fixture 文件 → 重建 6 条 → 落盘 →
**独立校验器**（`bin/verify-ledger-chain.mjs`，不 import 插件）判 `seq 1-6, no gap`。

**§4.6 逐项核账补测（同日，2026-10-03）**：核账时发现 **#4c 只有承诺没有测试** ——
§7.1 写「测试副本上伪造一行锚点并 commit → `--anchors` 必须抓出」，而 `--anchors` 此前
只测了"文件未入库 ⇒ 失败"一条（因为临时目录不在 `REPO_ROOT` 的 git 历史里）。
判据代码本身四道齐全（行数单调 / 新增行对链重放 / commit 链连续 / 旧行逐字段回比），缺的是绑定它的测试。
补法：把校验器**复制进临时 git 仓**（`bin/` + `bin/lib/canonical-json.mjs`），
REPO_ROOT 就成了这座仓 ⇒ 跑的是同一份生产代码路径，不是复刻逻辑。加 5 case：
正例逐 commit 两行 exit 0（证明重放不是误报机器）、伪造行 ⇒ `ANCHOR_ROW_UNREPLAYABLE`、
**重写已提交的历史行 ⇒ `ANCHOR_ROW_REWRITTEN`，并断言同一份字节在 `--anchor`（只看工作区最新行）下恒绿**
—— 这句就是「v1.0 的 git blame 方案在此恒绿」的可执行对照、删行 ⇒ `ANCHOR_ROWS_SHRANK`、
一次塞两行 ⇒ `ANCHOR_ROWS_JUMPED`。该文件 19 → 24 case。
顺带记下一条**判据实测修正**：#5b 原写"删 head ⇒ head 单调性检查失败"，实跑是
纯链内察觉不到尾部删除（存量仍是各自追加时的前缀值，自洽），校验器只输出
`TAIL_TRUNCATION_UNCHECKABLE` 这条 note；抓它必须靠 git 锚点的计数与摘要比对。
逐项结论与运行态取证（ledger 未进运行槽、cron 未部署、链上 0 条、锚点 0 行、
`evolution.ledger.anchored` 生产 0 事件）写在设计文档 §4.6「验收执行记录」。

## 0.6.7 (2026-09-25) — A1 T2 切换：事件路径标记权威（本边无直连可切）

### Changed

- **A1 `evolution.proposed`：T1 影子期 → T2 权威路径**（实为「摘影子帽」，不是切流量 —— 见下）。
- 新增 tag **`t2:authoritative`**，让「本边由事件路径唯一供给」在数据上可查（不只是注释里写着）。

### 为什么是「标记权威」而不是「切换流量」

生产取证（`evolution_log` 170 行）：`stage:proposed` 行**仅 2 条，且 100% 带 `event-bus` 标签**
⇒ **不存在任何直连写入的提案阶段记录**。上层 `evo.logPhase4()` 写的是 Phase 4 **决策**记录
（decision 枚举四值），与本 handler 写的**提案阶段**记录是**两类不同记录，不是同一条的双写**。

⇒ **A1 自接线起流量就 100% 走事件，没有直连可切。** 所谓「影子」是历史命名遗留：
本边从来没有直连对照物，`shadowCoverage` 在此边上的真实语义是「事件 → 落库率」，
**不是**「影子 vs 直连一致率」。

### ⛔ tag 兼容性（改动前必看，双向 grep 已确认消费方）

| tag | 消费方 | 处置 |
|---|---|---|
| `event-bus` | `bin/t2-reconcile.mjs:141` `isShadow` 判定 | **保留**（移除即对账失效） |
| `shadow-ingest` | `eval/scenarios/driver.js:280` 主 driver 断言 | **保留**（名字已与语义不符，移除即破门禁） |
| `stage:proposed` | 本插件单测断言 | 保留 |

新增 `t2:authoritative`：消费方只做 `includes` 判定，追加 tag 安全。

### Tests

- `test/shadow-ingest.test.mjs` 6 → **8 pass**（新增 2 条）：
  ① 事件路径须标记 `t2:authoritative`；② 对账依赖的旧 tag 不得移除（锁住上表兼容性）。
- `domain-race` 4/4、`log-buffer` 9/9 无回归。
- `test/smoke.mjs` 13/13 绿（第 14 项挂起为**既有问题**，stash 对照验证：改动前同样挂起，与本改动无关）。

---

## 0.6.6 (2026-09-07) — 影子订阅写入契约修复（fix f9d8550b）

### Fixed

- **`lib/index.js`** 影子订阅 handler：`logPhase4Buffered` 调用里 `decision: 'PROPOSED'` 与 `targetKind: 'evolution.proposed:*'` 都不在 `evolutionLogEntrySchema` 的枚举里（decision 只允许 `AUTO_DEPLOY/PENDING_REVIEW/REJECT/ABSTAIN`；targetKind 只允许 `plugin/skill/preset/composite`）。每次事件到达都被 zod 拒绝，又被空 catch 吞掉 → `evolution_log` 从写下那天起一直为 0 条。
  - 改为枚举内取值：`decision='PENDING_REVIEW'`、`targetKind='plugin'`。
  - "提案阶段"语义改用 tags 保留：`stage:proposed`、`kind:<kind>`、`origin:<origin>`。
- **失败必须暴露**（对齐 AGENTS.md 哲学：失败要暴露，不要静默）：handler 缺字段与写入抛错两种情形都走 `ctx.logger.warn`，不再空 catch 静默吞。
- **订阅取值兼容**：同时支持 `ctx.get('agint.eventBus.subscribe')`（子键）与 `ctx.get('agint.eventBus')?.subscribe`（namespace）两种 host 形态，并就绪失败 warn。

### Added

- **`test/shadow-ingest.test.mjs`**（纯静态契约回归，6 个 case）：锁定 `decision / targetKind` 必落在 schema 枚举、tags 必须保留 origin/kind/stage、handler 内不得出现空 catch、订阅取值必须兼容两种形态。本测试不依赖 zod/storage-domain，可在无 node_modules 的仓库侧直接 `node --test` 跑。

### Compatible

- `lib/index.js` Service 签名 11 个方法保持向后兼容。
- `manifest.json` `optionalInject` 仍为 `["agint.eventBus"]`（与 sibling 一致）。

## 0.6.5 (2026-09-04) — Batch 2.1 preset tools

## 0.6.5 (2026-09-04) — Batch 2.1 preset tools

### Added

- **`lib/tools.js`**（preset-scoped model tools，168 行）：
  - 11 个 model-visible 工具：`evolution_logPhase4` / `evolution_logPhase4Buffered` / `evolution_readLogRangeMerged` / `evolution_flushLogBufferNow` / `evolution_addFailure` / `evolution_addSuccess` / `evolution_queryFailures` / `evolution_queryTemplates` / `evolution_getLogRange` / `evolution_decayScanRun` / `evolution_stats`
  - K19 兜底：所有 `execute` 走 `JSON.parse(JSON.stringify(s))` 防止 dsh-tools lossless-JSON 校验拒
  - 全部 output schema `additionalProperties: true`（per K19 教训）
- **5 个 write 工具 ask gate**（按老板 2026-09-04 决策）：
  - `evolution_logPhase4` / `evolution_logPhase4Buffered` / `evolution_addFailure` / `evolution_addSuccess` / `evolution_flushLogBufferNow` 走 rule_check ask gate
  - `evolution_decayScanRun` 走 L1-L4 衰减（不入 ask gate，独立兜底）
- **`test/smoke.mjs`** 改写：内联原 `log-buffer.test.mjs` 的 9 个单测契约 + tools.js 注册 11 工具 + dim5.5 跨平台 fixture（forward-slash ✓ + `../escape` ✓ 双覆盖）
- **`manifest.json`**：`tests.entry` 从 `test/log-buffer.test.mjs` → `test/smoke.mjs`；`version` 0.6.4 → 0.6.5
- **`package.json`**：`version` 0.3.0 → 0.6.5（与 manifest 同步）

### Compatible

- 仓 `lib/index.js` 不动（FROZEN Service 签名 11 个方法保留向后兼容）
- 原 `test/log-buffer.test.mjs` 保留作为独立单测入口（`node --test`）

## 0.6.4 (2026-08-27) — Sprint 10 #7 收口

### Added

- **EvolutionLogBuffer**（`lib/log-buffer.js`，117 行）：
  - `createLogBuffer({storage, memFallback, flushCount=10, flushMs=5000})`
  - `enqueue / flush / readMerged / shutdown` 4 个方法
  - 计数 ≥10 / 时间 ≥5s 触发同步落盘
  - 退出钩子：ctx.effect() disposer 强制 flush
  - 失败兜底：写 agint.memory 一条 `buffer-lost:<count>`
- **3 个新 Service**（extend 不破 FROZEN）：
  - `logPhase4Buffered({...}) → { queued: true, id }`（异步路径）
  - `readLogRangeMerged(opts) → Entry[]`（buffer + storage 合并视图）
  - `flushLogBufferNow() → { flushed, lost }`
- **9 个新单测**（`test/log-buffer.test.mjs`）：覆盖计数触发 / 时间触发 / 失败兜底 / readMerged 去重 / 子串过滤 / shutdown 强制 / 真实 plugin 路径 / 参数校验

### Compatibility

- logPhase4 旧同步路径 FROZEN 不动（向后兼容）
- 不引用 quality-contract FROZEN 接口
- 不挂顶层 cordis.patch.yml（本 Sprint 仅仓库发版）

## 0.3 — Sprint 2/3 落地（独立 plugin）

- 物理隔离的进化记忆存储域 + 三表 + L1-L4 衰减 + 100/50 上限
- 与 agint-memory 不同 storage domain