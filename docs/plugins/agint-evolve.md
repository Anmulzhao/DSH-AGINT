# agint-evolve

> 周复盘 + 改进提案：闭环把"看到问题"变成"落地改进"。

## 职责

- 提供 `agint.evolve` host Service
- 提供 `evolve_*` model 工具（review / read / propose / proposals / set_status）
- 报告写 `$AGINT_HOME/reviews/YYYY-MM-DD.md`
- 提案存 `agint_evolve` storage domain

## 复盘流程（周日 18:00 自动跑）

`evolve_review()` = `writeReview()`：

1. **采集快照**：memory / wiki / cron / rules / metrics
2. **自动发现**：
   - cron.staleJobs > 0
   - wiki.brokenLinks > 0
   - wiki.orphans > 0
   - rules.adherencePct 下降
   - metrics 异常 delta
3. **写报告**：reviews/YYYY-MM-DD.md 包含：摘要 / 自动发现 / 数据快照 / 上周期 proposal 回顾
4. **不**自动提 proposal —— 由模型读完报告后决定

## 提案生命周期

```
proposed ──evaluate──▶ applied   （已落地）
                  ──▶ rejected  （评估后不做）
                  ──▶ wontfix   （暂不处理）
```

`evolve_set_status id applied "已在 X 落地"` 是闭环的最后一步。

## 模型接口

- `evolve_review [--date YYYY-MM-DD] [--notes "..."]` 立即跑一次（dry-run 默认写文件）
- `evolve_read [path]` 读报告全文
- `evolve_propose [title] [body]` 提一条（category: rule/skill/doc/preset/service/other）
- `evolve_proposals [status] [category]` 看清单
- `evolve_set_status id status [note]` 更新状态

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

## 测试

`test/report.test.js`：writeReview 的快照采集 + 自动发现列表生成。

## 文件

```
lib/index.js    Cordis apply()：注册 agint.evolve Service
lib/report.js   writeReview 引擎（纯函数 + storage 写入）
lib/tools.js    evolve_* model 工具
test/report.test.js
```