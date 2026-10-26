# agint-evolve CHANGELOG

## v0.9.0（2026-10-27 · `approved` 补 `blocker` / `unblockCondition`：批准 ≠ 现在能做）

### 新增

- `proposalSchema` 增两个可选字段：`blocker`（卡在什么上）、`unblockCondition`（等什么满足）。
- 导出 `normalizeProposal()` / `proposalBlocked()`：判据单一事实源，读出口统一归一。
  ⛔ 字段缺席（加字段前的历史行）与空串在展示口径上等价，但这个等价只在归一函数里做一次。
- `listProposals({ blocked })`：`true` 只挑「批准了但动不了手」的，`false` 反之。
- `setStatus(id, status, note, { blocker, unblockCondition })`：显式传字符串才改，
  不传=冻结原值（否则改状态会把上次写的阻塞原因静默洗掉）；传 `''`=解除。
- `evolve_proposals` 输出补两字段 + `blocked` 过滤；`evolve_set_status` 补两参数。

### 为什么

- 实测反例：提案 `a85ef850`（权重真标定）2026-10-26 被人工批准，可它自己的 note 写着
  「第 3 步客观不可行」，当周周报又明确 **31/31 样本未标注、8-12 周内冻结权重常量**。
  于是它在家族面板待办里挂成一张「已批准待执行（工作单）」，催人去动手 ——
  而真动手就撞自家门禁。缺的不是状态档，是「为什么还不能做」的表达位。

### 行为变更

- `applied` 时若仍挂着 `blocker`，**不静默清空**：原阻塞原因转写进 `note`（`解除阻塞（原：…）`）。

## v0.8.0（2026-10-23 · 提案状态机补 `approved`：人工批准与落地分开记）

### 新增

- `proposalSchema.status` 增加 `approved`（已批准待执行）。五档：
  `proposed / approved / applied / rejected / wontfix`。
- `PROPOSAL_STATUSES` 与 `evolve_proposals` / `evolve_set_status` 的枚举同步。

### 为什么

- 原状态机只有「落地」「拒绝」「暂不处理」三个出口，**没有「人工同意做」这一档**。
  结果是：人工审批无处落笔 —— 要么把「点头」记成 `applied`（表说假话），
  要么什么都不记（53 条 proposed 只进不出，实测 2026-10-23）。
- `approved` 是**决定**，`applied` 是**事实**。两者混记会让「真做完」与
  「只是同意」无法区分，提案表从此不可信。

### 兼容

- **只增不改**：历史行的四个旧值全部仍合法，存储 domain 版本保持 `2`
  （无数据形状变化，不做迁移）。
- ⚠️ 部署注意：`approved` 行由旧版代码读取时会被 zod 拒绝，整个 `agint_evolve`
  域会 open 失败。**新代码必须先于新数据部署**。家族面板的写路由与 evolve 同进程，
  部署同步后重启即一致。

### 验证

- `node test/smoke.mjs`；`node --test test/path-escape-windows.test.mjs`。

## v0.7.3（2026-10-14 · Windows 路径逃逸误报修复）

### 修复

- `clean()` 的路径越界判据在 win32 恒为真 ⇒ **所有 `evolve_read` 读不到任何复盘报告**。
  判据原为 `abs.startsWith(root + '/')`，而 `resolve()` 在 Windows 返回反斜杠路径
  （`D:\...\reviews`），拼出的 `D:\...\reviews/` 与真实 `D:\...\reviews\xxx.md` 永不匹配。
  修法与 `agint-wiki` v0.4 同型：比较前把两侧都归一化成正斜杠。
- 实测症状（修复前）：`evolve_read path="2026-10-12-周复盘.md"`
  → `Error: agint-evolve: path escapes root` ⇒ 14 份复盘报告一份都读不到。

### 验证

- 新增 `test/path-escape-windows.test.mjs`（8 项）：真调生产 `readReview()` /
  `listReviews()`，含中文文件名、子目录、`../` 逃逸、多级 `../`、非 `.md`、文件不存在。
- 红绿自证：撤掉归一化 ⇒ 4 项变红；恢复 ⇒ 8/8 绿。安全不回退（`../` 仍被拒）单独覆盖。
- 全插件回归 54/54 PASS，`test/smoke.mjs` exit 0。

### 附带发现（未修，单列）

- `walk()` 在 win32 用 `relative()` 产出反斜杠分隔符，子目录报告返回
  `sub\nested.md` 而非 `sub/nested.md`。与 `clean()` 同型但独立，不影响读取
  （`clean()` 已归一化，回读能通），只影响输出形状。

### 测试基建

- 新增 `test/_stub-loader.mjs` + `test/_stub-register.mjs`：本机仓库工作树没有
  `@deepseek-ai/dsh-storage-domain`（该包只在 dsh 运行时提供），直接 `node --test`
  会 ERR_MODULE_NOT_FOUND。跑测试需
  `node --import ./test/_stub-register.mjs --test test/xxx.test.mjs`。

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
