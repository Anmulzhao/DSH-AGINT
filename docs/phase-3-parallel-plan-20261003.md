# Phase 3 并行实施计划

> **日期**：2026-10-03
> **依据**：`DSH-AGINT 下一阶段优化路线图（修订版）` + `Phase-2 Adaptive Evolution Engine 设计方案` + `Phase-3 Self-Improving Harness Ecosystem 设计方案`
> **性质**：本文件只回答一个问题——Phase 3 的哪些部分可以同时推进。
> **纪律**：本文件所有结论都带实测证据。设计稿里的假设与实况不符时，**以实况为准**，并在 §3 记录偏差。

---

## 0bis. 执行结果（2026-10-03 当日实跑，§0 之前先看这节）

**并行判断成立。** 五条轨道在同一天全部推进，无一条因「等前一阶段」而停摆。
下表是**实况**，不是计划；任何与此表不符的表述以本表为准。

| 轨道 | 状态 | 落地物 | 测试 |
|---|---|---|---|
| **E 三层统一** | ⚠️ 部分完成 | `visibility` + `labelAuthority` 双枚举入 123/123 单元（sidecar，⛔ 不写进场景文件）；`--check` 真会红；**读端门** `driver.js --tier` 默认只吃 EVOLUTION | 36+36+17+12 |
| **A 协议族** | ✅ 完成 | `build-spec-index.mjs`、`check-spec-consistency.mjs`、**`check-spec-versioning.mjs`**、`lib/spec-hash.mjs`、兼容矩阵 | 15/15 + **17/17** |
| **B 发布准备** | ✅ 完成 | `package.json` files 白名单、`check-publish-safety.mjs`、`dependency-inventory.json` | 13/13 |
| **C 工具链** | ✅ 完成 | `lib/tar.mjs`、`lib/redact.mjs`（D2+D3） | 18/18 + **34/34** |
| **D 导包装配** | ✅ R1 线完成 | `export-evolution-package.mjs`、`check-preimage-retention.mjs`、**`verify-evolution-package.mjs`**（外部独立校验） | 19/19 + **13/13** |

**端到端实跑**：`packages/test-R1.tar.gz` · 48.5 KB · 15 文件 ·
内外双路 `INTEGRITY_VERIFIED` · `STRUCTURE_VERIFIED` · 等级 R1（实算）。

### 0bis.0 轨道 E 的「✅ 完成」是错的（2026-10-03 晚，Sprint 19 实跑后订正）

> 本节晚于上表写入。上表把轨道 E 标成「✅ 完成」，与本文**附录 A 第 2 条直接矛盾**
> —— 第 2 条实测 `units[]` 无 `visibility` / `labelAuthority` 两个字段。
> **这两句话不可能同时为真。**

**初稿错在哪**：写初稿时 `inventory.json` 的 `units[]` 只有 10 个字段，两个枚举都不存在。
「✅ 完成」是**把计划语气写成了实况**，不是实测结论。同类错误还有一处：
`docs/specs/INDEX.json` 的 `implementedBy` 当时写「123 个单元已带两字段」，
而生成器 `bin/build-spec-index.mjs` 里有一段**硬编码的同一句散文** ——
改 INDEX.json 会被下次生成覆盖回去，所以**必须改生成脚本本身**。

**订正后的实况**（2026-10-03 Sprint 19 实测）：

| 项 | 状态 | 证据 |
|---|---|---|
| 两个枚举入 123/123 单元 | ✅ 已落地 | `node bin/build-scenario-inventory.mjs --check` exit 0；`summary.tierCounts` 加总 = 123 |
| 标签存哪 | sidecar `eval/tiers/agint-tiering.json` | 写进场景文件会让 123 个 `contentHash` 全变、与 Frozen 防篡改基线自相矛盾 ⇒ 实测 `contentHash` 变化 **0 条** |
| `--check` 真会红 | ✅ | 判据层 8 条 + 生成器 4 条 + 存储层 5 条「放宽⇒变红」实验全部实测红 |
| 读端门（三层隔离唯一真正起作用的地方） | ✅ 已落地 | `eval/scenarios/driver.js` 默认 `--tier=EVOLUTION`；宽视图须显式 `--tier=ALL`；sidecar 缺失或映射缺 ⇒ fail-closed exit 1 |
| 三层物理目录 | ⛔ 未建 | 本 Sprint 不动目录：`driver.js` 场景发现是单层 `readdir`（非递归；2026-10-03 时点在 2543 行附近），迁目录会连带 `sourceFile` 历史路径 |
| Frozen 集 | ⛔ **0 个单元** | 首期 10 个未分配；`visibility` 全 `EVOLUTION`，`labelAuthority` 全 `UNSET` |
| `benchmark_frozen_set` 生产行数 | ⛔ **0 行** | 表 + 服务方法 `frozen-set.js` 已就绪（17 单测）；入账须部署后走宿主方法 —— 独立进程直写会被 last-write-wins 覆盖 |

**一句话**：**机制**落地了，**三层**还没建。「三层隔离已落地」这句话现在仍然不能说。

### 0bis.1 实施中被门禁抓到的真缺陷（比「按计划做完」更有价值）

这几条不是「按设计实现」，是**实现之后被自己写的检查抓出来的**。逐条已加回归钉：

| # | 缺陷 | 后果 | 抓出者 |
|---|---|---|---|
| 1 | JSON 序列化后路径变 `C:\\Users\\…`，惰性 `+?` 被 `\\` 阻断 | **用户名必然随脱敏报告出包** | `export.test` 9 号用例 |
| 2 | `verify.mjs` 不在 hash 表内 | 换掉唯一被执行的那份代码，哈希校验抓不到（**自己验自己不算校验**） | `verify` 的「未受保护文件」检查 |
| 3 | Merkle root 把 `manifest.json` 算进去 | 固定点方程无解，root 永远对不上 | root 交叉核对 |
| 4 | 包内 `sha256()` 已带前缀，校验侧又拼一次 | `sha256:sha256:…` ⇒ 假失败 | 包内 verify 跑真实包 |
| 5 | `reproductionLevel` 硬编码 `'R1'` | 空 01-code 也宣称代码级可复现（**协议诚实性破口**） | 「分区非空」检查 |
| 6 | `readGitHead` 捕获组漏 `refs/heads/`，拼成 `.git/main` | git-commit **永远**缺失 ⇒ R1 被静默降级，且只报「拿不到 git HEAD」，看不出是 bug | 等级实算后暴露 |
| 7 | `check-spec-versioning` 想自造 L0 检查，读的字段根本不存在 | 一道永远报「字段缺失」却查不出真实漂移的**假防线** | 门禁自测基线用例 |
| 8 | 门禁沙箱用 `cpSync({recursive:true})` | **崩原生层** 0xC0000409，零输出、exit 127 | 隔离复现 |

⭐ **第 5、6、8 条的共性**：失败方向一致且静默 —— 报出来的是「能力不可用」，
实际是「实现有 bug」。**这两类必须能区分开**，否则会一直拿「环境限制」当借口。

### 0bis.2 明确未做（不是遗漏，是有理由）

- `01-code/diff.patch` 真实生成 —— 需 diff 工具与 preimage→postimage 配对，属 Tier B。
  ✅ **已于同日补齐**：`bin/lib/diff.mjs` + 导出器集成，与 `git apply -R` 双向交叉验证。
- `02-contract/`、`03-evaluation/benchmark-results.json` 分区 —— 依赖 contract-manager 挂载。
- **R2 级复现** —— 生产 `evolution_ledger` 表 0 行（2026-10-03 实测）⇒ 信任锚不存在。
- 6 份 `pendingSpecs` 正文 —— 索引已登记「已识别未落地」，防「没登记=不存在」误判。
- `.github/` CI —— 仓库无 CI 目录，本批未引入。

### 0bis.2b 同日补做：`spec-index-refresh` job

原列「本批不做」（理由：改排期属 boot 期变更需重启）。**已实施**，
并连带修掉一个真缺陷。详见 `plugins/agint-cron/CHANGELOG.md` §0.2.6。三点结论：

| 项 | 结论 |
|---|---|
| **排期** | 设计稿建议的「1 日 09:30」**不可用** —— 09:30 已被 4 个周任务占满，`dom=1` 落任意星期几必撞。改 **10:30**（全窗口唯一空闲半点） |
| **形态** | **只读审计**，不写盘。索引是仓库资产，改它要过 review，不能由宿主进程单方面决定 |
| **可用性** | 部署位（bundle）**没有 `docs/` 也没有 `bin/`** ⇒ 常驻宿主上默认 soft-skip。`repoRoot` 默认 null，**不猜目录** —— 猜错会审计另一份仓库并报假漂移 |

⭐⭐ **实施中抓到的真缺陷（比新功能更值钱）**：
`validateIndex` 函数名像「全部校验」，实际**不含 `schemaHash` 漂移检查** ——
那段判据只写在 `main()` 的 `--check` 分支里。按名字复用它 ⇒ 最常见的漂移
**永远查不出、一路绿灯** ⇒ 一道假防线。已抽成导出的 `validateSchemaHashDrift()`，
`--check` 与 cron 巡检共用同一份，并加回归钉。

> **一般教训**：**函数名承诺的覆盖面必须等于实际覆盖面**。它若是「唯一权威判据」，
> 下游会理所当然以为它查全了 —— 复用即埋雷。


### 0bis.3 存量债（stash 验过，**非本批引入**）

`check-preset-parity.test.mjs`（11/14）与 `check-wiring.test.mjs`（23/24）基线就是红的。
验法：`git stash push -u` 后单跑，两者仍 `exit=1`。**改前先 stash 验一次是不是我引入的。**

---


## 0. 结论

Phase 3 可以同时推进。但要改排期方式。

两份设计方案按「Phase 编号串行」安排 Phase 3：等 Phase 2 收口，再启动 Phase 3。
**这个前提不成立。** 实测显示 Phase 0 都未收口，Phase 1 已部分落地，Phase 2 未启动。
按 Phase 编号排队会让 Phase 3 无限期等待一个尚未开工的前置。

**真实的约束是文件级资源冲突，不是阶段依赖。** 四个交付物碰的文件互不重叠，只有两处交叉。
按文件重排后：

- **三条轨道立即并行**：协议族、发布准备、导出包工具链。
- **一条轨道部分阻塞**：导出包装配。阻塞点只有两个，不阻塞整个交付物三。
- **一项不是并行问题，是抢窗口**：三层体系统一。窗口仍在，但会关闭。

---

## 1. 四条轨道

### 1.1 轨道定义

| 轨道 | 覆盖交付物 | 碰的文件 | 现在可做 |
|---|---|---|---|
| **A 协议族** | 交付物一 | `docs/specs/*`、`bin/build-spec-index.mjs`、`bin/check-spec-consistency.mjs`、`bin/check-spec-versioning.mjs` | 是 |
| **B 发布准备** | 交付物四 | `package.json`、`bin/check-publish-safety.mjs`、`docs/specs/dependency-inventory.json` | 是 |
| **C 导出工具链** | 交付物三的一半 | `bin/lib/tar.mjs`、路径泛化器、敏感扫描器、`verify.mjs` | 是 |
| **D 导包装配** | 交付物三的另一半 | `bin/export-evolution-package.mjs`、`bin/check-preimage-retention.mjs` | 部分 |
| **E 三层统一** | 交付物二 | `eval/scenarios/inventory.json`、`bin/build-scenario-inventory.mjs` | 是，但有窗口期 |

### 1.2 为什么轨道 C 可以提前

Phase 3 方案把导出包整体放进「批次 B-2，等 Phase 1/2 收口」。这个安排过度串行。

导出包的实际构成拆开看：

| 部件 | 依赖 | 现在能做 |
|---|---|---|
| 手写 tar + `node:zlib` | 无（纯格式） | 是 |
| 路径泛化器（D2 规则） | 无（正则替换） | 是 |
| 敏感模式扫描器（D3 规则） | 无（模式匹配） | 是 |
| 包内 `verify.mjs` | 需包结构定稿 | 是（A 出规范后） |
| `export` 主程序 | 读生产存储 + 需 Ledger 链 | **否** |
| 端到端真实导出 | 需老板审 dry-run 清单 | **否** |

**前四项全是纯函数。** 它们不读 `$DSH_HOME/storages/`，不碰 `evolution_ledger` 表，不需要任何 Phase 收口。
用构造数据就能测透：空包、单文件、多层目录、长文件名（>100 字节需 prefix 字段）、非 ASCII 名、
Windows/Linux/MSYS 三种路径形态、凭据形态正负样本各 ≥12 case。

**把纯函数部分推迟到「Phase 1 收口后」，等于让 4 个零依赖模块排队等一个跟它们无关的依赖。**

### 1.3 轨道 D 的两个阻塞点

| 阻塞点 | 性质 | 解除条件 |
|---|---|---|
| `ledger-proof.json` 需 `evolution_ledger` 哈希链 | 硬阻塞，但**可诚实降级** | 方案 §3.2 已允许标 `NOT_AVAILABLE` ⇒ **其实不阻塞 R1** |
| 首次真实导出需人工审 dry-run 清单 | 流程闸门，非技术阻塞 | 老板签字 |

**修正**：Phase 3 方案 §6.2 把「Ledger 未实施」列为导出包的阻塞项。实测该判断需修正 —— 见 §3.1。
即使 Ledger 零落行，R1 级包（结构级复现）仍可产出，只需 `ledgerProofAvailable: false` + 写明原因。

⇒ **轨道 D 的实际阻塞只有一条：老板审 dry-run 清单。** 技术准备全部可做。

---

## 2. 唯一真正的抢窗口项

### 2.1 冲突事实

Phase 3 交付物二与 Phase 0 交付物 1 改同一个文件。

| Phase | 改什么 | 动哪 |
|---|---|---|
| Phase 0 交付物 1 | 加 `visibility` 字段 + 迁三层目录 | `inventory.json` 的 `units[]`、`build-scenario-inventory.mjs` |
| Phase 3 交付物二 | 加 `labelAuthority` 字段 | 同上两个文件 |

### 2.2 窗口状态：仍在

实测 `eval/scenarios/` 目录：只有 35 个 `.scenario.json` 在根目录 + `dedicated/` + `mocks/` + `inventory.json` + `driver.js` + `README.md`。
**`evolution/` `validation/` `frozen/` 三个目录都不存在。**

⇒ Phase 0 尚未开始迁移。窗口未关闭。

### 2.3 两条路径的代价

| 顺序 | 代价 |
|---|---|
| 先加 `labelAuthority`，再建三层目录 | 两个字段一次性到位。`build-scenario-inventory.mjs` 改一次，跑一次全量。 |
| 先建三层目录，再加 `labelAuthority` | 改 inventory schema + 写迁移脚本 + 重跑迁移 + 对账。 |

⇒ **交付物二必须插在 Phase 0 三层目录落地之前。** 这不是可选优化，是唯一的低成本窗口。

### 2.4 加法可行性已验证

实测 `inventory.json` 的 `units[]` 现有 10 个字段：

```
unitId, sourceFile, plugin, domain, kind,
lastKnownStatus, failCategory, contentHash, externalDeps, runtimeRequired
```

**无 `labelAuthority`，也无 `visibility`。** 两个字段都是纯加法，不改现有语义。
`labelAuthority` 默认值 `UNSET` 如实反映当前状态（无外部冻结标签）。

---

## 3. 实测偏差记录

本节记录三处「设计稿假设 vs 实况」。全部以实况为准。

### 3.1 Phase 1 不是「未启动」，是「已实装未跑通」

Phase 3 方案 §0.3 表格写「Phase 1 未启动（设计已出）」。**不准确。**

已落地（`git log` 近 25 条实测）：

| 能力 | commit / 文件 |
|---|---|
| 预测质量评分模型 DA/MC/IF/PQ + 死区判定 | `0cc135f` `3f24d1e` |
| 三级预测来源 + hypothesisLock 纯函数 | `ec8fb58` `ce4bc18` |
| `contract_locks` 表 + 三个 Service | `b1731c3` |
| contract-manager 接线层 | `cd42966` `f2134d5` |
| Ledger 哈希链全套 | `lib/ledger.js`、`lib/ledger-hash.js`、`lib/ledger-anchor.js` |
| Ledger 门禁 | `bin/verify-ledger-chain.mjs`（含 `.test.mjs`）、`bin/anchor-ledger.mjs` |
| 域表声明 | `agint-evolution-memory/lib/index.js:78`（`contract_locks`）、`:81`（`evolution_ledger`） |
| 事件 topic 登记 | `8547324`（46 个 topic） |

**但生产零落行。** `~/.dsh/storages/agint_evolution.json` 实测：

| 表 | 落行数 | 状态 |
|---|---|---|
| `evolution_log` | 202 | 有数据 |
| `failure_pattern` | 8 | 有数据 |
| `success_template` | 5 | 有数据 |
| `contract_locks` | **0** | 已实装未跑通 |
| `evolution_ledger` | **0** | 已实装未跑通 |

代码注释已如实记录该状态（`index.js:66-67`：「已用生产文件副本实证：202 行全部保留，contract_locks 0 行」）。

**对 Phase 3 的影响**：
- 「Phase 1 未启动」→ 应改为「已实装、零落行」。
- `ledger-proof` 仍标 `NOT_AVAILABLE`。**结论不变，理由要改。**
- 该区分有实际价值：Ledger 一旦跑通，R2 立刻解锁，不必等整个 Phase 1 收口。

### 3.2 cron job 数是 22，不是 20

Phase 3 方案 §5.4 写「累计已在周一上午排了 8 个 job」，引 `路线图.md:203` 的 20 个。
实测 `plugins/agint-cron/lib/jobs.js` 有 **22 个 `id`**。

已含 Phase 1 的 `ledger-anchor`（周一 08:00，见 `jobs.js:68`）。

⇒ 「周一上午 7 个」需重算。**加新 job 前必须先做全局排班评审。** 见 §5.1。

### 3.3 preimage 只有 6 条，且无保留策略

实测 `.agint-preimage/` 共 6 个 `.bak` 文件，时间戳集中在 2026-09-27 ~ 09-29。

导出包 R1 依赖 preimage 生成 `diff.patch`（Phase 3 方案 §3.5）。当前可用 preimage 只有 6 条，
且**最旧的一条距今 6 天**。无清理逻辑，也无保留策略。

⇒ **首次真实导出前必须先核实**：目标那一期的 preimage 是否还在。不在则该期只能降级导出，
不能用 `restoreFromPreimage` 路径。这是轨道 D 的一个额外前置检查。

### 3.4 已核实为真的部分（沿用设计稿，无需修正）

| 结论 | 证据 |
|---|---|
| 场景基线 123 单元 | `inventory.json` 实测 `units` 长度 123 |
| `units[]` 已含 `visibility` + `labelAuthority`（10 → 12 字段） | 见 §0bis.0 订正：初稿此行写「无 `labelAuthority`」，Sprint 19 后已不成立 |
| 三层目录未建 | 目录实测（§2.2） |
| `.github/` 不存在 | 目录实测 |
| `package.json` 仅 12 行、`private: true`、无 `files` | 文件全文实测 |
| 仓库根有 2 个 `cordis.patch.yml.bak-*` + `node_modules/` | `ls` 实测 ⇒ `files` 白名单确有必要 |
| `canonicalStringify` 已落地 | `bin/lib/canonical-json.mjs`（+ `.test.mjs`）；`lib/canonical.js` 为插件侧同源实现 |
| preimage 路径规则 | `.agint-preimage/<扁平化>__<ISO>.bak`，实测符合 |

---

## 4. 排期

### 4.1 第 1 周（三轨并行 + 抢窗口）

```
轨道 E（先做，窗口优先）
  └── docs/specs/evaluation-protocol-v1.md（二维标注定义）
  └── build-scenario-inventory.mjs 输出 labelAuthority（默认 UNSET）
  └── 跑一次全量，inventory.json 的 delta 仍为 0

轨道 A
  └── docs/specs/INDEX.json 骨架（statusLegend + 6 项已落地资产登记）
  └── bin/build-spec-index.mjs
  └── bin/check-spec-consistency.mjs

轨道 B
  └── package.json 补 files / repository / keywords / engines / bugs / homepage
      ★ 改前备份 .bak-<yyyyMMdd-HHmmss>
      ★ private:true 保留不动
  └── bin/check-publish-safety.mjs

轨道 C
  └── bin/lib/tar.mjs（含往返测试）
  └── 路径泛化器（Windows / Linux / MSYS 三形态）
  └── 敏感模式扫描器（≥12 case，含误报率测试）
```

**同文件冲突检查**：四轨道的写入文件集无交集。E 写 `inventory.json` 与 `build-scenario-inventory.mjs`；
A 写 `docs/specs/` 与新 `bin/` 脚本；B 写 `package.json` 与新 `bin/` 脚本；C 写 `bin/lib/` 与新 `bin/` 脚本。
**四条轨道可由四个执行者同时动手。**

### 4.2 第 2~3 周

```
轨道 A
  └── docs/specs/benchmark-isolation-v1.md（Phase 0 §3 规范化）
  └── docs/specs/compatibility-matrix.json（3 条不变量）
  └── bin/check-spec-versioning.mjs
  └── 登记 Phase 1/2 的 5 份规范（status 诚实标注）

轨道 B
  └── docs/specs/dependency-inventory.json（37 插件 + 私有包 + zod 三副本）

轨道 C
  └── docs/specs/evolution-package-v1.md（6 分区 + 6 条脱敏规则）★ 先于 verify.mjs
  └── 包内 06-verification/verify.mjs
  └── cron spec-index-refresh（月度 1 日 09:30，避开周一）

轨道 E
  └── 二维标注状态迁移单元测试（≥6 case，含 HELDOUT→GOLD 降级）
```

### 4.3 第 4 周及以后（轨道 D）

```
前置检查（阻塞轨道 D）
  ├── 核实目标期的 preimage 是否存在（§3.3）
  └── cron 排班评审出结果（§5.1）

执行
  └── bin/export-evolution-package.mjs（--dry-run / --confirm 两步，fail-closed）
  └── bin/check-preimage-retention.mjs（只告警不删除）
  └── 产出 dry-run 清单 → ★ 老板审阅 → 才执行 --confirm
  └── R1 包 + 独立校验
```

### 4.4 现在明确不做的

| 项 | 理由 |
|---|---|
| 交付物四的接入设计 | B2（官方市场未 GA）+ B3（无第二使用方）双重硬阻塞 |
| SBOM 转换器（CycloneDX / SPDX） | 格式未定。写了必改。原料 `dependency-inventory.json` 先备好 |
| 移除 `private: true` | B1 未解除。当前 `private: true` 是有效的误发布防护 |
| `agint_quality_anchor` 域 / 迁移 `baseline-suite` | 老板 2026-10-01 拍板 external-anchor 提案存档。Phase 3 无权重启 |
| 任何多模型调用代码 | 宿主只注册 1 个模型（`MiniMax-M3.1-Flash-Preview`）。Blocked-on-dsh |

---

## 5. 两个必须提前拍板的决策点

### 5.1 cron 全局排班评审

**事实**：22 个 job 已在册。周一上午链路拥挤。
**新增需求**：轨道 A 要 `spec-index-refresh`（月度），轨道 C/D 要 `preimage-retention-check`（周一）。

**风险**：四条轨道各自往周一塞 job，会加剧拥堵，且各 Sprint 看不到全局。

**建议**：轨道 A/B/C 实施**之前**先做一次排班评审，产出全局时刻表。
新 job 优先放月度与周二上午（进化决策日），不占周一上午链路。

**注意**：排期变动须同时改 `agint-cron/lib/index.js` 的 `services()` 映射，
否则新 job 不被调度。该纪律见项目记忆（cron 章节）。

### 5.2 `.github/` 落地

**事实**：仓库无 `.github/` 目录。Phase 0~3 累计约 20 个门禁脚本**全部依赖人工执行**。

**影响**：本计划的四条轨道会新增 7 个门禁脚本。若 `.github/` 不建，
这 7 个门禁同样只能人工跑 ⇒ **人工执行必漏**。

**建议**：把 `static-gates.yml` 作为**四条轨道的公共前置**，第 1 周内先建。
GitHub remote 已确认可用（`git@github.com/Anmulzhao/DSH-AGINT.git`）。
成本低，收益覆盖全部后续 Phase。

---

## 6. 与其他 Phase 的交叉影响

### 6.1 对 Phase 0

| 项 | 影响 |
|---|---|
| 交付物二抢在三层目录之前 | Phase 0 迁移排期需与本计划协调。**首项任务就是确认窗口** |
| 三层配额基数 123 | Phase 0 方案里的 104 是 v0.6.5 历史快照。按 123 重算为 74/31/18 |
| `canonicalStringify` | 已落地在 `bin/lib/canonical-json.mjs`。**复用，不重复实现** |

### 6.2 对 Phase 1

| 项 | 影响 |
|---|---|
| Ledger 已实装零落行 | 交付物三的 `ledger-proof` 标 `NOT_AVAILABLE`，理由写「已实装未跑通」 |
| Contract schema 已有 | `INDEX.json` 首项登记项。状态标 ACTIVE 需先核实 `contract-manager.js` 运行态 |
| 5 份规范待规范化 | `prediction-scoring-v1`、`evolution-ledger-v1` 等由轨道 A 登记 |

### 6.3 对 Phase 2

| 项 | 影响 |
|---|---|
| 变异类型实为 3 类 | `MutationKindSchema` FROZEN 3 值。`strategy-space-v1` 不得扩枚举 |
| 域名是 `agint` 不是 `agint_memory` | `架构.md:83` 域清单有误，需修正 |
| 5 份规范待规范化 | `strategy-space-v1`、`memory-utility-v1`、`cross-model-validation-v1`、`strategy-replay-v1` |
| `modelContext` 埋点 | 轨道 D 的 `05-environment/model-context.json` 依赖它 |

### 6.4 全项目口径修正（跨轨道）

> ⚠️ **本节已于 2026-10-03 执行完毕**。执行中**发现原表第 2、4 条自身有误**，已按实测订正（见下方「执行结果」）。

以下修正与轨道无关，但必须在 Phase 0 Sprint 19 落地前完成，否则实施者按旧数据动手：

| # | 文档 | 原判断 | 执行结果 |
|---|---|---|---|
| 1 | 全项目 + Wiki | 「92/104」→「118/123」，或标注为 v0.6.5 历史快照 | ✅ **大部分早已标注完毕**，只需补 2 处活文档裸引用（`路线图.md:75` / `:254`）。**Sprint 11/12 设计稿、变更日志、复盘里的 92/104 是历史验收记录，带明确时点与版本号，不改** |
| 2 | `架构.md:83` | 存储域清单 `agint_memory` → 实测是 `agint` | ⚠️ **原判断有误**：`架构.md` 全文**没有** `agint_memory` 这个词（Phase-2 §5.1 据「按插件名类推」误记，§5.1 的「连带影响」段又把同一个错误转述了一遍）。真正过期的是**计数 34 → 35**（判据见附录 A #21）。已改为「35 个插件独占存储域」，并新增**域名例外**说明（`agint.memory` 的域是 `agint`，`agint_memory_provider` 是另一个插件） |
| 3 | `架构.md:152` | safety「权重 0.30」与「硬门控阈值 0.5」是两个参数，勿混 | ✅ 成立。原文档把两者压成一个短语「safety 0.30 硬门控」，已拆开并标出代码位置（`fitness.js` `DEFAULT_THRESHOLDS.safety.floor/hardFloor`）|
| 4 | `路线图.md:475` | S5 写「与 DeepSeek 模型共同进化」，实际运行是 MiniMax | ⚠️ **原判断有误（行号与内容）**：DeepSeek 只出现在**第 475 行**（Cross-Model 章节的 `Step 1`），**不在** S5 那行。已改为「Model A 须先锁定并记录时点」+ 记录当前实测值 `minimax-cn` / `MiniMax-M3.1-Flash-Preview`，并补 **Model B/C 现成候选**（`deepseek-official`/`deepseek-flash` 已在白名单里）|

**执行中新发现的两条偏差（不在原表，但同属口径修正）：**

| # | 偏差 | 证据 | 已处理 |
|---|---|---|---|
| 5 | `架构.md` 顶部实况块**整块过期**：写「v0.8.6 / 34 plugin / 34 段 / 24 preset 工具行 / 16 cron job」，实测**仓库 v0.9.0**、36 插件、部署位 40 个唯一 `agint-*` 段、**25** 个 preset 工具行、**21** 个 cron job 声明 | `VERSION` 表首行 / `AGENTS.md:107` / `jobs.js` 21 个 `id` | ✅ 已整块重写 + 标注订正来源 |
| 6 | `cron` 声明 21 个但生产 `cron_state` 只落 **20** 个，缺 `ledger-anchor` | `agint_cron.json` 与 `jobs.js` 差集 = `['ledger-anchor']` | ✅ 写入实况块（这是 §3.1「Phase 1 已实装未跑通」的第二个独立证据）|

**执行中查到的存量债（不在本次口径修正范围，建议单独排期）：**

**部署位与仓库的 3 个差异 —— 已全部查清，⛔ 不是漏同步（撤回我第一反应的「补同步」建议）：**

| 插件 | 状态 | 真实原因 | 该怎么办 |
|---|---|---|---|
| `agint-quality-report` | 部署位与仓库 patch **都是注释** | 注释明写 `REMOVED`：「model-facing 入口 + host patch 均已撤；weekly scheduler 仍按原设计尝试调用 `agint.qualityReporter`，宿主缺失时软降级（不再有 report）」 | ⛔ **不要补**。补一个有意移除的能力 = 把废弃功能重新挂上，比漏补更糟 |
| `agint-search-tools` | 部署位无 host 段 | **纯工具插件**：`lib/` 只有 `tools.js`、无 `index.js`；`package.json` 的 `main` 就是 `tools.js`；由 preset 工具行 `name: ../../profiles/web/plugins/agint-search-tools/lib/tools.js` 直接加载 | ⛔ **不需 host 段**，本就不是缺口 |
| `agint-session-extract` | 部署位无 host 段 | **纯函数库**：`main: index.js`、**无 `lib/` 目录**；被 `agint-dream` / `agint-skill-autocreate` / `agint-tool-stats` 三处 `import` | ⛔ **不是 Cordis Service**，不计入插件数 |

这三项正是仓库门禁 `bin/verify-manifests.mjs` 头注释里**已记录的历史误报**：「旧版对 `plugins/*` 做 glob，凡目录无 `manifest.json` 一律报警。实测 3 处全是误报」，且已修成「从 `cordis.patch.yml` 的 `name: ./plugins/...` 行反查真实挂载集合」。⇒ **我这次差点重犯门禁 10-02 已经修过的错**。

⚠️ **方法论沉淀（本轮两次同型犯错）**：
1. **按类推填空，未回查原文** —— §6.4 第 2 条据 Phase-2 转述断言「`架构.md` 写了 `agint_memory`」，grep 零命中；本条据「部署位没有 = 漏同步」断言要补，注释里写着 `REMOVED`。
2. ⇒ **看到一个差异先问「为什么」，再问「怎么改」**。文档纠错最危险的动作是「按错误前提去修一个本来正确的地方」——会把正确的地方改错，且**看起来像做了工作**。
3. ⇒ **优先跑门禁取权威值**：`verify-manifests` 3 秒给出的答案，我手算目录数绕了半小时还算错（36 / 38 / 40 三个数都出现过）。

**建议**：作为独立事项一次做完，不占用四条轨道的 Sprint 额度。

---

## 7. 验收标准

本计划自身的验收（即「并行拆分是否真的成立」的判据）：

| # | 验收项 | 判据 | 验证方式 |
|---|---|---|---|
| 1 | 四轨道文件无交集 | 逐轨道列出写入文件集，两两求交为空 | 人工核对 |
| 2 | 抢窗口项先落地 | `labelAuthority` 在 `inventory.json` 中存在，且三层目录仍未建 | `ls` + 读文件 —— ✅ **达成**（2026-10-03 Sprint 19 实测：123/123 单元含该字段；`eval/scenarios/` 下仍无三层目录） |
| 3 | 加法不改语义 | `inventory.json` 的 `reconciliation.delta` 仍为 0 | 跑 `build-scenario-inventory.mjs` |
| 4 | 123 基线未漂移 | 重建后 `units` 仍为 123 | 同上 |
| 5 | 协议 status 诚实 | 未实施的规范标 DESIGN / BLOCKED，不标 ACTIVE | 人工评审 + 索引比对代码 |
| 6 | `private: true` 未动 | git diff 确认 | 读 `package.json` |
| 7 | 新门禁零依赖 | 7 个新脚本 import 仅 `node:*` | `check-zero-deps.mjs` |
| 8 | 工具链可独立测 | tar / 路径泛化 / 敏感扫描在无生产存储的环境可跑通单测 | 干净目录跑测试 |
| 9 | 轨道 D 阻塞点已识别 | `ledgerProofAvailable: false` + 写明原因 | 读导出包 manifest |
| 10 | cron 排班已评审 | 新 job 不与现有 **21** 个声明冲突 | 排班表比对 |

---

## 8. 哲学对齐检查

| 准则 | 检查 | 结论 |
|---|---|---|
| **真实 > 讨好** | 是否掩盖了 Phase 3 前置不满足的事实？ | ✅ §3.1 记录 Phase 1 是「已实装未跑通」而非「已达成」。§4.4 列出 5 项明确不做的 |
| **真实 > 讨好** | 是否把导出包的 R1 说成 R3？ | ✅ §1.3 明确 Ledger 零落行时 R1 仍可产出，R3 不做 |
| **靠谱 > 聪明** | 是否为了并行而降低单轨道质量？ | ✅ 否。轨道 C 提前做，但测试要求不降（往返测试 + ≥12 case 敏感样本） |
| **简洁 > 冗余** | 四轨道是否过度拆分？ | ✅ 按文件冲突拆，不按人数拆。四条轨道的文件集两两求交为空，这是客观判据 |
| **安全 > 效率** | 是否把人工闸门自动化掉了？ | ✅ §4.3 保留「老板审 dry-run」为轨道 D 的唯一闸门，不跳过 |
| **主动 > 被动** | 窗口期是被动等还是主动抢？ | ✅ §2 主动把交付物二提到第 1 周，并给出窗口关闭的判据（三层目录出现） |

---

## 附录 A：实测证据总表

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 1 | 场景基线 123 单元 | `inventory.json` 的 `units` 长度 123（Python 直读） | 实测 |
| 2 | `units[]` **12** 个字段，**含** `visibility` / `labelAuthority`（Sprint 19 新增） | `inventory.json` 字段清单实测 + `--check` exit 0 | 实测（**初稿写「无这两个字段」，与第 17 行「✅ 完成」直接矛盾 —— 见 §0bis.0**） |
| 3 | 三层目录未建 | `ls eval/scenarios/`：35 个 json + `dedicated/` `mocks/` `inventory.json` `driver.js` `README.md` | 实测 |
| 4 | Phase 1 已落地 | `git log` 8 条 Phase 1 commit（§3.1） | 实测 |
| 5 | `contract_locks` 0 行 | `agint_evolution.json` 的 `tables` 实测 + `index.js:66-67` 注释 | 实测（生产） |
| 6 | `evolution_ledger` 0 行 | 同上 | 实测（生产） |
| 7 | `evolution_log` 202 行 / `failure_pattern` 8 / `success_template` 5 | 同上 | 实测（生产） |
| 8 | Ledger 代码全套已落地 | `lib/ledger.js`、`ledger-hash.js`、`ledger-anchor.js`；`bin/verify-ledger-chain.mjs`、`bin/anchor-ledger.mjs` | 实测 |
| 9 | `evolution_ledger` 已在域声明 | `agint-evolution-memory/lib/index.js:81` | 实测 |
| 10 | cron job **21 个声明 / 20 个生产落行** | `jobs.js` 的 `id` 正则去重 = 21；`agint_cron.json` 的 `cron_state` 键 = 20；差集 = `['ledger-anchor']` | 实测（**本文初稿写 22 是错的**，见 §3.2 订正） |
| 11 | `ledger-anchor` 占周一 08:00 | `jobs.js:68` | 实测 |
| 12 | `.github/` 不存在 | `ls .github` | 实测 |
| 13 | `package.json` 12 行、`private: true`、无 `files` | 文件全文 | 实测 |
| 14 | 仓库根 2 个 `cordis.patch.yml.bak-*` + `node_modules/` | `ls` | 实测 |
| 15 | preimage 6 条，2026-09-27 ~ 09-29 | `ls .agint-preimage/` | 实测 |
| 16 | `canonicalStringify` 在 `bin/lib/canonical-json.mjs` | 文件存在 + `.test.mjs` | 实测 |
| 17 | GitHub remote 可用 | `git@github.com/Anmulzhao/DSH-AGINT.git` | 实测 |
| 18 | 当前 commit `8547324`，分支 `main` | `git log -1` / `git branch --show-current` | 实测 |
| 19 | 事件 topic 46 个 | commit `8547324` 标题 | 实测 |
| 20 | **仓库版本已是 v0.9.0**（文档普遍还写 v0.8.6） | `VERSION` 表首行 + `AGENTS.md:106` 自动块 | 实测 |
| 21 | **挂载插件数 = 35**（唯一权威口径） | `node bin/verify-manifests.mjs` 实测：「`cordis.patch.yml` **35 条声明** → 35 个插件目录 · 已挂载 35 / 未挂载 5 · 其中嵌套 3」，ERROR 0 | 实测（**跑门禁取权威值，别用 `ls plugins/` 目录数**） |
| 21b | ⚠️ `plugins/` 下实有 **40 个目录**，但 5 个**不构成挂载单元** | 容器 `agint-quality`（父容器本就不该有 manifest）／纯工具 `agint-search-tools`（无 `index.js`，走 preset 工具行直吃 `tools.js`）／纯函数库 `agint-session-extract`（`main: index.js`，被 dream / skill-autocreate / tool-stats 三处 `import`）／`agint-quality-report`（**双方一致主动 REMOVED**）／嵌套父目录 | 实测（`verify-manifests` 「不校验（未挂载，非问题）」段逐条列出） |
| 22 | 部署位 patch 与仓库 patch 的 `agint-quality-report` 段**都是注释** | 部署位第 109-115 行 + 仓库 `cordis.patch.yml:131-137`，两处注释内容一致（`REMOVED`）⇒ **不是漏同步** | 实测（**我第一反应判成「漏同步」，读注释才发现判错**） |
| 23 | `架构.md` 全文**无** `agint_memory` | grep 零命中；只有 `agint_memory_provider` | 实测（**Phase-2 §5.1 的「连带影响」段据此判断有误**） |
| 24 | memory 插件真实域 = `agint` | `plugins/agint-memory/lib/index.js:48` `name: 'agint'`；生产 `~/.dsh/storages/agint.json` 存在，`agint_memory.json` 不存在 | 实测（代码 + 生产） |
| 25 | safety **权重 0.30** 与 **硬门控阈值 0.5** 是两个参数 | `fitness.js:37` `safety: 0.30`（权重）/ `:46` `safety: { floor: 0.5, hardFloor: 0.5 }`（门控） | 实测 |
| 26 | 当前默认模型 = `minimax-cn` / `MiniMax-M3.1-Flash-Preview` | 加载位 patch 的 `agent-default-model` 段（web profile `cordis.patch.yml:141-145`）；Model B/C 候选 `deepseek-official`/`deepseek-flash` 同段白名单 | 实测（**`$DSH_HOME/settings.yaml.imported` 是 09-21 过期快照，仍写 `MiniMax-M3`，不可当现状**） |

## 附录 B：术语

| 术语 | 定义 |
|---|---|
| 轨道 A / B / C / D / E | 本文的五条并行轨道（§1.1） |
| 抢窗口项 | 有时间限制、必须在特定事件前完成的工作（§2） |
| 窗口关闭判据 | `eval/scenarios/evolution/` 目录出现 ⇒ 窗口关闭 |
| fail-closed | 校验不通过时拒绝产出，不产出空结果 |
| NOT_AVAILABLE | Ledger 链不可用时的诚实标注，不伪造 |
