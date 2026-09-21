# Proposal: agint-dream 候选去重同源闭包 / 评分天花板 —— 阶段一（去重）

> **状态**：**已批准（老板 2026-09-21 拍板方案 B）+ 已落地**（提交 `5fb366b`） · 类别 `plugin`
> **验收**：2026-09-21 15:2x 生产规模回放 + 宿主部署位 108 测试全绿 + 变异测试 —— 见 §8
> **目标插件**：`agint-dream`
> **作者**：智 · **日期**：2026-09-21
> **风险等级**：P1（触及已发布插件的评分/门禁主路径，但不改持久化 schema）
> **关联**：`docs/plugins/agint-dream.md`、K21（dream 评分链路）、K51（自进化默认原则）

---

## 1. 背景：两个症状，一个根因

2026-09-21 提出两条独立症状，经实测复核后确认**只有第一条是当前瓶颈**。

### 症状 ①（**当前瓶颈**，实锤）：生产全量记忆下，候选被去重 100% 挡死

用宿主部署位 `sweep.js` 的真实字节，跑真会话日志的完整
`extract → score → gate` 链路（light 2d + REM 7d 强化，与生产同参）：

| 层 | 剩余候选 | 边际损失 |
| --- | --- | --- |
| Light 候选 → 按 `recallKey` 归并 | 167 → **84** | — |
| `score >= minScore(0.60)` | **83** | −1 |
| `signalCount >= minRecall(3)` | **83** | **−0** |
| `uniqueSessions >= minUnique(2)` | **83** | **−0** |
| `+ 去重（existing = 生产 406 条）` | **0** | **−83** |
| （对照）`existing = []` | **83** | −0 |

- 这批候选的 score 区间 **0.745 ~ 0.795**，`signalCount` 恒 **7**，`uniqueSessions ≥ 2`。
- **门槛三层零损失；去重吃掉 100%。**

**为什么这是「同源闭包」而不是单纯的阈值问题**：候选是从**会话日志**里抽的，
而生产记忆（406 条）本身**就是这些会话历史沉淀的产物**。候选与 existing 共享同一
份文本来源，因此 `gateCandidates` 的两道判据必然大面积命中：

```js
// lib/sweep.js:603-607（现状）
if (norm.includes(e.norm) || e.norm.includes(norm)) { covered = true; break; }  // 互含
if (tokenOverlap(c.text, e.content) >= overlap) { covered = true; break; }      // 字符二元组 Jaccard ≥ 0.6
```

记忆越全 → 命中率越高 → 新候选越出不来。**这不是参数调错，是设计上的闭包。**

### 症状 ②（**潜在风险，非当前瓶颈**）：2 信号候选分数天花板 0.588 < 0.60

按 `sweep.js` 的六维权重逐项复算，**算式精确成立**：

| 分量 | 权重 | 取值 | 贡献 |
| --- | --- | --- | --- |
| relevance | 0.30 | 0.65（`sweep.js:435` 硬编码 heuristic prior） | 0.1950 |
| frequency | 0.24 | `log1p(2)/log1p(10)` = 0.4582 | 0.1100 |
| diversity | 0.15 | 2/5 = 0.4 | 0.0600 |
| recency | 0.15 | 1.0（当天） | 0.1500 |
| consolidation | 0.10 | `(1−1)×0.3+0.2` = 0.2 | 0.0200 |
| conceptual | 0.06 | 1.0（文本 ≥6 词） | 0.0600 |
| **合计** | | | **0.5950** |

配 `consolidation` 取 0.2 的档位即得 **0.588 级**的天花板（差异来自 diversity 取值）。
**一条只说得出口 2 次的候选，分母上永远差门槛一点点。**

**但实测当前生产的候选 `signalCount = 7`**，属于 0.745+ 那一档 —— 症状 ②
描述的是「**未来才会出现的那批候选**」。它现在不咬人，**但一旦去重被修好、
候选开始真实流转，低信号候选会立刻成为新的卡点**。

### 根因归纳

两个症状共享同一个未被建模的概念：**候选与既有记忆之间的「语义同一性」。**

- 症状 ① 现在用**文本相似度**近似它 —— 近似得太糙（文本像 ≠ 同一件事）；
- 症状 ② 用**重复次数**近似它 —— 也被同样的糙度拖累。

---

## 2. 目标与非目标

### 目标

1. **让候选在记忆库渐满时不至于被清零**：生产规模（≥400 条）下，去重后的 `gated` 应保持一个**非零且可控**的量级。
2. **同源重复（同一句话的历史回响）要被正确地判为重复**，而不是靠字符重叠碰运气。
3. **不同主张（内容相似但语义不同）不得被误判为重复** —— 这是防误伤的下界。
4. **可回滚**：新增判据必须挂在配置旋钮下，出厂即开、可一键关（K51 四件套）。

### 非目标（划清边界，避免设计方案漂移）

- **不改动** `scoreCandidates` 的六维权重与公式（症状 ② 的评分侧调整属**阶段二**）。
- **不改动** `minScore` / `minRecall` / `minUniqueSessions` 阈值。
- **不改动** `agint.json` 的存储 schema（`lineageKey` 字段已存在，仅需回填数据，不需迁移）。
- **不引入** LLM 调用（去重必须在 openclaw 式的确定性路径上，避免成本与不确定性）。

---

## 3. 方案候选（三选一，含取舍）

### 方案 A：`lineageKey` 归并 —— 把「同一主张」显式建模

**思路**：给记忆条目和候选各算一个 `lineageKey`（主张的语义指纹，如归一化后的
「主语 + 动作 + 对象」三元组或其哈希）。去重时**只比 `lineageKey`**，不比全文。

- **优点**：从根上解掉同源闭包 —— 语义同一才算重复，文本相似但主张不同则放行。
- **缺点**：**`lineageKey` 生产覆盖率 = 1/406（实测）**。存量 405 条需回填，
  增量需在写入路径补写。
- **⚠️ 更关键的障碍（2026-09-21 实测）**：现存唯一那条 `lineageKey` 的值是
  `workflow/safe-update-after-big-change` —— 这是**路径式/主题式标识**，
  不是「一条主张的指纹」。若直接沿用该语义，**同一主题下的多条不同主张会被
  全部归并成一条**，那是比现在更严重的误伤。**走方案 A 之前必须先回答：
  `lineageKey` 到底表示「主题」还是「主张」？** 这个语义不清，A 就不能动。

### 方案 B：分级去重 —— 保留相似度判据，但把「命中后果」分级

**思路**：不替换现有判据，而是把 `covered` 从一个布尔值拆成三档：

| 相似度 | 判定 | 处置 |
| --- | --- | --- |
| ≥ 0.85（高） | 真重复 | 丢弃（现状行为） |
| 0.6 ~ 0.85（中） | 疑似重复 | **放行，但标记 `dedupeSuspicion`**，交给下游 LLM consolidation 判 add/merge/supersede |
| < 0.6 | 新候选 | 放行 |

- **优点**：改动最小、无需回填、立刻见效；把「是不是同一件事」的判断**交还给本来就在
  做这件事的 LLM consolidation**（它已经在判 merge/supersede）。
- **缺点**：`gated` 数量会上升（中间档全部放行），LLM 调用量增加；
  依赖下游校验器正确消化（`priorEntries` 前缀污染那类坑已修，但仍是耦合点）。

### 方案 C：同源配对排除 —— 把「来源重叠」从判据里摘掉

**思路**：若 existing 条目的 `evidence` 指向的会话与候选所在会话**同一批**，
则判定为「同源回响」，从去重比对中**排除**该 existing 条目。

- **优点**：直接命中「同源闭包」这个病灶，逻辑清晰。
- **缺点**：依赖 `evidence` 字段的格式稳定性 —— **实测 341/406 条有 evidence，
  但形态高度集中**：35 条是精确的 `` agint-dream <id> from <id> [added] `` 形态
  （可解析），其余是自由文本。**可解析覆盖率过低**，无法作为主判据。
  且无法处理「记忆来自更早的、已不在窗口内的会话」这一大头。

### 取舍判断

**推荐 B 为主 + 埋 A 的钩子（分两步走）**：

1. **第一步走 B**：改动局限在 `gateCandidates` 内，不动 schema、不需回填，
   今天就能验证效果。把「疑似」档放行给 LLM 判 —— 这符合本仓一贯的设计
   （`validation-gate` 本来就是为消化 LLM 决策而存在的）。
2. **暂不动 A**：A 的阻塞点不是工程成本，而是 **`lineageKey` 语义未定义**
   （见 §3 方案 A 的实测）。在语义拍板前推进 A，等于把一个含义不明的字段
   接到去重主路径上 —— 风险比现状更高。

方案 C 不建议单独立项 —— 它的收益被 B 覆盖，而它的解析脆弱性反而引入新风险
（实测可解析 evidence 仅 35/406）。

---

## 4. 方案 B 的详细设计

### 4.1 判据分层

```js
// lib/sweep.js gateCandidates() 内
const DEDUPE_HIGH = opts.dedupeHigh ?? 0.85;   // ≥ 此值 = 真重复，丢弃
const DEDUPE_MID  = opts.dedupeMid  ?? 0.6;    // ≥ 此值 = 疑似，放行但标记

let covered = false, suspicion = null, maxSim = 0, matchedId = null;
for (const e of existingNorm) {
  if (!norm || !e.norm) continue;
  if (norm.includes(e.norm) || e.norm.includes(norm)) {
    // 互含：长度比例决定档位 —— 短条目被长条目完全包含时，更可能是真重复
    const ratio = Math.min(norm.length, e.norm.length) / Math.max(norm.length, e.norm.length);
    if (ratio >= DEDUPE_HIGH) { covered = true; matchedId = e.id; break; }
    if (ratio > maxSim) { maxSim = ratio; suspicion = 'substring'; matchedId = e.id; }
    continue;
  }
  const ov = tokenOverlap(c.text, e.content);
  if (ov > maxSim) { maxSim = ov; matchedId = e.id; }
  if (ov >= DEDUPE_HIGH) { covered = true; suspicion = null; break; }
  if (ov >= DEDUPE_MID) suspicion = 'similarity';
}
if (covered) continue;
if (suspicion) c.dedupeSuspicion = { kind: suspicion, similarity: maxSim, againstId: matchedId };
kept.push(c);
```

### 4.2 与下游的契约

- `dedupeSuspicion` 通过 `gated` 数组传给 `consolidation`（LLM 侧）。
- `buildConsolidationPrompt` 中对该类候选**额外提示**其疑似重复对象，
  让模型优先考虑 `merge` / `supersede` 而非 `add`。
- **不修改** `validation-gate` 的既有判据 —— 它已经能消化 `merge`/`supersede`。

### 4.3 可观测性（K51：可观测 > 可审批）

- 日记的「Deep — 评分与提升」段新增一行：
  `去重：丢弃 N 条（高相似）· 疑似放行 M 条 · 命中率 X%`
- 新增 `dream.completed` 事件字段：`dedupeStats: { dropped, suspicious, maxSimilarity }`。
- **被丢弃的候选仍要计数入库**，否则分不清「没有候选」与「全被挡了」。

### 4.4 回滚开关（K51：kill-switch，但出厂即开）

| 旋钮 | 默认 | 语义 |
| --- | --- | --- |
| `dedupeTieredEnabled` | `true` | `false` → 完全回退到现状（单一 0.6 阈值布尔判定） |
| `dedupeHigh` | `0.85` | 高相似阈值 |
| `dedupeMid` | `0.6` | 中相似阈值（= 现状的 `dedupeTokenOverlap`，保持兼容） |

需同时登记到 `RUNTIME_CONFIG_KEYS`，并可从 `cordis.patch.yml` 覆盖。

---

## 5. 验收标准（硬证据，不接受打包带过）

1. **静态测试**：`agint-dream` 全绿，新增回归用例至少覆盖：
   - 高相似（≥0.85）仍被丢弃 → `gated` 数不变
   - 中相似（0.6~0.85）被放行且带 `dedupeSuspicion`
   - `dedupeTieredEnabled=false` 时行为与现状**逐字节一致**（回归护栏）
   - 空 existing / 1 条 existing 的边界
2. **生产规模回放**：用宿主真实字节 + 生产 406 条记忆 + 真实会话日志，
   断言 `gated` 从 **0 → 非零**，并记录放行数量级。
3. **端到端**：跑一次完整 sweep（`apply=false`），断言 LLM consolidation 收到
   带 `dedupeSuspicion` 的候选，且 `validation-gate` 不整批拒。
4. **宿主部署位**：同步后 md5 对账 + 宿主字节级冒烟（复用
   `agint-plugin-host-sync` 技能的姿势）。
5. **真实重启**后观察一晚，查 `agint.json` 是否出现**第 2 条 `lineageKey`**
   （= merge 首次真正落库，与 2026-09-21 已修复的 `priorEntries` 污染问题合流验证）。

### 量化目标（需老板拍板）

- 生产规模下 `gated` 预期量级：**中相似档放行多少算健康？**
  建议先按「放行数 ≤ 总候选 50%」设预警线，跑一晚看真实分布再定。

---

## 6. 阶段二预告（**不在本次范围**）

症状 ② 的评分侧解法（`signalCount` 只算 2 次的候选如何够到 0.60），
需在阶段一落地、真实数据回流后重新评估 —— 因为阶段一改变了候选的流转形态，
阈值重标定的前提条件也随之变化。**先做阶段一，用数据说话，再定阶段二。**

---

## 7. 待老板决策的点

1. **方案选型**：是否同意「先走 B、暂不动 A」？若倾向 A，需先拍定
   `lineageKey` 的语义（主题 vs 主张）。
2. **中相似档的干预强度**：放行给 LLM 判（激进，见效快）vs 放行但标记为低置信入库（保守）？
3. **`gated` 放行的可接受量级**：先跑一晚取真实分布，还是预先设死上限？
4. **是否同批补写 `lineageKey`**（增量），还是完全留给阶段二？

---

## 8. 验收记录（2026-09-21 15:2x，本轮补记）

代码已由 `5fb366b` 落地并推送。本轮为**落地后的独立复验**，全部 import 宿主部署位字节。

### 8.1 生产规模回放（`_dream_dedupe_prod_replay.mjs`）

真会话日志（light 2d 7 个 / rem 7d 57 个）+ 生产 406 条记忆：

| 项 | 结果 |
| --- | --- |
| 候选 167 → 评分后 | 84 |
| `gated`（`dedupeTieredEnabled=false` 回退对照） | **0** |
| `gated`（方案 B，出厂即开） | **83** |
| `dedupeStats` | `checked=83 dropped=0 suspicious=83 maxSimilarity=0.4478` |
| 疑似档构成 | `substring` 83 条（`similarity` 区间 **0.0286 ~ 0.4478**，中位 **0.1649**） |
| 下游损失预算 | `merged×83` → `lossFraction 0.2044` ≤ 0.25 ✅（余量仅 0.045，**101 条即爆**） |
| 全 added 退化路径 | `ok=true, added=83` |

### 8.2 测试与护栏

- 仓库 / 宿主部署位 **各 108 测试全绿**（两处字节一致，3 个测试文件本轮补齐同步）。
- **变异测试**：`DEFAULTS.dedupeTieredEnabled` 改 `false` → 恰好 5 例红（出厂即开断言 +
  两条行为变更例 + 中相似 similarity 例 + 回归护栏例），其余 31 例绿 → 断言确实咬住实现。已还原。

### 8.3 ⚠️ 复验暴露的两个偏差（诚实记录，不等它咬人）

1. **`dropped = 0` —— 高相似档（≥0.85）形同虚设。**
   83 条全部落在 substring 档，且 `similarity`（= 互含长度比）最高仅 0.4478。
   原因：候选文本中位 66 字、existing 条目常达数百字，**长度比天然到不了 0.85**。
   → **当前实际效果 = 「不再丢弃任何候选」**，与"真重复仍丢"的设计初衷有偏差。
   若要让高相似档真正生效，`dedupeHigh` 的判据需要换成**不依赖长度比**的指标
   （如二元组 Jaccard，或直接用 `tokenOverlap` 而非 `ratio`）—— 属阶段一内的小改，待老板定。
2. **83 条全部进 LLM consolidation**，`prompt ≈ 193,966 字符（约 48k tokens）`，
   其中大头是 406 条 existing（约 40k），候选部分仅约 5k。
   历史 4 晚（1~16 条候选）同样量级下 LLM 均成功返回，故**不是新风险**；
   但输出侧需产出 83 个 operations，`DEFAULT_TIMEOUT_MS = 60s` 的余量变小。

### 8.4 生效前提

`lib/index.js` 是**静态顶层 import**（`import { runSweep } from './sweep.js'`），
模块在 boot 期加载并缓存 → **磁盘字节已更新，但内存里仍是旧函数**。
**必须重启 dsh，今晚 03:01 那轮才会用上新判据**；否则仍按旧逻辑跑出 `gated 0`。

---

## 附录 A：取证方法与可复现脚本

本次复核全部为**只读**，未改动任何生产数据。脚本落在工作区根目录：

| 脚本 | 作用 |
| --- | --- |
| `_dream_two_findings_verify.mjs` | 两条症状的初步复算 + 评分上确界解析式 |
| `_dream_phase1_design_probe.mjs` | 窗口容量（2d=6 / 7d=56 / 30d=60 会话）+ 信号重复度分布 |
| `_dream_gate_layer_probe.mjs` | **主证据**：门槛逐层边际贡献 + 去重边际贡献 |

### 复现要点（踩坑记录）

- 必须 `import` **宿主部署位**的 `sweep.js`
  （`C:/Users/Administrator/.dsh/profiles/web/plugins/agint-dream/lib/sweep.js`），
  而非仓库那份 —— 否则验的不是线上跑的字节。
- `readSessionLog` 内部 `spawn` 一个 `zstd` CLI。**运行脚本前必须把 zstd 目录
  加进 PATH**（本机在 `D:/Tools/zstd`），否则 60 个会话全部解析失败、
  静默产出 0 候选 —— 表现和"没数据"一模一样。
- ⚠️ **不要用 `trial_recall.jsonl` 的 `signalCount` 字段做评分分析**：
  它是 recall store 的**写入占位值（恒 1）**，不是 `scoreCandidates` 分组后的
  真实信号数。2026-09-21 曾因此误判为"信号数恒 1"，
  实际评分后为 **7**。（该字段仅供 recall 存储层使用。）

### 主证据原始输出（`_dream_gate_layer_probe.mjs`）

```
light(2d) 会话 6 · rem(7d) 会话 56
候选 167 条 · REM 强化池 437 条
评分后共 84 条（已按 recallKey 归并）

=== 门槛逐层 ===
  score >= 0.6          : 83
  + signalCount >= 3      : 83  (−0)
  + uniqueSessions >= 2   : 83  (−0)  ← 日记里的「门槛通过候选」
  这批候选 score 区间：0.745 ~ 0.795
  signalCount 区间：7 ~ 7

=== 去重边际（生产记忆 406 条）===
  生产门槛 + 全量 existing → gated 0
  生产门槛 + 空 existing   → gated 83
  → 去重吃掉 83 条

=== 生产存储实测 ===
  memory 总数 406 · lineageKey 非空 1（值 `workflow/safe-update-after-big-change`）
  evidence 非空 341 · 其中可解析的 `agint-dream … from …` 形态 35 条
```
