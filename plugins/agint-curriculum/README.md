# agint-curriculum

P7 自主课程生成器 · Sprint 14 Part B（v0.1.1，**2026-09-09 挂载 prod**）。

按 `Sprint14-设计稿.md` §4（Part B 设计）与 §5.2（B-1~B-10）落地：当 self-model
能力画像出现缺口（UNCERTAIN / 校准失准 / 久未复验）时，自动生成**带可自动判定
通过条件**的挑战，agent 出队手动执行，判定结果回写 self-model —— 形成
「探测 → 训练 → 判定 → 画像更新」的自进化闭环（不自动执行，不直接改能力表）。

## 快速开始

```bash
cd plugins/agint-curriculum
node --test "test/*.test.mjs" test/smoke.mjs   # 60 用例
node ../../bin/plugin-check.sh agint-curriculum  # 静态检查（Windows 用 git bash）
```

## 架构

```
self-model snapshot() ──► probe（边界探测）──► generate（4域×D1-D5 模板）
        ▲                                        │ 冷却/批量上限
        │                                        ▼
self-model.update() ◄── submit（外部化判定）◄── nextChallenge（出队不自动执行）
        │                │ judge → attempts → 挑战状态 → 难度调节 → 事件
        └── 只提供证据，不改 capability 表（§4.9）
```

## Service（`agint.curriculum`）

| 方法 | 说明 | 挂载要求 |
| --- | --- | --- |
| `probe` | 边界探测：读 snapshot 筛选待练域，按缺口权重×久未验证排序 | self-model 软依赖（不可用→skipped） |
| `generate` | 生成挑战（默认 1 个，批量 ≤5）；同域 24h 冷却；无模板域诚实留白 | storage |
| `nextChallenge` | 出队最早 open 挑战置 in_progress（不自动执行 §4.5） | storage |
| `submit` | 外部化判定 + attempts 落盘 + 难度调节 + self-model 回写 + 事件 | storage；self-model/event-bus 软依赖 |
| `list` / `stats` / `difficulty` | 查询 | storage |
| `pause` / `resume` / `config` | 运行时开关与热配置 | storage |

### 判定红线（C1/C2/C3）

- **C1** 挑战必带可自动判定 `verifySpec`（exit-code-output / conclusion-match /
  step-list / tool-match 四类断言）；
- **C2** `selfAssessment` 一律剥离进 notes，**绝不参与判定**；
- **C3** 无 `evidence` → 记 fail（require_evidence=true 默认）；verifySpec 缺失 →
  防御性 fail（宁 fail 不 pass）。

## 难度调节（§4.6）

- 28 天滚动窗口，样本 <5 不调档（cold-start）；
- 连续 pass/fail ≥3 强制升降档（行为信号优先于统计，防刷分/防挫败）；
- 完成率 <40% 降档、>70% 升档；D1 下限 / D5 上限夹紧；
- 连续 fail ≥3 → 标 `cannotCandidate`，供 self-model 复验（转 CANNOT 候选）。

## 存储（独占 `agint_curriculum` 域，4 表）

| 表 | 上限 | 说明 |
| --- | --- | --- |
| challenges | 200 | 挑战（含 verifySpec、sessionId `curriculum-` 前缀） |
| attempts | 500 | 执行记录（evidence + verdict + notes） |
| difficulty_state | 100 | 每域一行的难度状态（窗口/连续序列/CANNOT 候选） |
| audit_log | 1000 | 审计（唯一滚动清理） |

超限 warn 不 prune（对齐 curator 惯例），仅 audit_log 滚动。

## 触发器

- **A11 `self.model.updated`**：只当「画像变了」的信号，数据一律走 `snapshot()`
  （§4.2 不改 FROZEN payload）。**不订阅** tools/pre-execute、post-execute、
  ptc-dispatch-log、agent/pre-step 等 waterfall 事件（避开 plugin-check 维度 9 的坑）。
- **每周例程**：预留 `weekly_cron='0 3 * * 0'`（周日 03:00，晚于 curator-weekly
  02:00 与 evolve-review），由 agint-cron job 驱动（挂载后接线）。

## 配置（config / 热更新）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| stale_reverify_days | 30 | CAN 超过该天数未复验 → 进入待练 |
| challenge_cooldown_hours | 24 | 同域生成冷却 |
| difficulty_window_days | 28 | 难度滚动窗口 |
| difficulty_min_samples | 5 | cold-start 样本阈值 |
| pass_floor / pass_ceiling | 0.40 / 0.70 | 完成率护栏 |
| force_promote_streak / force_demote_streak | 3 / 3 | 连续序列强制调档 |
| require_evidence | true | C3 |
| auto_execute_enabled | false | **恒 false**（§4.5，挂载后也禁止翻 true） |
| self_model_writeback | true | §4.9 回写开关 |
| weekly_cron | '0 3 * * 0' | 预留例程表达式 |

## 不挂载 prod（Sprint14 拍板 Q1 / §0.3）

> **⚠️ 已过时**：2026-09-09 老板拍板提前挂载（保守模式：无 cron job、无
> generate/probe 工具，服务注册 + 4 只读/写工具可见，不会自动生成挑战）。
> 原观察窗决策记录保留如下，供溯源。

prod 观察窗（变异成功率 ≥15% + 归因覆盖率 ≥80%，4 周）最早 10 月底满足；
挂载决策进 2026-09-25 影子挂载拍板会。本版本只仓库实现 + 测试。

## 依赖

- `agint-self-model >=0.7.1`（snapshot/update；`self.model.updated` A11 只作触发器）
- `agint-event-bus >=0.7.0`（软依赖）
- `agint-cron >=0.7.0`（weekly 例程接线后依赖）
- `@deepseek-ai/dsh-storage-domain`、`zod`（peer）
- D4 黑名单副本：`plugins/agint-curriculum/lib/schema.js` 与 curator /
  skill-autocreate 三处一致（`const-consistency.test.mjs` 自动断言）
