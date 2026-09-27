# Changelog — agint-aesthetic-oracle

## 0.3.0 — 2026-09-28

美的神谕层 Day 4-5（方案 v2.3 §5 weekly）：美谕提案闭环。

### 新增

- **weekly 美谕提案**（写白名单第 3 行正式落地）：weekly 广播时从评分结果派生
  提案——可用维按**绝对扣分** top3（与 Q2 同口径；0 扣分 = 阈内，无可改进项不提），
  每条经既有 `q3Advice` 生成（纯机械动作 + **evidence 必填**），经
  `agint.evolve.propose()` 写入 agint_evolve.proposal 表（source=agint-aesthetic-oracle，
  note 带 targetId 可追溯）。纯函数 `buildWeeklyProposals` 在 broadcast.js（与渲染同测）。
- **永不 auto-apply 的三重保证**：① evolve 侧 status 硬锁 proposed（propose() 对
  input.status 直接覆盖，调用方无决定权）；② oracle 永不调 setStatus / curator_archive
  （测试断言 0 调用）；③ 提案正文自述「status 锁 proposed，永不 auto-apply」。
  设计理由：oracle 是观察者——自己动手改自己读的数 = 评分变自我实现（P0-3 观察者
  污染的对偶纪律）；且执行层（curator/规则合并）已有 D-QAF 门禁，oracle 插队 = 拆门禁。
- **审计留痕**：提案 id 清单进 weekly 审计 findings（ruleId=oracle-proposals）；
  oracle.weekly 事件 payload 带 proposals 计数；oracle_broadcasts 新增 proposals 列
  （每日落账行反映真实提交数）。
- **降级纪律**：evolve 缺席 / propose 抛错 → 广播照发 + proposalsFailed 记账
  （§6.1：任一出口失败不阻断）。daily/monthly/alert 不提提案。
- **测试**：oracle.test.js 22→25 例（buildWeeklyProposals top3/0 扣分/双必填断言、
  weekly→3 条 proposed→审计 id 清单→setStatus 0 调用、evolve 缺席与抛错降级）。
  plugin 合计 36/36 绿。

### 依赖

- 软依赖 +agint-evolve ≥0.1.0（propose() 服务；缺席降级）。

## 0.2.0 — 2026-09-27

美的神谕层 Day 2-3（方案 v2.3 §5/§6.1）：payload 合同 + dashboard 订阅 + 缓存回退。

### 新增

- **payload 合同** `lib/topics.js` + `schemas/oracle-topics.schema.yaml`：
  `oracle.daily/weekly/monthly/alert` 四 topic 的 zod 合同（三档同构 + alert
  双形态 refine）+ 人读版 yaml（对齐 event-bus 的 schema 目录惯例）。**落点依据**：
  event-bus 的 FROZEN 面只管 envelope，「payload 子 schema 由发布方插件自带独立
  演进」（event-bus.schema.yaml 第 12/64 行）⇒ 「schema 注册进 event-bus」的正确
  落地 = 发布方自带合同 + publish 前自校验，不是改 event-bus。违约 payload 不发布
  （坏数据不进事件历史），落痕 `outcome=schema-rejected`。
- **dashboard 卡片订阅**：oracle 自订阅 `oracle.*` 4 topic（subscriber=dashboard，
  async——sync 名额留给门禁边），每 topic 最新事件快照落 `oracle_cards` 表
  （key=topic）；服务新增 `cards()` 查询面。这是 AC-7/7b 的消费端证据：publish
  出去的事件必须能被真实订阅者收到并持久化。dsh web 前端是封闭内部包不可注入，
  AGINT 侧的「dashboard 订阅」= 卡片状态面 + 查询面（UI 壳未来任何通道都从这里读）。
  ⚠ 实测竞态：卡片曾写进 `oracle_state.latest` 单行，被广播主链的 quota saveState
  用旧快照覆盖——分表后各写各的 key 根治。
- **§6.1 缓存回退**：每次成功广播后把原子值快照写 `oracle_state.lastGood`
  （asOf/atomic/adviceCtx/activity/savedAt）；summary() 整体不可用时若缓存 ≤7 天
  → 用缓存评分照发（`staleDays` 标注进总分行与 payload，审计 findings 带
  `oracle-stale-cache`；回退路径不刷新缓存）。⛔ 实现依据：metrics 的 `series()`
  与 `summary()` 读同一张表——summary 挂 = series 挂，方案字面的「series 缓存」
  没有独立生存性，可回退的只有消费侧自己落盘的快照。
- **alert 通道解耦 metrics**：`runBroadcast('alert')` 直发（渲染即发），不再经过
  summary 数据面——§6.1「任一来源失败不阻断」对警报通道同样成立；且沉默 24h 的
  alert 原本就不经数据面，两条告警路径现在都不依赖 metrics。
- **运维旋钮**：config `silenceAlertAfterMs`（默认 24h 不变）——只调沉默告警的
  触发阈值，不改「连续 3 次失败进沉默」的条件；演练/测试用。
- **测试**：oracle.test.js 16→22 例（payload 合同 4 档合法/违约/无合同、出口
  payload 与合同对齐、dashboard 订阅端到端、AC-7b 沉默→alert→卡片到达、缓存回退
  命中 + 审计留痕 + 缓存不刷新、alert 解耦 metrics）。plugin 合计 33/33 绿。

### 依赖

- 软依赖不变（metrics ≥1.1.0 / evolution-memory ≥0.6.4 / event-bus ≥0.7.0）。

### 已知边界（Day 4-5 收）

- weekly 美谕提案闭环（`agint.evolve.propose()`）归 Day 4-5。
- `oracle_cards` 表的 UI 壳：dsh web 会话内经 cards() 查询呈现；独立 HTML 面板
  为方案外加分项，未实现。

## 0.1.0 — 2026-09-27

美的神谕层 Day 1（方案 v2.3 §8）：薄骨架 + daily 跑通。

### 新增

- **评分纯函数** `lib/scoring.js`：§3 v2.3 公式（噪声比剔除 REJECTED 的语义修复 /
  确信度逐条乘 compliance / 冗余度三域合并 / 臃肿度 120KB 预算）+ §3.6 N/A 权重
  归一（AC-4）+ §4 美之三问（Q1 恶化≥2→丑 / 改善≥3→美，全排序无洞；Q2 按绝对
  扣分；Q3 四条机械建议全量映射）。标定：2026-09-27 生产数据复算 52.4±0.5
  （`test/calibration-2026-09-27.mjs`，AC-0d PASS）。
- **存储域** `lib/storage.js`：`agint_aesthetic_oracle`（2 表）——`oracle_state`
  单行状态（kill-switch / 沉默模式 / 连续失败 / 配额 / 首周基线）+
  `oracle_broadcasts`（每次广播一条，含 asOf / score / 三问 / outcome，失败留痕）。
  host storageDomain 不可用时内存兜底。
- **广播纯函数** `lib/broadcast.js`：summary → 原子值抽取（activity 只信 metrics
  排除后的 logCount7d/30d，AC-4b）；daily/weekly/monthly/alert 四模板（首行 asOf
  透出，daily ≤5 行 ≤2KB，超限尾部裁行保首行）；配额周期滚动（日/周/月独立 +
  alert 独立日配额）。
- **编排入口** `lib/index.js`：`agint.aestheticOracle` 服务（runBroadcast /
  runScheduled / alert / pause / resume / getState / status / history）。
  - §6.2：runScheduled 3 次重试（1s/4s/16s），重试期只在末次发 oracle.alert；
    连续 3 次调度失败 → 沉默模式（只写审计）；沉默 24h → oracle.alert 一次。
  - §6.3：单日配额违规 ≥3 → 自动沉默 + 告警；系统总分不触发任何回滚（P0-1 不杀
    信使）；kill-switch = config `enabled:false` / env `AGINT_AESTHETIC_ORACLE=off`
    ⇒ 不 provide 服务 ⇒ cron job soft-skip（§6.4）；运行时 pause/resume 落状态表。
  - §9.1 写白名单：evolution_log（`agint.evolution.logPhase4`，targetKind=oracle-*，
    decision=ABSTAIN）+ 自有存储域；无 evidence id 清单进审计 findings（广播正文
    只引用条目，防 2KB 爆）。
  - §3.6 基线：前 7 条有效 daily 的均值（score + 四维），建立后 Δ 相对基线。
- **接入**：agint-cron 三 job（oracle-daily `0 9 * * *` / oracle-weekly
  `0 21 * * 0` / oracle-monthly `0 10 1 * *`）+ services map；cordis.patch.yml
  挂载行（mountOrder 62）。
- **测试**：`test/oracle.test.js` 17 例（AC-1/2/3/4/4b + §6.1/6.2/6.3 + 基线 +
  三档模板 + 纯函数）；plugin 合计 28/28 绿。

### 依赖

- 软依赖 agint-metrics ≥1.1.0（Day 0 扩展后的 19 key summary）、
  agint-evolution-memory ≥0.6.4（oracle-* targetKind 枚举）、agint-event-bus
  ≥0.7.0（oracle.* topic 发布，缺席降级）。

### 已知边界（Day 2-3 收）

- `oracle.*` topic 尚未在 event-bus 注册 schema（发布为软失败，published=false 可查）。
- summary 整体不可用时的 series 7 天缓存回退未实现（§6.1「可回退」项）。
- weekly 美谕提案闭环（`agint.evolve.propose()`）归 Day 4-5。
