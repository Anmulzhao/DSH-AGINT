# Changelog — agint-upstream-watch

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
