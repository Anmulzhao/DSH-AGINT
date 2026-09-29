# agint-evolve CHANGELOG

## v0.7.2（2026-09-29 · 周报纳入外部信号章节）

### 新增

- `dataSnapshot()` 取 `agint.inputGateway` 状态（`ctx.get` 软依赖，未挂载降级 `undefined`），snapshot 增 `inputGateway` 面
- `findingsFromSnapshot()` 增两类发现：
  - `gateway.silent.<channel>`（info）：fetch ≥2 且 emitted=0 → 上游链空转提示（本轮真实证据：self-observation 长期 0 信号）
  - `gateway.security`（warn）：security 命中 / 丢弃 → 外部信号注入风险提示
- `renderSnapshotTable()` 增「外部信号与多源输入」行；`buildReport()` 新增 `## 二·A、外部信号与多源输入` 章节（网关未挂载时如实标注）

### 验证

- report.test.js +4 项外部信号用例（silent/security/章节渲染/不可用降级）；全插件测试 19/19 PASS。

**背景**：`evolution.proposed` 只有订阅方（evolution-memory / quality-eval / trajectory）、
没有生产发布方 —— 生产仅 3 条 09-04 历史探针。本插件的 propose() 才是真实提案源（生产 55 条）。

- `propose()` 落库后向 bus 发一条 `evolution.proposed`，payload 含 proposalId / kind / origin
- `source` 写 `agint-evolve`（真实发布方），原始 `source` 保留在 payload 内
- 软降级：bus 缺失或 publish 抛错只 warn，返回值与落库不受影响（直连路径完整保留）
- 新增 `test/shadow-publish.test.mjs`（4 项）

## v0.7.1 — proposal category 增加 `plugin`

**日期**：2026-09-07
**范围**：纯枚举扩充 + 数据重归类，不改任何运行时行为。

### 变更

- `proposalSchema.category` 枚举：`rule/skill/doc/preset/service/other` → 新增 `plugin`（整 cordis 模块级改动；`service` 语义收窄为"模块内单 host 服务改动"）
- `PROPOSAL_CATEGORIES` 常量、`lib/tools.js` `CATEGORIES` 同步加 `plugin`
- `evolve_propose` 工具描述、`lib/report.js` 复盘提示语、`docs/plugins/agint-evolve.md` 同步更新

### 数据迁移

- 3 条 agint-dream 升级提案（P0/P1/P2）category 重归类为 `plugin`（P0 原为 `rule`，P1/P2 原为 `service`）

## v0.7.0 — Sprint 12 B3 baseline-regression 真 cron hook

**日期**：2026-XX-XX
**范围**：storage schema v1 → v2；新增 3 个 baselineGate 系列 service；与 `agint-cron` 的 `baseline-regression-suite` job 配对。

### 新增

- **Service `agint.evolve.baselineGate(channel, opts)`**
  - 输入：`channel`（默认 `'mount'`，预留扩展）、`opts.since`（ISO，可选）
  - 输出：`{ frozen: boolean, lastRunAt: string|null, since: string|null, source: string }`
  - 副作用：只读 `baseline_history` 表；不写、不动 mutation / policy
  - 缺数据 → `{frozen:false, lastRunAt:null, since, source:'empty'}`（稳定空值语义）
- **Service `agint.evolve.recordBaselineRun(input)`**
  - 由 `agint-cron` 的 `baseline-regression-suite` job 调用
  - 写 `baseline_history` 一行：`{id: ranAt, channel, passRate, passed, total, frozen: passRate<0.95, source, ranAt}`
  - 返回写入记录的副本
- **Service `agint.evolve.listBaselineHistory(filter)`**
  - 调试 / 报告 / 测试用，按 `ranAt` 倒序列出全部行

### Storage

- domain `agint_evolve` schemaVersion：`1` → `2`
- 新增表 `baseline_history`（valueSchema: `baselineHistorySchema`，zod 校验）

### 兼容

- 所有 v0.1.0 起的 proposal / review service 行为不变
- storage domain `agint_evolve` 旧数据（仅 `proposal` 表）继续可读；新增 `baseline_history` 表初始为空

### 配对

- `plugins/agint-cron` 新增 `baseline-regression-suite` job（每周日 03:15），调 `agint.evolve.recordBaselineRun`
- `eval/scenarios/driver.js` mount dispatcher 把 `mountMocks.baselineMock.isFrozen()` 替换为 `await ctx.get('agint.evolve').baselineGate('mount')`
- `eval/run-baseline-regression.mjs` 新建：跑真 cron action、写一行 `baseline_history`、输出表格
