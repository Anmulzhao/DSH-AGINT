# Changelog — agint-upstream-watch

## [0.3.1] — 2026-10-28（提案 `846f4fbb` 单元 2）

本插件那份收紧后的 `defineTool` 替身，抽成 `plugins/_shared/test-stub-dsh-tools.mjs`
三处共用（upstream-watch / evolve / input-gateway）—— 三份各抄一份必然漂移。
`test/_stub-storage-domain.mjs` 改为转发，契约与行为逐字不变。

⛔ 契约的任何改动都要改共用那一份，并跑它的阴性对照
（`node --test plugins/_shared/test-stub-contract.test.mjs`，6/6）。

验收：`node --import ./test/_stub-register.mjs --test test/*.mjs` ⇒ 82/82 PASS；
`bin/plugin-check.sh` 0 FAIL。

## [0.3.0] — 2026-10-28

判读质量仪器：让这套东西**能自证**。设计方案 §8 的最后一期。

### 动机：没有回填，判读器永远不知道自己错过

v0.1 的立论是「结论必须由实测给出」。但实测也会错 —— 2026-10-28 那次，
基准拿了 `profiles/node_modules` 里 App 升级甩下的 `0.1.1-rc.2`，得出「45 个导出被移除」的
**全假结论**。那次是人眼发现的。下一次没人看的时候呢？

判读器会一直自信地输出，而没有任何机制告诉它（或我们）上一次是对是错。

### 新增

- **`lib/calibration.js`** —— 唯一可证伪的判据是「当时说 AGINT 用到的这些符号，
  在目标版本里还在不在」。升级发生后用**真实安装树**重算一次，两个方向对拍：

  | 当时判 | 升级后实测 | 结论 | 危害 |
  |---|---|---|---|
  | `breaking` | 符号还在 | 误报 `false-positive` | 白改代码 |
  | 非 breaking | 符号没了 | **漏报 `false-negative`** | 上线即坏 |

  ⛔ 两个方向必须一起算：只算漏报会诱导它「全都报 breaking」，只算误报会诱导它「什么都不报」。

- **`prediction` 台账**：每次判读把「包 → 当时用到的符号名 + 判定」落进 `digests` 表。
  ⛔ 必须在判读**当时**落盘 —— 之后 AGINT 的 import 面可能变，回填时要按当时口径对拍，
  现算就是另一件事了。

- **`outcomes` 表 + 自动回填**：三个时机（宿主启动 / 每次 digest 后 / 手动 `backfill()`）。
  触发条件严格：本机版本**精确等于**该判读的目标版本。装了更新版本时不回填 ——
  拿旧预测去对拍新版本，等于拿两个不同世代的结论互相印证。

- **`calibration()` 服务 + `upstream_calibration` 工具**：分别给误报率与漏报率，
  各自带**包数分母**。⛔ 不给合成「准确率」：两类错代价不对称，合成一个数就把不对称抹掉了。

- **并入 `agint-quality-eval` 0.5.0 的 effectiveness 维度**：判读类目标
  （`agint-upstream-watch`）的分数由「用量」与「判读准确率」各半构成；
  样本 <3 时不并入（1 个样本就能把分数拽到 0 或 1）。⛔ 只影响这一个 target，
  其它插件的评分一字不动（`test/effectiveness-calibration.test.mjs` 钉住）。

### 修复（这两个是本期最值钱的产出）

- **扫描根不能用 `process.cwd()` 兜底** —— 插件跑在 dsh 进程里，cwd 常是人的家目录。
  `scanDependencyFace()` 遇到不存在的目录返回空 Map，于是**依赖面恒为空、
  每个版本都判「没有包受影响」**。这是一次彻底的静默假绿，而且看起来完全正常
  （factsSummary 里只是少几项）。现在四路兜底：`AGINT_REPO_ROOT` → `AGINT_HOME` /
  `DSH_HOME`（bundle 位）→ 从自身路径向上找「有 `cordis.patch.yml` + `plugins/`」的目录 → cwd。
  扫到的根与来源记进 `facts.scanRoot` / `facts.scanSource`，`source=cwd` 时读的人能看见。

- **`digest()` 的失败结果不该进缓存**（回归测试钉住）：离线时依赖面 unknown 会触发 LLM，
  LLM 不可用 ⇒ `failed`。`failed` 若被当缓存返回，上游真出问题时我们会读到一条旧失败。
  原测试「跑两次验证幂等」其实是靠「扫不到依赖面所以不触发 LLM」才通过的 ——
  修了扫描根之后立刻暴露。现在改为预置一条 `judged` 记录验缓存，另加一条专测
  「failed 不缓存」。

### 测试

新增 `test/calibration.test.mjs` 17 条（8 处阴性对照：版本不匹配 / 找不到安装 /
接口面为空 / 只有 `~dynamic` / 零样本比率为 null / 表达式不展开 …）。
合计 **70 条全绿**（26 单测 + 18 语义 + 17 校准 + 9 apply 冒烟）。

### 没做的事

- 不判「提案该不该做」「AGINT 有没有变好」—— 那是人的判断和 quality-eval 的维度分。
- 不统计「AGINT 升级后有没有炸」：那需要运行日志归因，代理指标太弱，
  硬凑一个数只会让人以为它被验证过了。

## [0.2.0] — 2026-10-28

补设计方案 §6-2 里写明的那个缺口：**签名没变、行为变了**。

### 动机（先说这次没做的事）

v0.1 的 API 比对只回答「签名有没有变」。它会把一整类真实风险判成 `compatible`：

| 变化 | 签名 | API 面结果 | 实际后果 |
|---|---|---|---|
| `engines.node: >=22` → `>=24.9` | 没动 | `compatible` | **装不上** |
| `dependencies` 多出一个必装包 | 没动 | `compatible` | 运行时 `import` 炸 |
| `SAFETY_VETO_THRESHOLD = 0.5` → `0.6` | 没动 | `compatible`（`normalizeDecl` 为躲噪声主动剥掉了 `=` 后半段） | 判据阈值整体位移 |
| 某导出新增 `@deprecated` | 没动 | `compatible` | 下一版就没 |

这四类的共同点是**可确定性判定**，不需要模型。所以补在段 1，不丢给 LLM。

### 新增

- **`lib/semantics.js`**（零依赖，纯函数）：
  - `lowerBound(range)` — 从 semver 范围取最高下限（`>=24.9` / `^22` / `24.x` / `>=22 <25`）；
    纯上界与通配返回 `null`，不猜。
  - `diffMeta(old, new)` — 比 `engines` / `dependencies` / `peerDependencies` / `type` / `exports` 键集合。
  - `extractConstValues` + `diffConstValues` — 抓 `export declare const X = <字面量>` 的**值**变化
    （只收 number/string/boolean/数组；表达式不展开 —— 展开等于自己实现解释器）。
  - `diffDeprecations` — 新增 `@deprecated` 标记（唯一的**前置预警**：本版可用，下一版就删）。
  - `collectSemanticDeltas` — 聚合 + 严重度排序 + 剔除噪声。
  - `directImpact` — 挑出「与使用面无关、必然相关」的那两类（`engine-raised` / `module-type-changed`）。

- **`engines` 结合本机实况判「装不装得上」**（本版最有价值的一条）：
  同样一条「抬到 >=24.9」，本机 node 24.21.0 ⇒ `warn`（换机器的人受影响）；
  本机 node 22.22.2 ⇒ `blocker`（直接装不上）。**不给本机版本就只报「抬了」，不假装能判**。

- **宿主主包单列一条 `hostFace`**：AGINT 从不 `import '@deepseek-ai/dsh'`，所以它不在
  依赖面里 —— 但「装不装得上、起不起得来」全由它的 `engines` 与依赖锁决定。
  v0.1 的覆盖面里**恰好缺这一条**。
  实测 0.2.1-rc.3 → 0.2.2-alpha.2：抓出 `engines.node (unset) → >=24.9.0`（本机满足）
  与 5 个新增 bundle 依赖（`dsh-experimental-forge-bundle` / `dsh-cua-bundle` / `dsh-official-bundles` …）。

- **`overallImpact` 新增 `blocking` 档**：与 `usedImpact` 同构多一档，专表「与用没用到无关、
  但装不上」。⛔ 不折进 `breaking`：折进去会让「本包 API 完全没动、只是引擎抬了」
  在面板上显示成 API 破坏，归因就错了。

### 修复

- **宿主主包的 diff 基准拿错**（与 v0.1 的遗留副本事故同源，但不同位置）：
  `resolveInstalledPackage('@deepseek-ai/dsh')` 走「版本最大」兜底会选中
  `profiles/<p>/node_modules/@deepseek-ai/dsh`（App 升级甩下的 `0.1.1-rc.2`），
  于是 `engines` 变成「(unset) → >=24.9」这种没法处置的结论。
  现在：探测对象就是宿主主包时直接采用 `resolveDshRoot()` 的结果。

- **整包联动噪声**：dsh 是 monorepo 出片，`dependencies` 里那一堆 `@deepseek-ai/dsh-*`
  跟着整包一起抬版本号。首版实测 106 条语义差异里 83 条是这类。
  判据：范围变化的两端恰好等于**本包自身**的 `from → to` ⇒ 不报（第三方包版本不同，不会误滤）。
  实测从 106 条降到 23 条。

### 测试

`test/semantics.test.mjs` 新增 18 条（含 6 处阴性对照：无变化不报、已存在的 `@deprecated` 不重复报、
表达式不展开、任一端面为空判 `unknown` 而非 `none`、非本包跃迁的依赖变化照报）。
合计 **52 条全绿**（26 单测 + 18 语义 + 8 apply 冒烟）。

## [0.1.0] — 2026-10-28

首版。补上「AGINT 感知不到宿主在变」这个洞。

### 新增

- **两段式判读**：段 1 确定性产事实（`lib/facts.js`），段 2 LLM 产结论（`lib/judge.js`）。
  段 2 失败时事实照落、结论留空、不产提案 —— 事实与结论分离，不拿启发式冒充模型结论。
- **依赖面实测**（`lib/depface.js`）—— 本设计的立论所在：
  - 扫 `plugins/**` 得出真实依赖面**及每个包用到的导出名**
  - 拉目标版本 npm tarball（`lib/tarball.js`：`node:zlib` + 自写 tar 头解析，零依赖），
    提取 `lib/types/*.d.ts` 与 `lib/index.js`，与本机已装版本比对
  - 双字段输出：`verdict`（API 层面）与 `usedImpact`（对 AGINT 的影响）
- **`usedImpact` 四档**：`breaking` / `elsewhere` / `additive` / `unknown`。
  `elsewhere` 是新增语义 —— 「这个包 API 有删除，但都不在 AGINT 使用面上」。
  没有这一档，`dsh-tools` 删 60 个导出（0 个是 AGINT 用的）会被报成重度风险。
- **版本语义**（`lib/version.js`）：手写 semver 解析/比较（零依赖），
  外加 `preStageChange()` 单独表达「发布阶段倒退」（`rc → alpha`：版本号在涨、成熟度在退）。
- **存储域** `agint_upstream_watch`（`releases` / `digests` / `config`）。
- **Service** `agint.upstreamWatch`：`status` / `digest` / `runNow` / `listDigests`。
- **工具**：`upstream_status`（只读）、`upstream_digest`（写，产出的提案不可自动执行）。

### 设计决策（都有现场依据）

- **基准必须过版本校验**：`$DSH_HOME/profiles/node_modules/` 里可能躺着被 App 升级甩下的遗留副本
  （本机实测有 0.1.1-rc.2 的 `dsh-tools`，而运行时是 0.2.1-rc.3）。不校验就会拿旧副本当基准，
  得出「45 个导出被移除、31 个签名变化」的全假结论。现在先定位 dsh 主包，用它的版本筛候选，
  不一致时标 `baselineSuspect: true`。
- **`ref` 不参与签名比较**：同一符号可能旧版写成 `export declare const X = "..."`、
  新版写成汇总式 `export { X }`。只比文本会把这种纯形式变化报成 breaking。
- **「变宽」要按参数表判，不能用子串**：`register(def)` → `register(def, options?)` 时，
  旧串在新串里并不连续（`X)` vs `X,`），子串判定会失败 ⇒ 加个可选参数被误报成 breaking。
  改为配对括号取参数表 + 前缀比对。
- **动态 import 不算通配**：`await import('@deepseek-ai/dsh-tools')` 只是运行时探测，
  当通配会让任何删除都判成「影响 AGINT」。改记弱标记 `~dynamic`，含义如实为「使用面可能不完整」。
- **扫描器要剥注释**：首版实现把自身注释里的示例 import（`from '@deepseek-ai/x'`）
  当成了真实依赖，凭空多出一个不存在的包。现在按行首滤掉注释行。

### 边界

- 不装、不升 dsh（AGENTS.md 红线）；所有提案 `autoExecutable: false`。
- 下载失败/定位失败一律 `unknown`，不退化成 `compatible`。
- 只比类型定义与导出名，**不覆盖运行时语义变化**（已知缺口，见 README §已知限制）。

### 验收

- 单测 26 条全绿（`node --test test/upstream-watch.test.mjs`），含 8 处阴性对照。
- 真实数据实测（2026-10-28，本机 dsh 0.2.1-rc.3 → 目标 0.2.2-alpha.2）：
  - `dsh-tools`：`verdict=breaking`（删 60 个导出）/ **`usedImpact=elsewhere`**（都不在使用面）
  - `dsh-storage-domain`：`additive`（仅 `KvTable.deleteMany` 新增）
  - `dsh-schedule`：`additive`
  与人工逐项核对的结论一致。
