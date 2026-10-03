# Evolution Package v1.0（可复现进化包规范）

> **设计来源**：[Phase-3 设计方案 §3](../../DSH-AGINT.wiki/Phase-3%20Self-Improving%20Harness%20Ecosystem%20设计方案.md)
> **状态**：`DESIGN` —— 规范已定；**导出与校验程序已实施**（`bin/export-evolution-package.mjs` · `bin/verify-evolution-package.mjs`，见 `INDEX.json` 的 `implementedBy`）
> **索引**：[`INDEX.json`](./INDEX.json)
> ⚠️ **本文档描述的是「要做什么」。已实施范围以 `INDEX.json` 的 `implementedBy` 为准 —— 两者不一致时以索引为准，且那本身就是一处诚实性缺陷。**
>
> **当前实况（2026-10-03 端到端实跑）**：
> - ✅ 已实施：D1–D6 脱敏、可复现打包（tar+gzip 定 mtime/level）、逐文件 hash、Merkle root、包内外双路校验。
> - ⚠️ **部分实施**：`01-code/diff.patch` 仍只给 `preimage-manifest.json` 清单（需 diff 工具生成）⇒ **代码级复现 R1 依赖接收方自行比对 preimage**。
> - ⚠️ `reproductionLevel` **实算**（非硬编码）：需 git HEAD + preimage 同时成立才给 R1，否则降级为 **R0**（R0 = 只能复现「包内容本身」，规范 §2 未列此级，是实现补的诚实档）。
> - ⛔ `02-contract/`、`03-evaluation/benchmark-results.json` 等分区**尚未产出**（依赖 contract-manager 挂载与 Evolution Ledger 锚定）。
> - ⛔ `ledgerProofAvailable` 恒为 `false`（生产 `evolution_ledger` **有 6 条但 0 条 ANCHORED**，锚点文件 0 行，2026-10-03 实测）⇒ **R2 不可达**。详见 [`evolution-ledger-v1.md` §10](./evolution-ledger-v1.md)。

---

## 1. 这是什么

一次进化（Generation）的**可移交证据包**。接收方拿到它，应该能回答三个问题：

1. 这次进化改了什么？（代码 diff）
2. 为什么改？（决策记录 + 锁定校验）
3. 改完效果如何？（评估结论 + **它的可信度边界在哪**）

⚠️ **本规范最重要的设计目标是「诚实」**，不是「完整」。
包里**必须**写清哪些部分无法复现、为什么无法复现、评估结论的可信度受什么限制。
宁可承认不可复现，不要让接收方误以为可以完全重演。

---

## 2. 三级复现能力（诚实分级）

| 级别 | 含义 | 可达性 | 依赖 |
|---|---|---|---|
| **R0** | **包内容复现** —— 接收方能验证「包没被换过」，但**对不上任何代码** | ✅ 可达（退化档） | 无（01-code 为空时的诚实表述） |
| **R1** | **代码级精确复现** —— 接收方能得到与当时**逐字节相同**的代码 | ✅ 可达 | preimage 备份 + git |
| **R2** | **决策级复现** —— 接收方能验证「为什么这么改」，含时间锚 | ⚠️ 部分可达 | Evolution Ledger（Merkle 链） |
| **R3** | **完整重演化** —— 接收方重跑 LLM 得到同样的变异 | ⛔ **不可达** | 见下 |

⭐ **R0 是实现补的档，不在原始设计里**。加它的理由：R1 的两个依赖
（git HEAD + preimage）**可能同时不成立**（如在没有 .git 的导出环境里跑导出）。
此时只有两个选择 —— 继续标 R1（**虚报**，接收方据此以为能精确复现，实际什么都对不上），
或标一个更低的档。**「拿不到就说拿不到」是本规范的第一原则。**
`bin/verify-evolution-package.mjs` 会独立核对：声明 R1 但 01-code 为空 ⇒ 报红。

### 2.1 R3 为什么不可达（三条根本原因）

```
1. 变异由 LLM 生成，**非确定性**。同 prompt + 同模型 ≠ 同输出（采样温度、模型版本漂移）。
2. 模型侧不可复现。宿主模型由 dsh 解析（agentDefaultModel.currentSelection()），
   AGINT 侧只做**运行时解析**、不硬编码 provider/model ⇒ 接收方的默认模型几乎必然不同。
3. 时间维度不可复现。工具链、网络、外部服务状态随时间变。
```

⛔ **因此 `06-verification/verify.mjs` 不得输出 `FULLY_REPRODUCIBLE` 之类的字样** ——
这是硬约束，不是文风问题。对外承诺兑现不了的损害远大于承认限制。

---

## 3. 包结构

```
evolution-package-GEN-0NN.tar.gz
│
├── manifest.json                    ★ 包清单（必读入口）
│
├── 01-code/                         第 1 层：代码资产（可精确复现）
│   ├── git-commit.txt               该期进化的 commit hash
│   ├── diff.patch                   preimage → postimage 的完整 diff
│   └── changed-files/               改动文件的 postimage 副本
│
├── 02-contract/                     决策记录
│   ├── contract.json                Evolution Contract（完整）
│   ├── strategy-decision.json       Decision Record（含 alternativesConsidered）
│   └── lock-verification.json       hypothesisLock 校验结果（防事后编造的证据）
│
├── 03-evaluation/                   评估结论
│   ├── benchmark-results.json       按 visibility 分层的评估结果
│   ├── inventory-snapshot.json      当时的场景清单快照（含 123 单元的 hash）
│   ├── harm-report.json             HARM 四维 + policy 决策
│   └── PROVENANCE.json              ★ 基准来源声明（见 §6）
│
├── 04-runtime-snapshot/             第 2 层：runtime 状态（⚠️ 已脱敏，见 §4）
│   ├── agint_evolution.json         进化记忆（白名单表，见 D1）
│   ├── agint_population.json        种群与谱系
│   ├── agint_mutator.json           变异记录
│   ├── agint_event_bus.json         ⚠️ 仅导出与该期相关的事件（按 contractId/traceId 过滤）
│   └── REDACTION-REPORT.json        ★ 脱敏报告（见 D5）
│
├── 05-environment/                  第 3 层：宿主环境（仅记录，不可复现）
│   ├── dsh-compat.json              AGINT↔dsh 兼容矩阵（解析 VERSION 文件）
│   ├── model-context.json           实际使用的 provider/model/modelSource
│   ├── node-modules-manifest.json   宿主私有包清单（名称与版本，不含内容）
│   └── NOT-REPRODUCIBLE.md          ★ 显式声明哪些部分无法复现及原因
│
└── 06-verification/                 完整性校验
    ├── package-hash.json            全包 hash 清单（每个文件 sha256）
    ├── ledger-proof.json            Merkle proof（当前必为 NOT_AVAILABLE，见 §6）
    └── verify.mjs                   接收方一键校验（零依赖，只用 node 内置模块）
```

### 3.1 `manifest.json` 结构

```json
{
  "packageVersion": "1.0",
  "packageId": "EVO-PKG-GEN-003",
  "generation": "GEN-003",
  "contractId": "EVO-2026-003",
  "createdAt": "<ISO8601>",
  "createdBy": "bin/export-evolution-package.mjs",

  "reproductionLevel": "R1",
  "reproductionCaveats": [
    "变异由 LLM 生成，重跑结果不保证相同（R3 不可达，见规范 §2.1）",
    "宿主私有包未随包分发，需接收方自行安装 dsh",
    "判定基准非外部锚定（NOT_ANCHORED），评估结论的可信度受限（见 §6）"
  ],

  "integrity": {
    "packageHash": "sha256:<对全部文件 hash 的 Merkle root>",
    "fileCount": 0,
    "ledgerProofAvailable": false,
    "ledgerProofReason": "生产 evolution_ledger 6 条中 0 条 ANCHORED、锚点文件 0 行（2026-10-03 实测）⇒ 无可用 Merkle proof"
  },

  "redaction": {
    "performed": true,
    "policy": "docs/specs/evolution-package-v1.md#脱敏策略",
    "report": "04-runtime-snapshot/REDACTION-REPORT.json",
    "reversible": false
  },

  "contents": { "01-code": "…", "02-contract": "…", "…": "…" }
}
```

---

## 4. 脱敏策略（**本规范最高风险点**）

### 4.1 风险定性

导出 = 把 `.gitignore` 保护的数据**打包离开本机**。按行为红线，这属**高风险外发动作**。

| 数据 | 敏感内容 | 证据 |
|---|---|---|
| `agint.json`（memory 域） | 长期记忆，`type ∈ {lesson, decision, preference, pattern}` —— **`preference` 与 `decision` 极可能含用户个人偏好与决策** | `agint-memory/lib/index.js:26` 实测枚举 |
| `$AGINT_HOME/wiki/` | 内部知识库 | `.gitignore` 实测明确「不进版本控制」 |
| `$AGINT_HOME/reviews/` | 周复盘报告，含人工评审意见 | 同上 |
| `$AGINT_HOME/dreams/` | 梦境日记（LLM 生成的自由文本） | 同上 |
| `agint_session_extract` | 会话抽取数据 | `架构.md:174` |
| `agint_event_bus.json` | 事件载荷，可能含文件路径、提案正文 | `架构.md:428` |
| `.agint-preimage/*.bak` | 改动前文件全文，含**绝对路径** | Phase -1 已证多机路径硬编码问题 |
| `agint_ov_strategy` | OpenViking 投影（外部服务） | `架构.md:175` |

### 4.2 六条强制脱敏规则

```
规则 D1（默认排除，白名单准入）：
  ⛔ 默认【不导出】：memory 域全文、wiki/、reviews/、dreams/、session-extract、ov-strategy
  ✅ 仅导出白名单：evolution_log / failure_pattern / success_template / population /
                  mutator / mount / abtest / event_bus（过滤后）/ contract / decision record
  理由：进化复现需要的是【进化机制的状态】，不是【Agent 记住的用户信息】。
        白名单外的数据对复现无贡献，只有泄露风险。

规则 D2（绝对路径泛化）：
  所有导出内容中的绝对路径 → 占位符
    D:/DSH/...            → <AGINT_REPO>/...
    C:/Users/<name>/.dsh  → <DSH_HOME>
    /home/<name>/...      → <HOME>/...
  实现：正则替换 + 替换后逐文件复核（防漏）
  ⚠️ 路径泛化会破坏 preimage 的可直接还原性 ⇒ 01-code/ 的 diff 用相对路径

规则 D3（自由文本敏感扫描）：
  evolution_log / failure_pattern 的文本字段可能含敏感片段
  → 导出前跑敏感模式扫描（凭据形态、邮箱、手机号、内网地址）
  → 命中则【整条排除】并记入 REDACTION-REPORT，不做部分遮蔽
  理由：部分遮蔽易漏；整条排除虽损失信息但安全（安全 > 效率）

规则 D4（人工确认闸门）★ 不可跳过：
  导出分两步：
    Step 1  export-evolution-package.mjs --dry-run
            → 产出「将要导出的文件清单 + 大小 + 脱敏动作预览」
            → 不落盘任何真实数据
    Step 2  人工审阅 dry-run 清单后，显式执行 --confirm
            → 才真正打包
  ⛔ 无 --confirm 时脚本拒绝产出包（fail-closed）
  理由：脱敏规则再严也可能有未预见的敏感内容。
        数据离开本机前的最后一道防线必须是人。

规则 D5（脱敏报告强制产出）：
  REDACTION-REPORT.json 必须记录：
    - 排除了哪些域/文件（及规则编号 D1/D3）
    - 泛化了多少处路径（D2）
    - 整条排除了多少记录（D3）
    - 声明 irreversible: true（脱敏不可逆，接收方无法还原原文）
  ⛔ 报告为空 = 脱敏未执行 = 导出失败（不得静默通过）

规则 D6（发布 ≠ 导出）：
  导出包落在 $AGINT_HOME/packages/（gitignore，不进仓库）
  ⛔ 脚本【不做】任何上传/发布动作
  理由：导出是本地动作，发布是外发动作，风险等级不同，不得合并。
```

---

## 5. 接收方校验（零依赖）

`06-verification/verify.mjs` 的约束：

- **只用 node 内置模块**（`node:crypto` / `node:fs` / `node:path`）
- 接收方可能没有 AGINT 的任何依赖，甚至没有 dsh

功能：

1. 逐文件计算 sha256，与 `package-hash.json` 比对
2. 重算 Merkle root，与 `manifest.integrity.packageHash` 比对
3. 校验 `contract.json` 符合 `evolution-contract-v1.schema.json`（内嵌精简校验器）
4. 校验 `inventory-snapshot.json` 的单元 hash 自洽
5. 若 `ledger-proof.json` 可用 → 验证 Merkle proof；否则输出 `NOT_AVAILABLE` 并说明原因
6. 输出分级结论：
   - `INTEGRITY_VERIFIED` —— 包未被篡改
   - `STRUCTURE_VERIFIED` —— 结构符合协议
   - `REPRODUCTION_R1` / `R2` —— 可达的复现级别
   - ⛔ **不得输出 `FULLY_REPRODUCIBLE`**（R3 不可达，见 §2.1）

---

## 6. PROVENANCE：基准来源必须如实标注

external-anchor 提案指出的 **G1**（判定基准与被评对象同池、可写、无 provenance）
直接影响本包的信任模型：

```
导出包若包含「该次进化通过了基准评估」的声明，
而该基准存于 agint_evolution.success_template
  （上限 50、有 model-visible 写工具 evolution_addSuccess、无 provenance）
⇒ 接收方无法验证这个声明：基准可能在导出前被被评对象改写过
```

⇒ 本规范要求：

1. `03-evaluation/PROVENANCE.json` 显式标注「基准来源 = `success_template` 同池可写，非外部锚定」
2. 提供 `baselineProvenance` 字段（若可得），不可得则标 `NOT_ANCHORED`
3. **不得声称**导出包的评估结论「不可篡改」

⚠️ **这是诚实降级，不是缺陷掩盖。** 完整信任模型需等 external-anchor 提案实施。

---

## 7. 与 preimage 机制的关系

**复用已有能力**（不新建备份机制）：

- `agint-evolution-driver/lib/index.js:1070-1072` 生成 `.agint-preimage/<name>__<stamp>.bak`
- `index.js:1264-1283` 的 `restoreFromPreimage` **不依赖 git**

⇒ `01-code/diff.patch` **可直接从 preimage 与当前文件对比生成**，无需依赖 git 历史。
这对 gitignore 的部署位改动尤其重要（部署位改动不在 git 里）。

### 7.1 preimage 保留期（**当前无策略，是已知缺口**）

| 事实 | 影响 |
|---|---|
| `.agint-preimage/` 在 `.gitignore` 内 | 不进版本控制 |
| **无保留策略**（实测未见清理逻辑） | preimage 可能已被覆盖或清理 |
| ⇒ 某期 preimage 缺失 | **该期无法导出 R1 级包** |

⇒ 本规范规定保留期：**≥90 天或 ≥20 期，取较长者**。
由 `bin/check-preimage-retention.mjs` 检查并**告警**（⛔ 不自动删除，理由见下）。

⛔ **为什么只告警不删除**：
1. 删除是不可逆动作，需人工确认
2. preimage 是回滚的**唯一依据**（`restoreFromPreimage` 不依赖 git），误删会永久失去该期回滚能力
3. 若确需清理，走「先归档到 `.agint-backups/`」的可恢复路径

---

## 8. 验收标准

| # | 验收项 | 判据 | Tier |
|---|---|---|---|
| 1 | 复现级别诚实分级 | R3 标注不可达及三条原因 | A |
| 2 | 包结构完整 | 6 分区 + `manifest.json` 齐备 | A |
| 3 | **D4 人工闸门生效** | 无 `--confirm` 时拒绝产出包（fail-closed） | A |
| 4 | **D1 白名单生效** | 包内**不含** memory 全文 / wiki / reviews / dreams / session-extract | A |
| 5 | D2 路径泛化完整 | 包内 grep `C:/Users` / `D:/DSH` / `/home/` → 0 命中 | A |
| 6 | D3 敏感扫描生效 | 构造含凭据形态的记录 → 整条排除且记入报告 | A |
| 7 | D5 脱敏报告非空 | 空报告 → 导出失败 | A |
| 8 | D6 不含发布逻辑 | 脚本内无网络调用 / 上传代码 | A |
| 9 | 包落 gitignore 位置 | 仓库内无包文件 | A |
| 10 | verify 零依赖 | 无 `node_modules` 的干净目录可运行 | A |
| 11 | verify 不过度承诺 | 无 `FULLY_REPRODUCIBLE` 字样 | A |
| 12 | PROVENANCE 如实标注 | 基准来源标 `NOT_ANCHORED` | A |
| 13 | 端到端导出 | 对一期真实进化产出 R1 包并通过 verify | **B** |
| 14 | preimage 保留期门禁 | 缺 preimage 时告警 | A |

---

## 9. 已知限制

1. **`ledgerProofAvailable` 当前必为 `false`** —— 生产 `evolution_ledger` 有 6 条（seq 1-6 无空洞），
   但 **0 条 `ANCHORED`**、锚点文件 `docs/evolution-ledger-anchor.md` **0 行**（2026-10-03 实测），
   `verify-ledger-chain.mjs --anchor` 报 `ANCHOR_NO_ROWS`，信任层级 **L0**。
   ⇒ **R2 依赖的信任锚不存在**（链在，锚没落地）。
2. **R3 不可达**（§2.1 三条原因）—— 不是待修的缺陷，是结构性的。
3. **preimage 无保留策略**（§7.1）—— 首次真实导出前必须核实目标期的 preimage 还在。
4. **D2 路径泛化破坏直接还原性** —— 泛化后无法用 preimage 直接回滚，接收方需人工适配路径。
