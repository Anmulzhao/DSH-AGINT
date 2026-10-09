# Changelog — agint-aesthetic-oracle

## 0.5.0 — 2026-10-09

评分公式 r2：三处度量学修复（提案 f51d3280，源码复审发现）。

### 变更

1. **bloat 扣分加上界**：`30 × min(max(0, b−1), 1.5)`，饱和于 2.5 倍预算。
   旧公式无界线性（b=4 扣 90 → 总分 10，b=6 → 总分 −50）；bloat 是四维中
   唯一无界罚（noise/redundancy 均 min(...,1) 饱和），技能只增不减的库里
   臃肿度长期单调上升，无界罚迟早爆且以绝对优势碾压 Q2 归因。
2. **Q1 效应量门槛**：`EFFECT_EPSILON`（各维阈值的 10%），|Δ| 低于门槛的
   维视为持平不计入恶化/改善。旧公式 4 位小数非零即计数，噪声比 0.0405→
   0.0406 算「恶化一维」，日频指标天然抖动让 Q1 在「持平/变丑」间随机翻转。
3. **Q2 / weekly 提案排序改 ratio**：`deduction/maxWeight`（偏离度），不再按
   绝对扣分。旧口径下 noise/bloat（权重 30）天然压过 confidence/redundancy
   （权重 20）——归因被权重差绑架。标定数据上最丑从 noise 换成 redundancy
   （ratio 1.0 > 0.77），weekly 提案 top3 选择同口径修正。
4. **payload 透传 `formulaVersion`**（合同字段，optional）：版本切换前后的
   总分不可直接比，历史趋势分段解读。

### 口径影响

- 总分与 Q2 归因在 r1→r2 间不连续；已发布事件无 formulaVersion 字段
  （视同 r1）。标定复算 52.4 不受影响（该样本 bloat 未超预算扣 0）。
- 测试 56 例全绿（新增 bloat 饱和 ×2 断言、Q1 门槛 ×3 断言、payload
  formulaVersion 透传断言；更新 Q2 口径断言 ×2）。

## 0.4.3 — 2026-10-05

可观测性补全：`mode` 与 LLM 降级 reason 进审计 findings。

### 背景

0.4.2 排障时暴露缺口：`evolution_log` 的 oracle 记录里没有 `mode`，降级 reason
只活在 `l1EnhanceAdvice` 的返回值里、随即被丢弃。判断某天的 daily 是否走了 LLM，
只能靠广播墙钟（`wall 10780ms` 对 10 秒上限）反推。

### 变更

- **新增审计 finding `oracle-llm-mode`**（lib/index.js `finalizeBroadcast`）：每条广播
  都记 `mode=template|llm|heuristic-degraded`；发生降级时追加
  `| 降级 L1:<reason>; L2:<reason>; L3:<reason>`（同 level+reason 去重）。
- **降级 reason 收集**：L1 / L2 在 `runBroadcast` 收进 `llmDiag`；L3 由
  `submitWeeklyProposals` 新增返回 `l3Degradations`（lib/index.js）。

### 测试

- oracle.test.js +2：LLM 通路不可用时 finding 含 `mode=heuristic-degraded` 与
  `L1:agents unavailable`；kill-switch `off` 时 finding 恰为 `mode=template`。

## 0.4.2 — 2026-10-05

L1 措辞增强超时由 10 秒提到 60 秒。

### 根因

2026-10-05 两次 daily 广播的墙钟都越过 L1 的 10 秒上限，`report.mode` 落 `heuristic-degraded`：

- 09:00 定时那次 `wall 10780ms`（广播记录 `0aee1431-cbe3-4885-8871-8067755ee5f0`）
- 18:30 复现那次 `wall 11089ms`（广播记录 `84ce8ff8-8e6f-49dd-b503-62f0f40977b4`）

两次差值（780ms / 1089ms）是非 LLM 部分耗时。同机同进程的 weekly 广播 `mode=llm` 成功，
排除服务缺失与 kill-switch 关闭。超时信号覆盖会话创建与模型推理两段
（lib/llm-enhance.js:101-116），本次没区分是哪一段；降级 reason 此前不进任何持久层
（lib/index.js:291-296 的 findings 不含 mode 与 reason）。

### 变更

- **L1_TIMEOUT_MS 10_000 → 60_000**（lib/llm-enhance.js:41）。与 L2/L3 一致，
  也对齐同文件 :40 注释里「对齐 dream 的 DEFAULT_TIMEOUT_MS = 60_000」的既有意图。
- lib/index.js:489 注释同步：「短超时」→「60s 超时」。

### 影响

降级只丢措辞润色，广播的判断与数字不变。daily 广播的最坏墙钟上限从约 11 秒变为约 61 秒；
daily 走 cron，不影响交互路径。

## 0.4.1 — 2026-09-29

§4 真实关修复：Q3 建议必须绑定真实 lint 证据，查不到就输出「本日无可执行建议」，不许兜底编一句。
（2026-09-29 老板实测抓包：rule_lint 0 命中时 redundancy 建议仍编「合并 rule_lint 命中的 duplicate
规则」，且方向反了——当天 redundancy 分子 3/55 全由 3 处 wiki 矛盾构成。）

### 修复

- **q3Advice 证据绑定**（lib/scoring.js）：redundancy 分支按序查证——rule_lint duplicate 明细 →
  wiki 矛盾文件清单 → curator 重叠 → 全空回 `NO_ADVICE`（「本日无可执行建议」）；noise 分支同构
  （无证据记忆 → wiki 孤儿 → NO_ADVICE）；confidence 无行级清单、bloat 未超预算均回 NO_ADVICE。
- **adviceCtx 补齐真实清单**（lib/broadcast.js extractAtomic）：透传 `wiki.contradictions` 的
  meta.files（wikiContradictionFiles / wikiContradictionCount）与 `wiki.orphans` 的 meta.files
  （wikiOrphanFiles）——此前 adviceCtx 只有 ruleLintIssues，q3Advice 想指对方向也没料可用。
- **redundancy 建议方向修正**：redundancy 最丑且 rule_lint 0 命中时，建议指向 wiki 矛盾
  （真实分子），不再编 duplicate 建议。
- **L1 措辞增强闸门**（lib/index.js）：advice === NO_ADVICE 时跳过 LLM 润色——不给模型把
  「没有建议」润色成编造建议的机会。
- **weekly 提案**（lib/broadcast.js buildWeeklyProposals）：q3Advice 回 NO_ADVICE 的维直接跳过
  （「本日无可执行建议」不是提案正文）。受此影响，confidence 维在 metrics 不提供行级清单时
  不再出提案（旧逻辑该维一直在编「定向复核…」空壳建议）。

### 测试

- scoring.test.js：Q3 测试改为按维供证据（四条映射齐全）；新增 3 例——redundancy→wiki 矛盾
  回归、全零分子→NO_ADVICE、noise→孤儿。
- oracle.test.js：新增 extractAtomic 透传断言 + daily 链路回归（2026-09-29 生产实况：
  worst=redundancy、score=58、建议=解决 wiki 矛盾、不出现「合并 rule_lint」）；weekly 提案
  期望 3→2（confidence 无证据跳过）。
- 全量 51 pass / 0 fail。

## 0.4.0 — 2026-09-29

LLM 增强档（方案 v2.4 §8.1）：神谕层接入 LLM 子代理，三级增强。

### 新增

- **lib/llm-enhance.js**：kill-switch 解析（env AGINT_AESTHETIC_ORACLE_LLM = off/l1/l1l2/all，默认 all）、
  spawnOracleLlm 封装（照 agint-evolution-driver 范式：agents.create + subagents.start，
  meta.agentPreset='agint'，label='oracle-llm'）、L1 措辞增强、L2 行级深挖、L3 提案润色。
  所有失败降级不 throw。
- **L1 措辞增强**（daily/weekly）：广播渲染后，worst 维度的建议/证据行由 LLM 重写为自然语言。
- **L2 行级深挖**（weekly）：对 worstKey 做行级根因分析，结果存 view 供 L3 消费。
- **L3 提案润色**（weekly）：submitWeeklyProposals 里提案 body 经 LLM 润色。
- **payload mode 字段**：template / llm / heuristic-degraded，标记本轮广播实际走了哪条路径。
  topics.js tieredShape 加 mode: z.enum([...]).default('template')。
- **manifest.json**：版本 0.4.0，加 env 权限 AGINT_AESTHETIC_ORACLE_LLM。

### 修复

- mode 兜底假信号：worst 为空时 L1 不触发，原兜底误标 heuristic-degraded（实际没调 LLM），
  改为 eport.mode ?? 'template'——heuristic-degraded 仅在 L1 真尝试但失败时设置。

### 测试

- 	est/llm-enhance.test.js：11 个测试覆盖 AC-16/17/18/18b/20（kill-switch、spawn、L1/L2/L3、降级路径）。
- 全量 47 pass / 0 fail。

### 已验证

- 浏览器会话手动触发 daily broadcast：mode="llm"，建议行被自然语言重写，eventBus 出现 oracle-llm- 子会话。
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
