# agint-evolve

> 周复盘 + 改进提案：闭环把"看到问题"变成"落地改进"。
>
> v0.2 起与 `agint-quality-eval` 联动：复盘时自动读评估历史 + HARM 趋势 + 退化/停滞信号。

## 职责

- 提供 `agint.evolve` host Service
- 提供 `evolve_*` model 工具（review / read / propose / proposals / set_status）
- 报告写 `$AGINT_HOME/reviews/YYYY-MM-DD.md`
- 提案存 `agint_evolve` storage domain

## 复盘流程（周日 18:00 自动跑）

`evolve_review()` = `writeReview()`：

1. **采集快照**：memory / wiki / cron / rules / metrics / **quality**
2. **自动发现**：
   - cron.staleJobs > 0
   - wiki.brokenLinks > 0
   - wiki.orphans > 0
   - rules.adherencePct 下降
   - metrics 异常 delta
   - quality.HARM 趋势下降（v0.3 起）
   - quality 退化/停滞信号（v0.3 起）
3. **写报告**：reviews/YYYY-MM-DD.md 包含：摘要 / 自动发现 / 数据快照 / 上周期 proposal 回顾 / **哲学对齐检查**
4. **不**自动提 proposal —— 由模型读完报告后决定

> **哲学对齐检查**（v0.2 起强制）：每个复盘报告必须有 `## 哲学对齐检查` 章节，详见 `docs/evolution-philosophy-checkpoints.md` 第四章。

## 提案生命周期

```
proposed ──批准（人工）──▶ approved  （已批准待执行）
         ──执行后──▶ applied        （已落地）
         ──评估后不做──▶ rejected   （拒绝执行）
         ──暂不处理──▶ wontfix      （wontfix）
```

`approved` 与 `applied` 不是同一件事。

- `approved` 是**决定**：有人看过，同意做，还没做。note 写批准理由。
- `applied` 是**事实**：代码或文档已经改了。note 写落地证据（改了哪些文件）。

⛔ 不要把「批准」记成 `applied`。那样 proposal 表会说假话。
2026-10-23 之前没有这一档，53 条 proposed 只进不出，就是这个缺口。

### `approved` 还分两种（2026-10-27 起）：能动手 / 等前置

`approved` 只说了「同意做」，没说「现在能做」。批准的是**方向**、前置却没到位的，
必须标出来，否则它会在待办里挂成一张催办工作单 —— 而真去动手会撞自家门禁
（实测反例：`a85ef850` 权重真标定，批了，但周报冻结权重常量、等 8-12 周标注样本）。

| 字段 | 含义 |
|---|---|
| `blocker` | 卡在什么上（空串 = 没卡住） |
| `unblockCondition` | 等什么满足才算能动手 |

- 家族面板待办里，带了 `blocker` 的 approved **不进**「已批准待执行（工作单）」，
  而进「已批准·阻塞中（等前置）」（`kind: supply` —— 人能做的只有等），
  并把原因和条件原样印在条目上。
- 解锁后清掉 blocker（传空串）即回到工作单；落地标 `applied` 时若仍挂着 blocker，
  原原因会转写进 `note`（`解除阻塞（原：…）`），不静默丢。
- 判据只有一处：`proposalBlocked()`。面板因跨插件不 import，保留一份等价实现，
  由两端测试钉住。
- 工具：`evolve_set_status <id> approved "<理由>" --blocker "<原因>" --unblockCondition "<条件>"`；
  `evolve_proposals blocked=true` 只看阻塞中的。

`evolve_set_status id applied "已在 X 落地"` 仍是闭环的最后一步。
人工改判可以回到 `proposed`（家族面板的「撤销」走同一出口）。

## 模型接口

- `evolve_review [--date YYYY-MM-DD] [--notes "..."]` 立即跑一次（dry-run 默认写文件）
- `evolve_read [path]` 读报告全文
- `evolve_propose [title] [body]` 提一条（category: rule/skill/doc/preset/service/plugin/other；`plugin` = 整 cordis 模块级改动，`service` = 模块内单 host 服务改动）
- `evolve_proposals [status] [category] [blocked]` 看清单（`blocked=true` 只看阻塞中的）
- `evolve_set_status id status [note] [blocker] [unblockCondition]` 更新状态

## 路由规范（教训/方法/知识/改进）

读到复盘报告后：
- 教训 → `memory_write type:lesson`
- 决策 → `memory_write type:decision`
- 偏好 → `memory_write type:preference`
- 知识 → `wiki_write`
- 改规则/技能/文档/预设 → `evolve_propose`

## 与其他插件的关系

- **`agint.cron`**：evolve-review job 每周日触发
- **`agint.metrics`**：复盘读 metrics 数据
- **`agint.memory`**：复盘可能写入新 lesson
- **`agint.qualityEvaluator`**（v0.2）：复盘读评估历史 + HARM 趋势
- **`agint_evolution`**（v0.3）：复盘写 failure-patterns / 蒸馏 success-templates

## 进化健康度护栏（来自 `路线图`）

复盘时强制检查以下指标：

| 指标 | 阈值 | 触发动作 |
|---|---|---|
| 每周自动部署次数 | ≤ 3 次 | 超限 → 强制进入人工审核队列 |
| 进化回滚率 | ≤ 20% | 连续 3 周超限 → 暂停自动部署 |
| 人工干预率 | ≤ 30% | 连续 3 周超限 → 评估是否过度工程 |
| HARM 趋势 | 4 周滑动平均 ≥ 上月 95% | 低于 → 触发 `baseline-regression-suite` 跑分 |
| 基线测试通过率 | ≥ 95% | 下降 → 立即冻结进化并告警 |

## 测试

`test/report.test.js`：writeReview 的快照采集 + 自动发现列表生成。
`test/philosophy.test.js`（v0.2 计划）：强制哲学对齐检查章节存在。

## 文件

```
lib/index.js    Cordis apply()：注册 agint.evolve Service
lib/report.js   writeReview 引擎（纯函数 + storage 写入）
lib/tools.js    evolve_* model 工具
test/report.test.js
```

## v0.7.2（2026-09-29 · 周报纳入外部信号章节）

- `dataSnapshot()` 软取 `agint.inputGateway`（未挂载降级），snapshot 增 `inputGateway` 面
- 发现新增：`gateway.silent.<channel>`（info，fetch≥2 且 emitted=0）与 `gateway.security`（warn，命中/丢弃）
- 报告新增 `## 二·A、外部信号与多源输入` 章节与「外部信号与多源输入」快照行
