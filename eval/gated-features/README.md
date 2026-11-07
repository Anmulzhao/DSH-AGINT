# 受控功能接线契约（B1 / B2 / C2）

> 2026-11-07 老板就「把功能都打开」选择 **「实现功能但守住闸门」**；随后指示
> **「开始接线，大胆一些」** ⇒ 本批把三项功能**接到真实对象**上，并跑通端到端演练。
> ⛔ 本文是工程契约，不是 `docs/specs/` 规范（避免孤儿规范门禁），也不改纲领一个字。
>
> **一句话边界**：链路全部连通、隔离域真写入已验证；**生产写入仍恒为 0**。
> 打开的始终是「功能可用」，不是「写入许可」，更不是「判定权」。
>
> **2026-11-07 第三批「让链路真正亮起来」**：链路已接进**真实运行节奏**（系统 cron 每小时心跳），
> G1 在心跳进程内显式打开，五闸逐闸求值并留审计台账。⛔ 这不等于放行投递：默认配置仍
> `OFF`、默认 sink 仍 dry-run、生产写入仍 0。详见第 8 节。
>
> **2026-11-07 第四批「授权让最后一盏灯亮起来」**：G4 与 G2 解耦（真实可证伪预测独立求值），
> 生产投递分支落地但 fail-closed，金标做成模板/校验/密封就绪包。实测五闸 **4/5，
> 只剩 `G2_external_anchor`**。⛔ 由系统自己出题、跑分、署名会让「外部锚定」退化成
> 「系统自证」⇒ 本批**不代填金标、不代签、不擅自置 approve=true**；生产写入仍恒 0。
> 评审材料见同目录 `生产投递评审单.md` 与 `D1-D5拍板建议单.md`，详见第 9 节。
>
> **2026-11-08 第五批「剩下的两步」**：G2 已由**委托机械真值**点亮，实测五闸 **5/5**、
> `verifyBaseline=READY` / 17 条可用冻结标签。⚠ 但这是「运营者授权 · agent 执行 ·
> **非人类验证**」，语义已降级（`humanValidated:false`），⛔ 不表示人工金标、
> 不得据此宣称 AGINT 能力。生产投递评审现场确认**服务窗口不成立** ⇒
> 判定**不予放行**，生产写入仍恒 **0**。详见第 11 节与 `生产投递评审单.md` §8。

## 1. 两批各自做了什么

| 批次 | 代码位置 | 已实现 | ⛔ 刻意未做 |
| --- | --- | --- | --- |
| 第一批：纯函数模块 | `bin/oracle-prescription-delivery.mjs`、`oracle-calibration-replay.mjs`、`oracle-judge-channel.mjs` | 五闸信封、56 组公式自检回放、notes-only judge 契约 | 不挂 cordis、不注册 cron、不建域、不提供默认 sink |
| 第二批：接线 | `bin/oracle-runtime-sources.mjs`、`oracle-runtime-sinks.mjs`、`oracle-runtime.mjs` | 真实 storages/冻结集只读接入、**接 evolve/curriculum 插件 lib 的真 sink**（走 zod spec）、端到端编排器、隔离域演练与回读验证、G5 否决/撤销窗口自省 | ⛔ 不注入生产 sink、不设生产开关、不填标注、不冻结标签、不改评分常量、不调 LLM、不挂 cordis |
| **第三批：运行态点亮** | `bin/oracle-live-tick.mjs`（+ `.test.mjs`） | 真实运行节奏心跳（系统 cron 每小时）、G1 **进程级**显式打开、五闸逐闸明细、可审计 ledger、心跳活性自省、台账禁入生产 storages 硬判据 | ⛔ 不改默认开关、不重启 dsh、不动 `cordis.patch.yml`、不注入生产 sink、不伪造真值/预测 |
| **第四批：点亮到只剩 G2** | `bin/oracle-falsifiable-prescription.mjs`、`bin/capability-baseline-freeze.mjs`（各 + test）、`bin/oracle-production-delivery.test.mjs` | G4 真实可证伪预测（工程承诺型，基线取真实 storages）、G4/G2 解耦、`--deliver` fail-closed 八项前置 + 审计台账、金标模板/治理校验/只写 `contentHash` 的密封 | ⛔ 不代填标签/署名、不代拍 D1–D5、不设生产开关、不注入生产 sink、不伪造 GOLD、不改评分常量、不发版 |

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
node bin/oracle-live-tick.mjs --storages "$S" --switch on          # 真实心跳（追加审计台账）
node bin/oracle-live-tick.mjs --storages "$S" --switch on --status  # 通电状态 + 心跳活性
```

`--rehearse` 实测（2026-11-07）：`DELIVERED_PROPOSED`、隔离域写入 **1 条** `status=proposed`
提案、回读验证 **1 条**；`writesToProduction=0`、冻结集 / 评分常量 / 人工标注 / LLM 全 0。
演练用的 `SYNTHETIC_ANCHOR` 只存在于内存信封，明确标 `synthetic:true`，**不写任何冻结集**。
单测里用 sha256 逐字节对拍了演练前后的生产 `agint_evolve.json`、`agint_aesthetic_oracle.json`
与三份 `sets/*.json`，全部不变。

## 4. 生产写入为何仍是 0（2026-11-08 现状，五重保证已重排）

⚠ **历史口径已过时**：旧版第 2、3 条（0 条真值 ⇒ G2 必拒、造不出信封）在第五批后
不再成立 —— G2 已亮、真实可证伪处方与 B1 信封都已构造成功、五闸实测 **5/5**。
⛔ 但**五闸全过 ≠ 写入许可**，下面是新的五重保证：

1. **服务窗口未确认（首要硬闸）**：现场取证 dsh web 活着（3080 `401`）、服务在另一
   PID 命名空间（本会话停不掉也重启不了）、面板唯一写路由只做 `setStatus()`、
   无服务内 `propose` 入口 ⇒ `--ack-service-window` **未声明，也不该伪造**（评审单 §8.4）。
2. **G1 生产开关未打开**：`AGINT_ORACLE_AUTONOMOUS_WRITE` 未设为字面量 `on`；
   `readSwitch` 不认 `ON`/`1`/`true`。心跳的 `--switch on` 是 `PROCESS_ONLY`，不算生产开关。
3. **`--deliver` 八项前置 fail-closed**：实测给了 `--approve` 仍
   `PREREQUISITES_NOT_MET`（`service_window_ack` / `G1_production_switch` / `five_gates`），
   `writesToProduction=0`，被拒尝试也写审计台账。
4. **默认 sink 是 dry-run**：`executeRuntimePlan()` 不注入 sink 时只把信封记进内存，`writes=0`；
   心跳与默认 CLI 走这条路，5/5 也只到 `WOULD_DELIVER_NO_SINK`。
5. **演练域硬判据**：`assertRehearsalRoot()` 拒绝等于/位于生产 storages 的根；未显式 `approve`
   一律拒绝构造真 sink，且**不自动创建目录**。真 sink 只通过
   `makeEvolveSink()` / `makeCurriculumSink()` 显式指向隔离域。

G5 撤销窗口 24h 与 `--veto`（`humanVeto=true`）已接进编排器：即便其它四闸全过，
人一否决立即 `DEFAULT_DENY`、零写入（第五批实测通过）。

## 5. 生产接线仍缺什么（2026-11-08 收敛后）

机械部分已全部就位：G2 由委托机械真值点亮（⚠ 非人类验证，见 §11）、五闸 5/5、
真实可证伪处方与 B1 信封已构造、隔离域端到端演练真写入并回读已验证。
剩下**两样硬前置**：

- **服务窗口 / 服务内入口**（运行环境事实）：真正停掉 dsh web，或另开一轮新增
  服务内 `propose` 入口并重启服务。⛔ 不能用 `--ack-service-window` 伪造（评审单 §8.4–8.5）。
- **6 周 `humanVerdict` / `humanOverall` 标注**（判定权归人）：阈值 ≥4 周、权重 ≥5 周，
  并解决 `redundancy`/`bloat` 的 `unidentifiable`；⛔ 绝不代填。

放行那次还需显式给 `AGINT_ORACLE_AUTONOMOUS_WRITE=on` ＋
`--deliver --approve --ack-service-window`；D1–D5 的**人类签字栏**仍空白，
独立 preset / 独立会话（C1 阶段 2/3）尚未建立；`sink` 注入生产 storages 需单独评审。
G5 撤销与人工否决在面板可达，未放宽。

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

## 8. 运行态点亮（2026-11-07 第三批）

「亮」= **接进真实运行节奏、每次真实求值留痕、G1 显式通电**，不是「放行写入」。

### 8.1 现状读数（麒麟机）

```text
受控链路 · 运行态心跳
  接线 CONNECTED ｜ 通电 ON（本次进程显式打开；默认配置仍为 OFF）｜ 默认配置恒 OFF
  真实读数：广播 51 条 / weekly 7 周 / 回流 7
  冻结标签 0 ｜ labelAuthority=UNSET ｜ 合格处方 0
  五闸：✓ G1 / x G2 / ✓ G3 / x G4 / ✓ G5 ⇒ DEFAULT_DENY（3/5）
  链路：sources READ → B1_envelope REJECTED → five_gates DEFAULT_DENY
        → sink NO_ENVELOPE → B2 INSUFFICIENT_ANNOTATIONS → C2 BLOCKED
  ⛔ 生产写入 0 ／ 冻结集 0 ／ 评分常量 0 ／ 标注 0 ／ LLM 0
```

**还暗着的两盏灯，性质完全不同**：

- `G2_external_anchor` —— **人给金标**。0 条 GOLD/HELDOUT 冻结标签 ⇒ `UNSET` 必拒。
  ⛔ 绝不代填、绝不拿 `SILVER` 自评顶替；这是「判定权归人」那道闸，代码不得绕过。
- `G4_falsifiable_prediction` —— **系统侧可自愈**。7 条历史提案全缺
  `predictedDelta` / `predictedDeltaSource`，当前没有可证伪预测。修法是让 oracle 周报在产出提案时
  把预测与来源一并写入（下一批），**不是**给五闸塞占位 `0`。心跳器明文判它 fail，
  绝不拿占位值冒充处方（这是本批顺手修掉的一处口径瑕疵）。

### 8.2 真实调度（可逆、零重启）

系统 `cron` daemon 在跑、原 `crontab` 为空，故追加一条**每小时第 7 分**的心跳（实际为单行）：

```cron
7 * * * * cd /home/kylin/projects/DSH/DSH-AGINT && DSH_HOME=/home/kylin/projects/DSH/AGINT-data AGINT_DATA_HOME=/home/kylin/projects/DSH/AGINT-data /home/kylin/.nvm/versions/node/v24.21.0/bin/node bin/oracle-live-tick.mjs --storages /home/kylin/projects/DSH/AGINT-data/storages --switch on --quiet >> /home/kylin/projects/DSH/AGINT-data/.oracle-live/live-tick.log 2>&1
```

- 不动 dsh 服务进程、不 `redeploy`、不改 `cordis.patch.yml` ⇒ 零重启风险，服务仍照常响应。
- `--quiet` 不吐 stdout；审计台账落 `<DSH_HOME>/.oracle-live/live-ledger.jsonl`（**仓库外**，
  避免每小时把 `git status` 弄脏），上限 240 行滚动；每行含逐闸结果、通电状态、四个恒定零。
- `assertLedgerOutsideProduction()` 硬拒把台账写进生产 storages（单测有阴性对照）。
- **撤销**：`crontab -l | grep -v 'oracle-live-tick.mjs' | crontab -`。
  安装前的 crontab 已备份在 `<DSH_HOME>/.oracle-live/crontab.before`。删掉后心跳停止、默认配置仍 OFF。

### 8.3 验收

- 单测 `bin/oracle-live-tick.test.mjs` **11/11**；受控链路相关合计 **152/152**。
- 四道门禁：① `plugin-check` EXIT=0 / 0 FAIL；② `check-wiring` EXIT=1 —— **2 个既有**
  `NO_SUBSCRIBER(input.signal.host.subagent-end/start)`，如实保留未伪装；
  ③ `check-preset-parity` EXIT=0（⛔ 必须先 `export PATH=<nvm>/bin:$PATH`，
  否则 `spawnSync dsh ENOENT` 会假报 `baseline-unavailable` CRITICAL）；④ `check-dsh-compat` EXIT=0。
- 真实心跳前后对拍 `agint_evolve.json` / `agint_aesthetic_oracle.json` / `agint_cron.json`
  与三份冻结集的联合 sha256：`b55a38440449bdcf657b72ad155ab990040f2704fa2a4f72b56c99515c943da2`
  → 完全一致，**逐字节未变**。
- `bin/next-batch-readiness.mjs` 仍为 `ALL_BLOCKED`：运行态通电不改变硬前置。

### 8.4 让最后一盏灯亮起来（第四批后的现状）

- 原第 2 项（G4）**已由系统侧完成**，见 §9.1：实测 `✓ G4_falsifiable_prediction`。
- 现在只剩两件需人做的事：**① 冻结金标**（G2）、**② 单独评审生产级开关 + 注入生产 sink**。
- G5 24h 撤销窗口与人工否决保持可达（不变）。
- 具体步骤、评审材料与回滚 SOP 见 §9 及同目录 `生产投递评审单.md`。

⛔ 备齐前心跳会继续真实地亮着、也真实地拒绝 —— **亮的是链路，不是许可**。

---

## 9. 第四批：点亮到只剩 G2（2026-11-07）

### 9.1 关键解耦：G4 不再绑死在信封上

此前 `buildRuntimePlan()` 真实分支的 `prescription` 恒为 `null`，
`buildPrescriptionEnvelope()` 又先查 `ANCHOR_NOT_EXTERNAL` ⇒ 锚不合格时信封造不出，
心跳器把 G4 的输入绑在 `envelopeResult.ok` 上 ⇒ **「缺外部真值」和「缺可证伪预测」
两个独立缺口混成一条**，五闸读数不能反映链路真实状态。

本批新增 `bin/oracle-falsifiable-prescription.mjs`：从真实 storages 读数构造一份
**工程承诺型**候选处方（⛔ 不是业务建议、不是能力结论、不含任何分数字段）：

```text
基线：agint_evolve.proposal 里 oracle 源 7 条，带 predictedDeltaSource 的 0 条
预测：下一 ISO 周该计数为 1 ⇒ Δ=+1
对拍：下周重读同一表算 actualDelta，写入 growth-report.prediction_outcomes；
      若实际增量 ≠ 预测，本条被证伪并如实记为预测失败，不解释为能力退步。
```

G4 现在读**真实处方**、G2 读**真实锚**，互不代理。锚仍不合格 ⇒ B1 信封继续
`ANCHOR_NOT_EXTERNAL` 拒收 ⇒ `NO_ENVELOPE` ⇒ 零写入。⛔ 纪律未松：
域不可用 / 无真实处方时 `predictedDelta=null`，G4 明文 fail，绝不拿占位 0 冒充。

### 9.2 实测读数（麒麟机 23:12）

```text
✓ G1  ✓ G3  ✓ G4  ✓ G5      x G2      ⇒ DEFAULT_DENY（4/5，只剩 G2_external_anchor）
B1 REJECTED（ANCHOR_NOT_EXTERNAL）→ sink NO_ENVELOPE → B2 INSUFFICIENT → C2 BLOCKED
⛔ 生产写入 0 ／ 冻结集 0 ／ 评分常量 0 ／ 标注 0 ／ LLM 0
```

### 9.3 生产投递分支：已实现、默认恒拒

```bash
node bin/oracle-runtime.mjs --storages "$S" --deliver          # 只读前置体检
node bin/oracle-runtime.mjs --storages "$S" --deliver \
     --approve --ack-service-window                            # 评审批准后
```

`evaluateProductionPrerequisites()` 八项逐条核验：`approve_explicit` /
`service_window_ack` / `G1_production_switch` / `baseline_ready` /
`G2_external_truth` / `B1_envelope` / `five_gates` / `production_root`。
任一不过 ⇒ `PREREQUISITES_NOT_MET`、`writes=0`；**被拒绝的尝试也写审计台账**
`<DSH_HOME>/.oracle-live/delivery-audit.jsonl`（硬拒写进生产 storages）。

⛔ `service_window_ack` 不是形式：dsh 在跑时持整域内存副本，外部进程直写盘会被
整体重写覆盖。要么停机窗口，要么另开一轮改服务内入口。
⚠ 服务进程与 cron daemon 的可见性随会话/沙箱视角变化（23:07 可见且有自然触发台账；
23:43 视角查不到进程、`crontab -l` 权限不足）⇒ 评审时**现场确认**，不沿用历史读数。

⛔ 当前 0 条冻结金标 ⇒ 该分支**必然拒绝**；`writesToProduction` 实测恒 0。
即便五闸 5/5，默认/心跳路径的 sink 仍是 dry-run ⇒ `WOULD_DELIVER_NO_SINK`，不是写入。

### 9.4 金标就绪包（把手工活压成命令）

```bash
node bin/capability-baseline-freeze.mjs --template     # 打印单条样本形状，零写入
node bin/capability-baseline-freeze.mjs --check        # 只读治理体检
node bin/capability-baseline-freeze.mjs --seal gold    # 只写 contentHash
```

`--seal` 的硬约束：治理校验全绿 + 非空集 + 人已署名；**唯一写入字段是
`contentHash = canonicalHash(samples)`**，`samples` / `label` / `labelAuthority` /
`frozenBy` / `frozenAt` / `authority` 逐字段对拍不变。占位署名
（`agent`/`system`/`ai`/`''` …）一律拒；`verify` 样本标 `GOLD` 一律拒；
`gold ∩ heldout` 有交集一律拒；空集与路径逃逸一律拒。

⚠ 真实 `verify.json` 顶层 `authority="VERIFY"` 是**用途标记**（`deriveAnchorAuthority`
只读 gold/heldout），脚本不要求它落在 `labelAuthority` 枚举内，不倒逼改既有数据。

### 9.5 最后一公里（评审单 §6）

1. 你按模板出题、给真值、逐条署名 → `--check` → 三份 `--seal` →
   `capability-baseline.mjs --json` 判 `READY` → 心跳看到 G2 ✓ / 五闸 5/5；
2. **单独**评审「生产级 G1 开关载体 + 注入生产 sink」（七项材料，见
   `生产投递评审单.md` §2），确认停机窗口；
3. 批准后 `export AGINT_ORACLE_AUTONOMOUS_WRITE=on` +
   `--deliver --approve --ack-service-window` ⇒ 验收判据：生产写入**恰 1 条**
   `proposed` / `autoExecutable=false`，且只有 `agint_evolve.json` 的 hash 变。

⛔ 由系统自己出题、跑分、署名会让「外部锚定」退化成「系统自证」——
本批**没有**这么做。若决定改这条宪法级边界，须单独开一轮、单独提交，
明确记录授权来源与降级后的语义，绝不悄悄塞进本批或伪装成 `GOLD`。

### 9.6 验收

- 新增单测：真实预测 **7/7**、生产投递 **6/6**、金标就绪包 **12/12**；
  心跳器更新后 **13/13**（含「域不可用 ⇒ G4 仍 fail」阴性对照）；
  受控链路相关合计全绿（见 §10 复核命令）。
- 四道门禁：① `plugin-check` / ③ `check-preset-parity`（⛔ dsh 需进 PATH）/
  ④ `check-dsh-compat` EXIT=0；② `check-wiring` 保留 **2 个既有** `NO_SUBSCRIBER`。
- 生产三域（evolve / oracle / cron）+ 三份冻结集联合 sha256 前后逐字节一致。
- `bin/next-batch-readiness.mjs` 仍 `ALL_BLOCKED` —— 代码与节奏齐了，
  真值、标注、拍板、开关四样仍需人给。

## 10. 本批复核命令

```bash
export PATH=/home/kylin/.nvm/versions/node/v24.21.0/bin:$PATH
export DSH_HOME=/home/kylin/projects/DSH/AGINT-data
export TMPDIR=/home/kylin/projects/DSH/.test-tmp
S=$DSH_HOME/storages

node --test bin/oracle-falsifiable-prescription.test.mjs \
            bin/oracle-production-delivery.test.mjs \
            bin/capability-baseline-freeze.test.mjs \
            bin/oracle-live-tick.test.mjs bin/oracle-runtime.test.mjs

node bin/oracle-live-tick.mjs --storages "$S" --switch on --status
node bin/oracle-runtime.mjs --storages "$S" --deliver
node bin/capability-baseline-freeze.mjs --check
```

---

## 11. 第五批：G2 点亮（委托机械真值）与生产投递评审判定（2026-11-08）

### 11.1 做了什么 / 没做什么

| | |
|---|---|
| ✅ 做了 | `bin/capability-baseline-mechanical.mjs`（+ test）：23 条确定性断言**实跑**生成三份集合；`capability-baseline-freeze.mjs` 升 `FREEZE_SCHEMA 1.1` 加委托类别治理护栏；三份 `--seal`；G2 点亮；生产投递评审逐项复核；隔离域演练 / fail-closed / G5 撤销 / 生产哈希对拍全部实测 |
| ⛔ 没做 | 不伪装人类签名、不代填 `humanVerdict` / `humanOverall`、不伪造 `--ack-service-window`、**生产写入 0**、不改评分常量、零 LLM、不重启服务、不发版 |

### 11.2 实测读数

```text
verifyBaseline  verdict=READY ｜ 可用冻结标签 17 ｜ gold∩heldout=0
                ｜ capabilityConclusion=null ｜ 三份 SEALED
--verify        重跑 23 / 冻结 23 ｜ PASS 21 / REJECT 2（真负控制）｜ 不一致 0
心跳            ALL_GATES_PASSED (5/5) ｜ labelAuthority=GOLD ｜ 冻结标签 17
                ｜ 生产写入 0（台账已留 ALL_GATES_PASSED 一行）
--deliver --approve
                PREREQUISITES_NOT_MET
                failed=[service_window_ack, G1_production_switch, five_gates]
                ｜ writesToProduction=0 ｜ 被拒尝试已写审计
--rehearse      隔离域真写入 1 条 status=proposed ｜ 生产 6 对象 sha256 6/6 不变
--veto          DEFAULT_DENY（G5 failed：humanVeto=true）｜ writes=0
```

### 11.3 评审判定：不予放行

§2 七项材料复核后剩**两项硬缺口**：

1. **6 周人工标注 0 条** —— `humanVerdict` / `humanOverall` 判定权归人，绝不代填；
2. **服务窗口不成立** —— dsh web 在另一 PID 命名空间活着（3080 `401`），
   面板唯一写路由只做 `setStatus()`（不能创建候选），无服务内 `propose` 入口。

⇒ **不伪造 `--ack-service-window`，生产写入保持 0**。完整取证、决定记录、
放行命令与回滚见 `生产投递评审单.md` §8；D1–D5 的非人类决定记录见建议单 §5。

⛔ **语义降级**：`GOLD` / `HELDOUT` 本批仅表示「外部冻结真值：可独立复现、
密封不可篡改、外置于评分回路」，**不表示**「授权人工已验证 AGINT 能力」；
`humanValidated:false`，构造期自参照局限已写进 `provenance.knownLimitation`。

### 11.4 本批复核命令

```bash
export PATH=/home/kylin/.nvm/versions/node/v24.21.0/bin:$PATH
export DSH_HOME=/home/kylin/projects/DSH/AGINT-data
S=$DSH_HOME/storages

node --test bin/capability-baseline-freeze.test.mjs \
            bin/capability-baseline-mechanical.test.mjs   # 21/21
node bin/capability-baseline.mjs --json                   # verdict=READY
node bin/capability-baseline-mechanical.mjs --verify      # REPRODUCIBLE
node bin/capability-baseline-freeze.mjs --check           # 治理 ✓ + 降级 banner
node bin/oracle-live-tick.mjs --storages "$S" --switch on --status   # 5/5
```

> ⛔ 亮的是**链路与判据**，不是写入许可，更不是能力结论。
