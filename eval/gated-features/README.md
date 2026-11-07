# 受控功能实现契约（B1 / B2 / C2）

> 2026-11-07 老板就「把功能都打开」选择 **「实现功能但守住闸门」**。
> 本目录记录这一档的精确边界：**代码全部就位，运行态零写入**。
> ⛔ 本文是工程契约，不是 `docs/specs/` 规范（避免孤儿规范门禁），也不改纲领一个字。

## 1. 这一档做了什么、没做什么

| 项 | 代码位置 | 已实现 | ⛔ 刻意未做 |
| --- | --- | --- | --- |
| B1 受控投递 | `bin/oracle-prescription-delivery.mjs` | 候选信封构造、五闸强制、`status=proposed`、可注入 sink 的唯一写入点 | 不挂 cordis、不注册 cron、不建 storage 域、**不提供任何默认 sink** |
| B2 判尺回放 | `bin/oracle-calibration-replay.mjs` | 参数化扣分、与生产纯函数 56 组逐值自检、候选规格回放、跨 `scaleHash` 分段判据、三态门槛 | 不拟合出「结论」、不写 `humanVerdict`/`humanOverall`、**不改 `scoring.js` 任何常量**、`applied` 恒 false |
| C2 judge 通道 | `bin/oracle-judge-channel.mjs` | notes-only 信封、独立会话校验、机器可验的「不进评分链路」断言、通道就绪度 | **不调 LLM**、不建独立 preset / 会话、不写 notes、`llmCalls` 恒 0 |

## 2. 默认关闭的四重保证

1. **开关**：`AGINT_ORACLE_AUTONOMOUS_WRITE` 未设为字面量 `on` ⇒ G1 必拒（`readSwitch` 不认 `ON`/`1`/`true`）。
2. **外部锚定**：`labelAuthority` 只认 `GOLD` / `HELDOUT`；`SILVER` 自评与 `UNSET` 一律拒。当前三份冻结集 `samples: []` ⇒ 0 条可用真值，**G2 必拒**。
3. **写入点**：三个模块都是纯函数 + 只读 CLI。B1 唯一写入点是调用方**显式注入**的 `sink`，默认 `null` ⇒ `writes=0`；`WOULD_DELIVER_NO_SINK` 是合法状态，不是降级。
4. **挂载**：不进 `plugins/`、不进 preset、不进 `cordis.patch.yml` ⇒ 部署位行为与改动前逐字一致，无需 redeploy 即可保持零影响。

阴性对照（31 例，见 `bin/oracle-*.test.mjs`）钉住：默认 `DEFAULT_DENY`、开关 `on` 但 G2 缺真值仍拒、五闸全过但无 sink 仍零写入、回放 `REPLAY_READY_FOR_HUMAN_REVIEW` 仍 `applied=false`、judge 通道 `READY` 仍零 LLM。

## 3. 生产接线契约（**现在不执行**）

只有下列前置全部由人备齐，才允许把 `sink` 接进运行时；且接线必须单独评审、单独发版：

- `eval/capability-baseline/sets/{gold,verify,heldout}.json` 由**授权人工**冻结标签，`verifyBaseline()` 判 `READY`；
- 6 周 `humanVerdict` / `humanOverall` 标注由人填完（阈值 ≥4 周、权重 ≥5 周），`redundancy`/`bloat` 的 `unidentifiable` 有解；
- C1 阶段 2/3 的 D1–D5 拍板，独立 preset / 独立会话与 notes-only 写入契约接线；
- `AGINT_ORACLE_AUTONOMOUS_WRITE=on` 由人显式开启，G5 撤销窗口与人工否决在面板可达。

接线时 `sink` 必须走**既有面板路由或插件 lib**，禁止直写 storages JSON、禁止直改评分常量 / prompt / rules（五闸 G3）。B1 投递的只能是 `status=proposed` 候选，执行仍走既有驱动与人工审批（纲领附二 R1/R3「投递 ≠ 修改」）。

## 4. 红线（任何后续批次不得越过）

- ⛔ 不替人填 `humanVerdict` / `humanOverall`，不伪造冻结标签，不拿 0 冒充「没测过」。
- ⛔ 不让 `aesthetic_score` 或任何分数字段进入五闸输入、处方信封、judge 信封（Goodhart / 纲领 §8 例二）。
- ⛔ 不放宽 §5.4 两条语义公理、§7.2 人类最终决策点、§9.5 评分链路永久零 LLM。
- ⛔ 跨 `scaleHash` 的分数不可直接比较；回放 Δ 不是「进化变好/变差」，更不是能力结论。
- ⛔ `bin/next-batch-readiness.mjs` 的 `READY` 判定**不因代码就位而变化**；`implementation.available=true` 只说明模块存在，`overall` 仍由硬前置决定。

## 5. 可复跑验收

```bash
export PATH=/home/kylin/.nvm/versions/node/v24.21.0/bin:$PATH
node --test bin/oracle-prescription-delivery.test.mjs \
            bin/oracle-calibration-replay.test.mjs \
            bin/oracle-judge-channel.test.mjs
node bin/oracle-prescription-delivery.mjs            # DEFAULT_DENY / writes=0
node bin/oracle-prescription-delivery.mjs --switch-on --json   # G1 过、G2 仍拒
node bin/oracle-calibration-replay.mjs               # 自检 OK / writes=0 / applied=false
node bin/oracle-judge-channel.mjs                    # BLOCKED / writes=0 / llmCalls=0
node bin/next-batch-readiness.mjs --storages <数据根>/storages --sets eval/capability-baseline/sets
```

最后一条应仍为 `ALL_BLOCKED` —— **这是设计结果，不是故障**。
