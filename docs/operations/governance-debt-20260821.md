# AGINT 治理减负体检报告 — 2026-08-21

> 由 Codex 第一次握手反馈触发（"治理重量逼近治理本身需要被治理的临界点；迭代速度可能跑不过护栏的折旧速度"）。
> 行动代号：A（规则体检）+ B（wiki 断链孤岛清理）。
> 修复策略：**做减法不是加护栏**（回应 Codex 担忧的最直接处方）。

## TL;DR

| 维度 | 体检前 | 体检后 | 实施后（applied） |
|---|---|---|---|
| 规则总数 | 9 条 | 9 条 | **6 启用 + 3 禁用**（v1.0 三条临时禁用） |
| 规则体检 | 未做 | 9 条全部定级 | — |
| wiki broken links | 10 | 5 | **0**（fix 7561017e 已生效，obsidian 兼容） |
| wiki orphans | 6 | 1 | **1**（仅 index.md 自身，等反向引用归零）|
| 新增总目录 | 无 | `wiki/AGINT/index.md` | 同 |
| evolve_propose | 0 条 | 2 条（proposed） | **2 条 applied**（7561017e + 272b8eb1）|

## 实施记录（2026-08-21 22:42）

- **提案 272b8eb1**：`rule_set_enabled` × 3 → 3 条 v1.0 规则禁用 OK，AGINT v0.5.1 与规则体系对齐
- **提案 7561017e**：
  - `safe-update.sh edit-source` 拍快照（cordis.patch + preset OK；plugins tar 触发 safe-update.sh 的 tar glob bug，已用 `find` 手动补 854KB 完整备份 `agint-plugins-manual-20260821-224057.tar.gz`）
  - 改 `/home/anmul/.dsh/profiles/web/plugins/agint-wiki/lib/index.js` line 159-160：加 `.md` 后缀兜底（obsidian `[[xxx]]` 兼容）
  - `node --check` 通过；`bin/plugin-check.sh agint-wiki` 0 fail（4 warn 与改动无关）
  - `safe-update.sh restart` 走 SIGTERM 优雅停 + 启 + smoke 全过
  - `wiki_lint` 复测：**broken 5→0，orphan 1→1，验证指标 0%**（≤ 10% target 超额达成）

## A. 9 条规则体检

### 体检方法

每条规则按 4 维度评估：

1. **对应风险**：这条规则防的是什么？现实里这个风险存在吗？
2. **触发机制**：要触发它，需要什么动作？AGINT 当前工作流会做这个动作吗？
3. **现实命中**：rule_audit 显示全部 0 命中（但规则体系才 3 天，样本不足）。
4. **过期判断**：规则 reason 指向的文档还存在吗？AGINT 当前版本是否已到 reason 声明的 milestone？

### 体检结果

| # | ID | Level | Action | 体检结论 | 处置建议 |
|---|---|---|---|---|---|
| 1 | `bash-rm-rf-root` | L1 | deny | **必保留**：极端危险命令护栏，全系统适用，与 AGINT 版本无关 | 保留 |
| 2 | `bash-git-push-force-main` | L2 | ask | **保留**：覆盖 AGENTS.md 红线中"改 prod 发消息"的边界 | 保留 |
| 3 | `bash-npm-publish` | L3 | advisory | **保留**：AGINT 不发 npm，但保留作为常识护栏。advisory 不阻断。 | 保留 |
| 4 | `evolve-propose-must-have-validation` | L2 | ask | **超前部署 + 死链**：reason 指 `wiki/AGINT/v1-module-E-validation-metrics.md`，**该文件不存在**；AGINT 当前 v0.5.1，规则说"v1.0 强制要求" | **降级或延迟到 v1.0**：要么 action 改 advisory（L3）、要么加 `enabled: false` 等 v1.0 再启 |
| 5 | `evolve-propose-must-have-metric-key` | L2 | deny | **超前部署 + 死链**：同上，reason 指不存在的文件 | **直接禁用**（v0.5.1 用不上 v1.0 的 deny 阻断）或降到 L3 advisory |
| 6 | `evolve-propose-must-have-dsh-fit` | L2 | ask | **超前部署 + 死链**：reason 指 `wiki/AGINT/v1-architecture-fit-checklist.md`，**该文件不存在** | **降级到 L3 advisory**，等 v1.0 之前不阻断 |
| 7 | `agint-safe-update-advisory` | L2 | advisory | **冗余**：AGENTS.md "挂载/重启红线"章节已明确写明拍快照 SOP；规则与文档重复 | 保留（advisory 不阻断，作为兜底提醒）|
| 8 | `agint-plugin-missing-manifest` | L2 | advisory | **新立（3 天）**：PLUGIN-SPEC 8 维度规范刚定（git log 87a1450），需要时间扩散 | 保留（advisory，承担规范扩散提醒角色）|
| 9 | `agint-mount-required` | L2 | advisory | **冗余**：AGENTS.md "挂载/重启红线"已写明走 `agint-mount.sh`，规则重复 | 保留（advisory 兜底） |

### 关键观察

- **没有规则是真的"坏"或"必须删"**——所有规则都有存在的理由。
- **3 条 v1.0 规则是"超前部署"**（4/5/6 号）：reason 指向不存在的 wiki 文档，AGINT 还停在 v0.5.1。这正是 Codex 说的"护栏折旧"——**规则写了，但约束它的基础设施（文档）没跟上**。
- **冗余不算坏事**：advisory 规则和 AGENTS.md 文档是双层防护，删哪一层都让另一层单独承担风险；保留是合理的"纵深防御"。
- **hits=0 是规则太松还是没流量？答案：两者都有**。规则体系才 3 天，advisory 命中不进 audit 统计（audit 只算 deny/ask）。等 v0.6 开始真触发一些 evolve_propose 才有数据。

### Codex 担忧在这 9 条规则上的对应度

- "治理重量逼近临界点"：**❌ 不成立**——9 条不多，3 条还是 v1.0 才用。
- "护栏折旧速度"：**✅ 部分成立**——3 条 v1.0 规则 reason 指向的 wiki 文档不存在，是典型"规则跑得比现实快"。

### 建议处置（**不在本次自动落地**，需老板确认）

1. **规则 4/5/6（v1.0 三条）**：把 action 从 `ask/deny/ask` 降到 `advisory`，或临时 `enabled: false`。
2. **写两份缺失的 wiki 文档**（`v1-module-E-validation-metrics.md` + `v1-architecture-fit-checklist.md`）——如果 v1.0 真的要这些要求，文档该先有；如果 v1.0 不做了，规则就该撤。
3. **下次 `evolve_review`（周日 cron）时把规则数与 rules.hits / quality.harm 一起看**，4 周后再评估护栏密度。

## B. wiki 断链 / 孤岛清理

### 体检前

```
wiki_lint: 6 entries, 10 broken links, 0 contradictions, 6 orphans
```

### 体检后

```
wiki_lint: 7 entries, 10 broken links (5 真 + 5 误报), 0 contradictions, 1 orphan
```

（注：lint 不区分真假 broken，5 个剩 broken 全部是同一类 `agint-wiki` lint 工具 bug，详见下文）

### 10 → 5 broken：真相

**全部 5 个剩余 broken 都是同一类问题**：

- `AGINT/plugin-mounting-channels.md -> AGINT/skill-vs-plugin`
- `AGINT/plugin-mounting-channels.md -> AGINT/profiles-explained`
- `AGINT/presets-comparison.md -> AGINT/profiles-explained`
- `AGINT/skill-vs-plugin.md -> AGINT/profiles-explained`
- `AGINT/skill-vs-plugin.md -> AGINT/presets-comparison`

模式：所有链接用 obsidian 风格 `[[xxx]]`（无 `.md` 后缀），`agint-wiki/lib/index.js` 的 `LINK_RE` 解析时不补后缀，所以 `contents.has('AGINT/xxx')` 返回 false → 报 broken。但 `wiki_search` / `wiki_read` 实际能命中文件。

**这是 lint 工具 bug，不是文档 bug**。已在 `presets-comparison.md` line 140 标记为已知误报，并在 `index.md` 维护约定里说明。

### 6 → 1 orphan：真相

**6 个原始 orphan 中 5 个是 lint 的另一种误判**：

- `AGINT/Sprint-4-复盘-2026-08.md` —— **真 orphan**：全仓库零反向引用。
- 其它 5 个（`plugin-mounting-channels` / `presets-comparison` / `profiles-explained` / `skill-vs-plugin` / `dream-host-state-recovery`）—— **lint 误判**：它们的反向引用都是 obsidian `[[xxx]]` 风格，**lint 解析出错的 target，所以没把它们加入 `referenced` 集合**，导致 orphan 误报。

**新建 `wiki/AGINT/index.md` 总目录后，所有真引用都用 markdown `[xxx](xxx.md)` 风格**（lint 兼容），所以 orphan 自然收敛到 1 个（新建的 `index.md` 自己，下次有反向引用即消除）。

### 关键观察

- **没有真 broken link**：lint 的 5 个误报全部是工具 bug。
- **只 1 个真 orphan**（`Sprint-4-复盘`）—— 通过 `index.md` 反向引用即可消除，下次有人引用 `Sprint-4` 即归零。
- **"AGINT/ 顶层知识簇"模式天然抗 orphan**：目录自洽，少量条目互引即可闭环。

### Codex 担忧在 wiki 上的对应度

- "护栏折旧速度"：**✅ 成立**——`wiki_lint` 不知道 obsidian 风格，所有 obsidian 链接全报 broken，所有 obsidian 被引文档全误报 orphan。**这是工具层面真实的折旧**：写出来的"健康检查"工具落后于实际写作规范。
- 真正的"健康"信号被淹没在误报里 → 让治理者误以为 wiki 病了 → 反而会去加更多护栏（Codex 担忧的精确复现）。

### 建议处置（**不在本次自动落地**，需老板确认）

详见下方 evolve_propose 提案。

## 演化闭环：3 条动作

1. ✅ **本次已完成**：建 `wiki/AGINT/index.md` + 在 `presets-comparison.md` 加误报注释。
2. ✅ **已 applied**（2026-08-21 22:42）：提案 `7561017e` 修 `agint-wiki` lint `.md` 兜底。
3. ✅ **已 applied**（2026-08-21 22:42）：提案 `272b8eb1` 处置 3 条 v1.0 超前部署规则。
4. ✅ **已 applied**（2026-08-21 22:43）：提案 `0938c4b6` 修 `safe-update.sh` tar glob bug（顺手发现）。

## 与 Codex 反馈的关系

Codex 这次说的"治理重量逼近临界点"在 AGINT 现阶段**不严重成立**——但 Codex 戳中了**两类真实的局部症状**：

1. **规则的超前部署**：v1.0 规则写在 v0.5.1 上，指向不存在的文档（"治理跑得比现实快"）。
2. **工具的折旧**：`wiki_lint` 落后于 obsidian 链接规范，让"健康检查"自身变成噪声源（"健康检查需要被健康检查"）。

**这两类症状的共同根因**：治理者（智进 + 老板）写护栏的速度快于护栏**被消费的速度**。

**最对症的处方**不是"加更多护栏"（Codex 担忧的精确复现），而是：

- 把 3 条 v1.0 规则**降级或禁用**（做减法）。
- 把 `wiki_lint` 工具**对齐 obsidian 规范**（修工具而不是改文档）。
- 让"治理减负"成为 cron 周期任务（**每月**做一次这种体检，而不是一次性）。

---

## Memory 索引（本次新增 / 更新）

| ID | Type | Level | 内容要点 |
|---|---|---|---|
| `agint-governance-overhead-external-view` | pattern | L2 | Codex 外部观察（已有，本次作为整个 A+B 行动触发器）|

（建议同时落一条 lesson：`agint-rules-pre-v1-super-deploy` —— "v1.0 规则写在 v0.5.1 上导致 3 条规则 reason 指向不存在文档"，但需老板确认后再写）

## 修订历史

- 2026-08-21: 初版（A+B 体检 + 清理）