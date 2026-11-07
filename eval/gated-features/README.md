# 受控功能接线契约（B1 / B2 / C2）

> 2026-11-07 老板就「把功能都打开」选择 **「实现功能但守住闸门」**；随后指示
> **「开始接线，大胆一些」** ⇒ 本批把三项功能**接到真实对象**上，并跑通端到端演练。
> ⛔ 本文是工程契约，不是 `docs/specs/` 规范（避免孤儿规范门禁），也不改纲领一个字。
>
> **一句话边界**：链路全部连通、隔离域真写入已验证；**生产写入仍恒为 0**。
> 打开的始终是「功能可用」，不是「写入许可」，更不是「判定权」。

## 1. 两批各自做了什么

| 批次 | 代码位置 | 已实现 | ⛔ 刻意未做 |
| --- | --- | --- | --- |
| 第一批：纯函数模块 | `bin/oracle-prescription-delivery.mjs`、`oracle-calibration-replay.mjs`、`oracle-judge-channel.mjs` | 五闸信封、56 组公式自检回放、notes-only judge 契约 | 不挂 cordis、不注册 cron、不建域、不提供默认 sink |
| **第二批：接线（本批）** | `bin/oracle-runtime-sources.mjs`、`oracle-runtime-sinks.mjs`、`oracle-runtime.mjs` | 真实 storages/冻结集只读接入、**接 evolve/curriculum 插件 lib 的真 sink**（走 zod spec）、端到端编排器、隔离域演练与回读验证、G5 否决/撤销窗口自省 | ⛔ 不注入生产 sink、不设生产开关、不填标注、不冻结标签、不改评分常量、不调 LLM、不挂 cordis |

`oracle-prescription-delivery.mjs` 本批补了 `evaluateDeliveryAsync()`：真 sink 走插件 lib 的
`propose()`/`generate()` 是**异步写穿**，同步版不 await 会出现「返回 writes=1 但磁盘没落」的假象。
异步版同时把 sink 抛错 / `ok!=true` 判成 `SINK_ERROR` / `SINK_REJECTED`，`writes` 恒 0，绝不假装成功。
原同步版与 31 例既有阴性对照保持不变。

## 2. 本批取证纠正的两个数据结论（⛔ 别再沿用旧说法）

1. **`oracle_broadcasts.weekly.proposals` 是数字不是数组**。7 周实测 `[0,1,2,2,2,0,0]`、合计 **7**；
   之前用 `Array.isArray()` 判成了「0 条回流」，并由此误说「神谕层历史上根本没回流过处方」—— **错**。
   真实情况是 10-05～10-26 回流过 7 条，最近两周（11-02、11-06）断了。
2. **evolve 的真实表名是 `proposal`，不是 `evolve_proposals`**。oracle 源 7 条，状态全是 `applied`。
   广播计数 7 与 evolve 条数 7 交叉对拍一致，已做进 `--status`。

**由此得到的硬结论**：历史 7 条处方**全部缺** `predictedDelta` / `predictedDeltaSource`，且外部锚
（冻结标签）为 0 ⇒ 满足受控投递契约的候选 **0 条**。也就是说旧回流是「改尺子」型提案，
没有可证伪预测、没有外部真值 —— 这正是诊断报告里 Goodhart / 自我参照循环的**真实数据证据**，
不是推断。新通道因此**拒收**它们，而不是把旧提案换个包装重新投一遍。

## 3. 接线的样子（命令）

```bash
export PATH=/home/kylin/.nvm/versions/node/v24.21.0/bin:$PATH
export DSH_HOME=/home/kylin/projects/DSH/AGINT-data
export TMPDIR=/home/kylin/projects/DSH/.test-tmp   # ⛔ /tmp 是 10M tmpfs，全量测试会 ENOSPC
S=$DSH_HOME/storages

node bin/oracle-runtime.mjs --storages "$S" --status     # 接线自省 + 真实读数 + 缺什么
node bin/oracle-runtime.mjs --storages "$S"              # 默认 dry-run：零写入
node bin/oracle-runtime.mjs --storages "$S" --rehearse   # 隔离域真写入 + 回读验证
```

`--rehearse` 实测（2026-11-07）：`DELIVERED_PROPOSED`、隔离域写入 **1 条** `status=proposed`
提案、回读验证 **1 条**；`writesToProduction=0`、冻结集 / 评分常量 / 人工标注 / LLM 全 0。
演练用的 `SYNTHETIC_ANCHOR` 只存在于内存信封，明确标 `synthetic:true`，**不写任何冻结集**。
单测里用 sha256 逐字节对拍了演练前后的生产 `agint_evolve.json`、`agint_aesthetic_oracle.json`
与三份 `sets/*.json`，全部不变。

## 4. 生产写入为何仍是 0（五重保证）

1. **开关**：`AGINT_ORACLE_AUTONOMOUS_WRITE` 未设为字面量 `on` ⇒ G1 必拒（`readSwitch` 不认 `ON`/`1`/`true`）。
2. **外部锚定**：`labelAuthority` 只认 `GOLD`/`HELDOUT`；`SILVER`/`UNSET` 拒。三份冻结集 `samples: []`
   ⇒ 0 条真值，**G2 必拒**；`--status` 显示 `labelAuthority=UNSET`。
3. **处方契约**：真实历史处方 0 条满足契约 ⇒ 构造不出合法信封 ⇒ `NO_ENVELOPE`，连五闸都不必走。
4. **默认 sink 是 dry-run**：`executeRuntimePlan()` 不注入 sink 时只把信封记进内存，`writes=0`。
5. **演练域硬判据**：`assertRehearsalRoot()` 拒绝等于/位于生产 storages 的根；未显式 `approve`
   一律拒绝构造真 sink，且**不自动创建目录**。本 CLI 永不置 `approve=true`。
   真 sink 只能通过 `makeEvolveSink()` / `makeCurriculumSink()` 显式指向隔离域。

G5 撤销窗口 24h 与 `--veto`（`humanVeto=true`）已接进编排器：即便其它四闸全过，
人一否决立即 `DEFAULT_DENY`、零写入。

## 5. 生产接线仍缺什么（**只差真值与人工批准**）

机械部分已全部就位；下列前置**必须由人备齐**，我绝不代填：

- `eval/capability-baseline/sets/{gold,verify,heldout}.json` 由**授权人工**冻结标签，`verifyBaseline()` 判 `READY`；
- 6 周 `humanVerdict` / `humanOverall` 标注由人填完（阈值 ≥4 周、权重 ≥5 周），并解决 `redundancy`/`bloat` 的 `unidentifiable`；
- 带 `predictedDelta` + `predictedDeltaSource` 的真实处方（现有 7 条历史提案都不带）；
- C1 阶段 2/3 的 D1–D5 拍板，独立 preset / 独立会话建立；
- `AGINT_ORACLE_AUTONOMOUS_WRITE=on` 由人显式开启，G5 撤销与人工否决在面板可达；
- 把 `sink` 注入运行时、指向**生产** storages 并单独评审、单独发版。

⛔ 接线时 `sink` 必须走既有面板路由或插件 lib（本批已实现），禁止直写 storages JSON、
禁止直改评分常量 / prompt / rules（五闸 G3）。投递的只能是 `status=proposed` 候选，
evolve 提案显式 `autoExecutable:false` ⇒ 不进自动执行队列；执行仍走既有驱动与人工审批
（纲领附二 R1/R3「投递 ≠ 修改」）。

## 6. 红线（任何后续批次不得越过）

- ⛔ 不替人填 `humanVerdict` / `humanOverall`，不伪造冻结标签，不拿 0 冒充「没测过」。
- ⛔ 不让 `aesthetic_score` 或任何分数字段进入五闸输入、处方信封、judge 信封（Goodhart / 纲领 §8 例二）。
- ⛔ 不放宽 §5.4 两条语义公理、§7.2 人类最终决策点、§9.5 评分链路永久零 LLM。
- ⛔ 跨 `scaleHash` 的分数不可直接比较；回放 Δ 不是「进化变好/变差」，更不是能力结论。
- ⛔ `bin/next-batch-readiness.mjs` 的 `READY` 判定**不因代码或接线就位而变化**；
  `implementation.available=true` 只说明模块存在，`overall` 仍由硬前置决定。
- ⛔ 演练合成真值永不落冻结集；隔离域演练永不指向生产 storages。

## 7. 可复跑验收

```bash
node --test bin/oracle-runtime.test.mjs \
            bin/oracle-prescription-delivery.test.mjs \
            bin/oracle-calibration-replay.test.mjs \
            bin/oracle-judge-channel.test.mjs \
            bin/next-batch-readiness.test.mjs        # 60/60
node bin/next-batch-readiness.mjs --storages "$S" --sets eval/capability-baseline/sets
```

最后一条应仍为 `ALL_BLOCKED` —— **这是设计结果，不是故障**：代码与接线都齐了，
但真值、标注、拍板、开关四样仍需人给。
