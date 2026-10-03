# Evolution Ledger v1.0（防篡改进化账本）

> **设计来源**：Phase-1 设计稿 §4.3（写入协议）/ §4.4（外部锚定）/ §4.5（proof 交接）/ §4.6（验收集）
> **载体**：`agint_evolution` 存储域的 `evolution_ledger` 表
> **唯一写入口**：`plugins/agint-evolution-memory/lib/ledger.js` → `createLedgerService().appendEntry()`
> **纯计算层**：`lib/ledger-hash.js`（entryHash / 批内 Merkle / roll-up / proof）
> **外部锚定**：`lib/ledger-anchor.js` → `docs/evolution-ledger-anchor.md`，由 cron `ledger-anchor` 调，⛔ 只 commit 不 push
> **独立校验器**：`bin/verify-ledger-chain.mjs`（⛔ 不 import 插件代码）
> **历史重建**：`lib/ledger-rebuild.js` + `bin/rebuild-ledger-history.mjs`
> **状态**：`DESIGN` —— 链、锚定、proof 三层机制全部实装且生产有 6 条，但**外部锚定 0 行**（见 §8）

---

## 1. 这是什么

Ledger 是一条**只追加**的哈希链。每一次进化决策（改了什么、预期多少、实际多少）写成一条条目，
条目里含一个自摘要 `entryHash`，它把前一条的摘要也包进去。

**一句话判据**：改动第 3 条，第 4 条及以后的 `entryHash` 全部对不上。

它防的是「事后把不利于自己的记录改掉或删掉」。它防不了「整段尾部删掉且不留空洞」——
那是 §5 外部锚定要解决的事。

---

## 2. 两条硬约束

| # | 约束 | 违反的后果 |
|---|---|---|
| **A** | 条目**只追加，永不重写** | 重写即自毁证据：`entryHash` 变了，后面全链失配，而「重算使其自洽」正是最坏结果 |
| **B** | 任何写入都必须经 `lib/ledger.js` | 独立进程直写会被宿主**静默覆盖**（§6） |

约束 B 的机器形式：写入口只有一条，且落盘前有 CAS 复核（§4）。

---

## 3. 条目形状

`ledgerEntrySchema`（`lib/schema.js`）。`entryHash` 只吃 7 个字段
（`ENTRY_HASH_FIELD_ORDER`，见 §3.2）。

### 3.1 字段分两组

| 组 | 字段 | 规则 |
|---|---|---|
| **入哈希**（不可变） | `seq` `contractId` `generation` `summary` `parentHash` `references` `timestamp` | 一旦落盘永不修改 |
| **不入哈希** | `chain.entryHash` `chain.batchRoot` `chain.merkleRoot` `anchorStatus` `anchorSeq` `integrity` `reconstructed` `evidenceCompleteness` | 派生值或事后回写 |

⛔ **最后这组参与哈希会让机制拆自己的台**：锚定成功那一刻要回写 `anchorStatus`，
若它在哈希里，那次回写当场把条目判成 `TAMPERED`（这是 v1.2 勘误 #8 的存在理由）。

`chain` 对象**只取 `parentHash`**，不整体入哈希——整体入会把两个派生摘要带进来，
形成循环依赖。

### 3.2 枚举取值（生产实测值，非设计稿示例）

| 字段 | 枚举 | 来源 |
|---|---|---|
| `summary.mutationType` | `PROMPT_MUTATION` / `TOOL_SYNTHESIS` / `STRATEGY_REWRITE` | `LEDGER_MUTATION_TYPES` |
| `summary.decision` | `AUTO_DEPLOY` / `PENDING_REVIEW` / `REJECT` / `ABSTAIN` | `LEDGER_DECISIONS` |
| `timestamp` | `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` | UTC + 毫秒 + `Z`，无例外 |

⚠️ 设计稿示例里的 `mutationType: "MEMORY"` **永远不会产生数据**（生产 mutator 只有 3 类，勘误 #5）。
照抄示例会造出永不入链的条目。

`REJECT` 与 `ABSTAIN` **同样入链**：Ledger 记的是「进化发生过什么」，不是「进化成功过什么」。
只记成功 = 幸存者偏差 = 账本自动说谎。

### 3.3 哈希顺序不可反

写入侧顺序固定：归一（`ledgerEntryCoreSchema.parse`）→ 用**归一值**算 `entryHash` → 落盘。

⛔ 反过来做会自证为 `TAMPERED`：zod 的 `z.object` 默认**静默丢弃未知键**，
拿未归一的输入算哈希，落盘条目会少几个键，校验器从存储重算得到不同摘要。

---

## 4. 写入协议（`lib/ledger.js`）

一次 `appendEntry` 的固定顺序：

```
加进程内单写者锁
  → 幂等查（同 contractId 命中即返回既有条目）
  → 取 head / 派生链状态
  → 归一 + 校验
  → 算 entryHash
  → 滚动更新批根与 roll-up 根
  → CAS 复核（落盘前最后一道闸）
  → 单条 put
  → 释放锁
```

### 4.1 单写者锁

宿主只为**单次 put** 排序，不为「读快照 → 算 hash → 写」这段临界区排序。
不上锁 ⇒ 两个并发 append 都算出同一个 `nextSeq` ⇒ 后者覆盖前者 ⇒ **链上凭空少一条，且 head 摘要变了**（比丢条目更难查）。

### 4.2 幂等键 = `contractId`

同 `contractId` 二次追加返回既有条目，不新增。否则 cron 重跑 / 进程重启补写会产生
两条同 `contractId` 不同 `timestamp` 的条目 = **一条合法的分叉链**。

⛔ 幂等查必须在锁**之内**。查在锁外 ⇒ 两个并发同 `contractId` 都查不到，各写一条 ⇒ 幂等形同虚设。

### 4.3 seq 空洞按篡改级处理

`nextSeq - 1` 不在表内 ⇒ 抛 `LEDGER_GAP`，**不填洞、不猜前驱**。
空洞的原因可能是写丢失，也可能是有人删了条目——两种都不能自动补。

### 4.4 CAS 复核（防绕过 service 的直写）

落盘前查两件事：

| 查什么 | 失败码 |
|---|---|
| 前驱条目的 `entryHash` 与快照不符 | `LEDGER_CAS_CONFLICT` |
| 目标 `seq` 槽位已被占 | `LEDGER_CAS_CONFLICT` |

两者都**拒绝写入 + 告警，不重试、不覆盖**。覆盖 = 把违例证据洗掉。

### 4.5 逐条同步，失败即抛

一条一 `await put`，⛔ 不做多条目事务批，⛔ 不降级。

理由：批内崩溃 = seq 空洞 = 断链，而断链在 Ledger 里是安全事件不是性能事件。
另：`log-buffer.js` 的「flush 失败降级写 `buffer-lost:<n>`」对 `evolution_log` 可接受，
对 Ledger 不可接受——「降级即成功」会把证据消失说成写入成功。

---

## 5. Merkle 批与 proof（`lib/ledger-hash.js`）

| 常量 | 值 | 说明 |
|---|---|---|
| `LEDGER_BATCH_SIZE` | `8` | **规格常量，不是性能旋钮**。改它会让历史 proof 形状变化 |
| 首个 `parentHash` | `GENESIS_PARENT_HASH` = `sha256:0*64` | 代码常量写入 |
| roll-up | `root(k) = sha256(canonical([root(k-1), batchRoot(k)]))` | 链式根 |

### 5.1 追加成本 O(1) 摊销

只在本批叶子（≤8）上重算批根，批满则 roll-up 一层。⛔ 不重扫全表。

### 5.2 奇数节点与自身配对

`h(x + x)`。⚠️ 这与「把该节点上抛一层」是两种不同做法，两者都自洽但不统一就跨实现分叉。
本行为由 `fixtures/ledger-hash-vectors.json` 的 `merkle.oddSelfPaired` 锁定。

### 5.3 叶子形状 fail-closed

`assertHashString` 卡 `^sha256:[0-9a-f]{64}$`。缺数据时 `canonicalHash` **不会抛错**，
它会把 `null` 老老实实序列化进树里 ⇒ 算出一个「看起来正常」的根，而根下面根本没有证据。
这是最糟的失效形态：校验恒绿。

### 5.4 proof 里两层「根」的语义不同

| | 含义 |
|---|---|
| 条目自带 `chain.merkleRoot` | 「我入链那一刻链长什么样」（自证连续性） |
| proof 的 `merkleRoot` | 「这批最终长什么样」（对外可验证） |

批内非末条存的是「批还没长完」时的部分根。验证一条属于**已完成的批**时，
比对对象是该批**批末条**存的 `merkleRoot`。拿部分根证最终态必然 `MERKLE_ROOT_MISMATCH`——
这不是 bug，是两层语义。

---

## 6. 唯一写入口与落盘语义

宿主把整个 unit 读进内存 Map，每次 `putRecord` 用内存态**整体重写**文件
（`@deepseek-ai/dsh-storage-json/lib/index.js:215-226`，注释自述 "last-write-wins"）
⇒ **独立进程写进去的行会在下一次宿主写入时被静默覆盖**。

| 动作 | 允许的通道 |
|---|---|
| 追加条目 | 宿主服务 `agint.evolution.ledger.append()` |
| 回写锚定标记 | 宿主服务 `agint.evolution.ledger.markAnchored()` |
| 重建历史条目 | 宿主服务 `agint.evolution.ledger.rebuild()` |
| 只读预览 | `bin/anchor-ledger.mjs` / `bin/rebuild-ledger-history.mjs` / `bin/verify-ledger-chain.mjs` |

⚠️ 宿主表句柄只有 `get/keys/entries/size/put/delete/update`，**没有 `has()`**，
所以判占位用 `get`。

---

## 7. 外部锚定（§4.4）

### 7.1 为什么内部链不够

内部链证明「这张表没被改过」，但证明不了「这张表没被整段截掉」——
删掉尾部若干条不留空洞，剩余条目各自存的仍是追加那一刻的前缀值，重放自洽。
校验器把这个盲区明说成 `TAIL_TRUNCATION_UNCHECKABLE`。

要抓截断，必须有一个**链外**的计数器与摘要。

### 7.2 锚定 = 往一个由 git 历史记账的文件追加一行，然后本地 commit

锚点文件 `docs/evolution-ledger-anchor.md`，一行 = 一次锚定，6 列：
`锚定时间(UTC) | Ledger Seq | Head Entry Hash | Rollup Root | Entry Count | Prev Anchor Commit`。

**顺序即语义，不可调换**（`lib/ledger-anchor.js` 头注 7 步）：

1. 取链头与条目数（空链 ⇒ `LEDGER_EMPTY`，不写行）
2. 反查上一锚点行的引入 commit ⇒ 新行的 `Prev Anchor Commit`（首行固定 `GENESIS`）
3. 追加一行（⛔ 不改写历史行）
4. `git add` + `git commit` **只带本文件 pathspec**
5. 提交失败 ⇒ 还原文件内容，报 `ANCHOR_COMMIT_FAILED`
6. 提交成功 ⇒ 才回写 `anchorStatus`/`anchorSeq`
7. 发 `evolution.ledger.anchored` 事件（观测失败不阻断）

### 7.3 三条纪律

| # | 纪律 | 理由 |
|---|---|---|
| 1 | **⛔ 只 commit，绝不 push** | push 是对外动作。L1→L2 升级必须由人手工确认；代码里连 push 都不写，避免「以后顺手加上」 |
| 2 | pathspec 提交 | 裸 `git commit` 会把**别人已暂存**的改动卷进锚定提交 = 篡改别人的意图 |
| 3 | 提交成功才回写标记 | 留在工作区没进 git 的一行**不是锚点**。先回写就是撒谎 |

第 1 行的 `Prev Anchor Commit` 固定 `GENESIS`：一个 commit 的 SHA 不可能出现在它自己的内容里。
文件有行但 git 查不到 commit ⇒ `ANCHOR_FILE_UNCOMMITTED`，拒绝继续。

### 7.4 信任层级（报告口径由校验器决定，不由写报告的人决定）

| 级 | 判据 | 口径 |
|---|---|---|
| **L0** | 无锚点行 | 对外不得宣称「已外部锚定」 |
| **L1** | 锚点行在本地 git 里，远端未比对 | 同上 |
| **L2** | 最新锚点行的引入 commit 已包含于 `origin/main` | 可称外部锚定 |

`push` 是人工动作 ⇒ 自动化只能到 L1。

---

## 8. 独立校验器（`bin/verify-ledger-chain.mjs`）

### 8.1 独立性纪律 #1：⛔ 不 import 插件代码

校验器若复用写入方代码路径，写入侧的 bug 会同时污染「写入」与「校验」⇒ 恒真门禁。所以它：

- 直接读 `agint_evolution.json` 的**文件字节**，不碰 storage 后端、不起 domain
- 自带**第三份** canonical + 批树 + roll-up 实现
- `entryHash` / `batchRoot` / `merkleRoot` **全部从存储字段重算**，绝不采信文件里存着的值

三份实现由 `fixtures/ledger-hash-vectors.json` 锁死，任一方漂移即变红。

### 8.2 用法与退出码

| 命令 | 作用 |
|---|---|
| `--full` | 整链校验（O(N)） |
| `--entry <seq\|contractId>` | 单条 + Merkle proof |
| `--anchor` | 锚点文件最新行 vs 链 head |
| `--anchors` | 锚点文件**全部 git 历史**重放 |
| `--since <ISO>` | 只验某时刻之后的条目 |

退出码：`0` 通过 / `1` 校验失败 / `2` 脚本自身出错。⛔ 只读，永不写条目、锚点文件或 git 状态。

### 8.3 主要判定码

| 码 | 级别 | 含义 |
|---|---|---|
| `SEQ_GAP` | fail | seq 不在表内（写丢失或删条目） |
| `ENTRY_HASH_MISMATCH` | fail | 重算摘要与存储值不符 |
| `PARENT_HASH_BROKEN` | fail | 前驱链接断 |
| `BATCH_ROOT_MISMATCH` / `MERKLE_ROOT_MISMATCH` | fail | 批内叶子被改写 |
| `ANCHOR_NO_ROWS` | fail | 从未锚定 |
| `ANCHOR_MISMATCH` / `ANCHOR_ROLLUP_MISMATCH` | fail | 锚点与链头不符 |
| `ANCHOR_AHEAD_OF_CHAIN` | fail | 锚点声称的条目不存在 |
| `ANCHOR_ROWS_SHRANK` / `ANCHOR_ROW_REWRITTEN` | fail | 锚点历史被改 |
| `TAIL_TRUNCATION_UNCHECKABLE` | note | 尾部截断链内不可察觉（**这是设计边界，不是缺陷**） |
| `BATCH_OPEN` | note | 批未满，其根仍会随追加变化 |
| `LEDGER_EMPTY` | note | 表内 0 条 |

⛔ 处置只有「标记、告警、冻结、人工取证」。本脚本**不修复、不重写**任何条目。

---

## 9. 历史重建（§4.3.5）

`lib/ledger-rebuild.js` 从 `event_bus` 的 mutation 事件 + `agint_population.variants` +
`.agint-preimage` 落盘证据反推 Phase 1 之前的进化条目。

### 9.1 两个「不做」

| 不做 | 理由 |
|---|---|
| 不重建 Contract / `contract_locks` | `hypothesisLock` 的全部语义是「预测**先于**执行被锁定」，靠时间先后。今天再算一份锁，证明的只能是「今天算的」——**用伪造的证据去保护证据** |
| 不推测任何参与哈希的字段 | schema 要求非空而证据缺失时进 `blockers`，不补一个看起来合理的值 |

### 9.2 三个标记的确切含义

| 标记 | 含义 |
|---|---|
| `contractId = "REBUILD:<proposalId>"` | **幂等键的命名空间**，不是「存在一份 Contract」的宣称 |
| `generation = "GEN-UNKNOWN"` | 显式未知标记。有证据时取 `variants.generation` → `GEN-<3 位>` |
| `evidenceCompleteness` | `FULL` = 该有的证据槽全部落实；`PARTIAL` = 有槽未落实 |

⚠️ 重建条目的 `predictedDelta` / `actualDelta` / `predictionQuality` / `predictionSource` 恒为 `null`，
且**不计入** completeness——它们是 Phase 1 往后才有的字段，算进「缺证据」会让每条重建都自动 PARTIAL，标记失去分辨力。

### 9.3 时序硬约束

重建只允许发生在**首条实时条目入链之前**。链上一旦有 `reconstructed: false` 的条目，
向中间插入会让后续 `parentHash` 集体失配 ⇒ `REBUILD_TIMING_VIOLATION` 拒绝。
⛔ 不提供 `force` 开关。

---

## 10. 当前实况（2026-10-03 实测）

| 项 | 状态 | 证据 |
|---|---|---|
| 链完整性 | ✅ 6 条，seq 1-6，无空洞 | `node bin/verify-ledger-chain.mjs --full` |
| Merkle | ✅ 1 批，roll-up root `sha256:949345879ab0…` | 同上 |
| 锚定状态 | ⚠️ **0 ANCHORED / 6 PENDING** | 同上 |
| 锚点文件 | ⛔ **0 行** ⇒ 从未锚定 | `--anchor` 报 `ANCHOR_NO_ROWS` |
| 批状态 | 批 1 未满（6/8） | `BATCH_OPEN`（note，非缺陷） |
| 条目构成 | 6 条全 `reconstructed: true`，实时 0 条 | `bin/rebuild-ledger-history.mjs` |
| 重建窗口 | ✅ 开（链上无实时条目） | 同上 |
| 实时入链 | ⛔ 0 条 | 链头 seq 6 全是重建条目 |
| 生产表 | ✅ `evolution_ledger` 存在且有 6 行 | 与 `INDEX.json` 里「0 行」的旧记载**不一致，以本表为准** |

⇒ **「Ledger 已跑通」这句话现在还不能说。** 跑通的是**链**，不是**账本**——
账本要有外部锚定才成立，而锚点文件 0 行。

---

## 11. 已知偏差与阻塞

| # | 偏差 | 处置 |
|---|---|---|
| 1 | `INDEX.json` / `evolution-package-v1.md` 里记的「生产 0 行」已过期（实测 6 行） | 本规范以实测为准；两处旧记载待下次重生成时订正 |
| 2 | 锚点文件 0 行 ⇒ 信任层级停在 **L0** | 首次锚定需部署 + 重启后走 cron `ledger-anchor`（周一 10:15） |
| 3 | 6 条全是重建条目，实时入链 0 条 | 链的内容目前只证明「过去发生过 6 次进化」，不证明「链在工作」 |
| 4 | `evolution-package` 的 `ledgerProofAvailable` 恒 `false` ⇒ R2 不可达 | 硬前置：链上有 `ANCHORED` 条目 |

---

## 12. 验收集（§4.6 摘要）

| # | 项 | 判据 |
|---|---|---|
| 1 | 追加 O(1) 摊销 | 不重扫全表 |
| 2 | 三份实现一致 | `fixtures/ledger-hash-vectors.json` |
| 3 | proof 交叉验证 | `verifyBatchPath` 独立于 `computeBatchRoot` |
| 4 | 外部锚定 | 锚点文件 ≥1 行 + `--anchors` 全历史重放通过 |
| 5 | 锚点链完整 | 每行 `Prev Anchor Commit` 指向上一行的引入 commit |
| 6 | 单写者 | 并发 append 不产生分叉 |
| 7 | 重建可复现 | `rebuildPlan` 两次跑出同一份计划 |

---

## 13. 未落地项的下一步

1. 部署 + 重启后跑一次 cron `ledger-anchor` ⇒ 锚点文件落第一行，信任层级 L0 → L1
2. 第一条**实时**条目入链（`reconstructed: false`）⇒ 重建窗口关闭
3. 链上有 `ANCHORED` 条目后，`evolution-package` 的 `ledgerProofAvailable` 才可能为 `true` ⇒ R2 解锁
4. L1 → L2 需人工 `git push`（自动化永不做）
