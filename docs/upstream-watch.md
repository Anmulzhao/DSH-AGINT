# 上游感知与判读（upstream-watch）设计方案

> 2026-10-28 立项。回答一个问题：**AGINT 能不能自己发现「宿主在变」并据此自我改进，这个能力长在哪。**
>
> 状态：**v0.1 / v0.2 / v0.3 全部已实现**（2026-10-28）。
> v0.1 = C3 子源 + 两段式判读；v0.2 = 语义面 + 面板「上游」分区；v0.3 = 判读质量仪器（升级后回填对拍）。
> 本文档是设计与边界的事实源，实现偏离本文档时先改文档再说。

---

## 1. 问题：AGINT 感知不到养它的那一层

AGINT 的信息通道有五类（`plugins/agint-input-gateway/lib/schema.js:12`）：

| Channel | 看什么 | 状态 |
|---|---|---|
| `human` | 人（老板）说的话 | 在用 |
| `self-observation` | 自己的工具异常、指标、规则热点、会话完整性 | 在用（C2，周日 02:00） |
| `external` | 外部世界 | **只挂了一个 `external-git`，且从未启用** |
| `adversarial` | 反事实挑战、课程结果、边界分歧 | 在用（C4，每日 03:30） |
| `cross-agent` | 其他 agent / 记忆库 | 在用（C5，周日 05:00） |

问题就出在第三行：**它能感知自己、能接受挑战、能跨 agent 取经，但感知不到宿主在变。**

而 dsh 的出片节奏是 1–2 天一个版本（2026-10-28 实测：`0.2.1-rc.3` 10-23 发，`0.2.1-rc.4` 与
`0.2.2-alpha.2` 同在 10-28 发）。`0.2.2-alpha.2` 一次就带了 11 条破坏性变更，其中
`engines.node >= 24.9.0`、工具执行流水线重构、`agent/request` 不再允许改路由 —— 任何一条踩中，
AGINT 就是「装上去起不来」或「起来了但功能静默缺失」。

现状是：**靠人读到 changelog，再转告 agent。** 这条链上人是单点，且人的注意力不保证。

---

## 2. 为什么不是「再加一个自进化模块」

把「自己发现机会 → 自我改进」拆成五环，逐环实测（2026-10-28，全部以本仓库代码为准）：

| 环 | 要什么 | 现状 | 证据 |
|---|---|---|---|
| ① 上游发行 | 拿到新版本与变更内容 | **缺** | `lib/channels/` 只有 4 个文件，无任何发行源 |
| ② 频道 | 把外部事件变成标准信号 | **骨架有、实现缺** | `CHANNEL_IDS.EXTERNAL = 'external-git'`，C3 只此一源且未启用 |
| ③ 判读 | 判断「这次变动对 AGINT 意味着什么」 | **断** | 全仓只有 `agint-memory/lib/index.js:221` 订阅 `input.signal.external.repo-diff`，外部信号进记忆即沉底，**没有任何东西把它变成提案** |
| ④ 提案台账 | 结构化记录待办改进 | 有 | `agint-evolve` 的 `propose()`（`lib/index.js:822`），`source` 是自由字符串 |
| ⑤ 落地与拍板 | 执行 / 人批准 | 有 | `agint-executor` + `agint-evolution-driver` + `autoExecutable` 语义闸（v0.17.0） |

⇒ **只有 ①③ 缺，② 是半个骨架，④⑤ 完全现成。** 结论：不该新建平行系统，
该做的是把已有的 C3 通道补上第二个子源，再把断掉的判读链接上。

这也是宪法「单一事实源」的直接应用：提案只有一个池子（`agint_evolve`），
再开第二个池子必然出现「面板说 A、执行器看 B」。

---

## 3. 设计约束（先立规矩）

设计前先定死六条，后面所有取舍从这里推：

**C1 单一信号管线。** 不新建第二套 fetch/去重/配额/安全扫描。复用
`InputGateway`（`lib/gateway.js`）已有的七步管线：基本校验 → payload 截断 → security 门禁 →
置信度过滤 → 去重 → 噪声抑制 → 配额 → 发布。

**C2 感知与判读分离。** 频道只回答「变了没有」（可确定性判定），
判读器才回答「要不要改」（需要判断力）。混在一起会让「拉取失败」和「这事不重要」长得一样。

**C3 事实与结论分离。** 判读器内部分两段：**段 1 确定性**（版本比较、条目解析、依赖面实测）
产**事实**，永远可跑；**段 2 LLM** 产**结论**，可失败。LLM 失败时只落事实、不落结论、
不产提案 —— 这不违反 v0.14.0 的「LLM 无降级」原则：不拿启发式冒充模型结论，
而不是连事实都不许记。

**C4 永不自动执行。** 依赖升级是宿主环境动作，AGINT 不碰 dsh 安装目录（AGENTS.md 红线）。
所有产出提案一律 `autoExecutable: false`，且不受 `force` 影响（v0.17.0 的语义闸本来就不可强穿）。

**C5 无网必须声张。** 抓不到 ≠ 没有新版本。fetch 失败要写进 `lastError` 并让状态可查，
不许静默返回空数组冒充「一切正常」。

**C6 零新增第三方依赖。** 仓库有 `docs/zero-deps-allowlist.json` 约束。
HTTP 用 Node 内置 `fetch`（Node ≥ 18），解包用内置 `node:zlib` + 自写 tar 头解析，
不引 `tar` / `semver` / `undici`。

---

## 4. 组件设计

### 4.1 C3 子源：`upstream-release`

**文件**：`plugins/agint-input-gateway/lib/channels/upstream-release.js`（新增）
**形状**：与 `external-git.js` 同构（`export const upstreamReleaseChannel = { id, type, cron, async fetch(ctx), async health() }`）

**数据来源**

| 源 | 用途 | 限流 |
|---|---|---|
| `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=N` | 版本号、发布时间、release body（变更内容） | 匿名 60 次/时，日更一次足够 |
| `https://registry.npmjs.org/@deepseek-ai/dsh` | `dist-tags`（latest / next / alpha 三条轨） | 无 |

**为什么两个都拉**：GitHub 给「变更说了什么」，npm 给「现在装得到什么」。两者会不一致
（实测 2026-10-28：GitHub 最新 `0.2.2-alpha.2`，npm `latest` 仍是 `0.2.1-rc.2`）——
只看一个会误判「已经是最新」。

**信号**

```
signalType : 'release.published'
topic      : input.signal.external.release-published
source     : 'upstream:dsh'
payload    : { tag, name, publishedAt, prerelease, entryCount, breakingHits,
               versionTracks, url, latestInstalled, lag }
confidence : 0.95
relevance  : 0.8
```

**payload 只放元信息，不放 changelog 全文** —— 管线有 2 KB 上限（`DEFAULTS.payloadMaxBytes`），
全文必然被截断，截断后的半截文本比没有更危险。全文由判读器按 `url` 另取。

**游标与增量**：状态落 `$DSH_HOME/storages/agint_input_gateway_release_state.json`
（与 `external-git` 的 `..._git_state.json` 同目录同风格），记 `{ seenTags: [], lastCheckedAt, lastTag }`。
**首次运行只记基线不产信号**（与 `external-git.js:127` 同构）—— 否则第一次上线会把 20 个历史版本
全部当新信号打出来。

**降级**：任一源失败 → 该源字段置 `null` 并在 `health()` 里报 `degraded`，不产信号。
两源全失败 → 抛错交给管线记 `lastError`（**不吞**）。

**排期**：`0 6 * * *`（每日 06:00）。选这个点的理由：在 `metrics-collect`(04:00)、
`tool-stats-backfill`(04:30)、`prompt-static-check`(04:45) 之后，避开 C3 原定周日 04:00 的 git 源，
也不与 C3/C5 的周日 04:00/05:00 撞车。

### 4.2 判读器：`agint-upstream-watch`

**文件**：新插件 `plugins/agint-upstream-watch/`

**为什么单独一个插件而不是塞进 input-gateway**：gateway 的职责边界是「把信号搬上总线」，
它不产提案、不持提案知识。让 gateway 直接写 `agint_evolve` 会让两个插件互相依赖成环，
也让「信号层」和「决策层」的可测试性都变差。

**入口**：订阅 `input.signal.external.release-published`（订阅式，不轮询）。
收到信号 → `digest(tag)` 全流程。另暴露 `runNow(tag)` 供工具/排障手动触发。

**段 1：确定性判读（不调模型）**

1. **版本语义**：`parseVersion()` 手写 semver 解析（major/minor/patch/prerelease），
   比较「AGINT 当前的 `VERSION` 表 tested 版本」与「新版本」，得出 `level: major|minor|patch|prerelease`。
2. **变更条目解析**：按 Markdown 标题切分 release body，抽出「新增功能 / 体验优化 / 问题修复 /
   其他变更 / 破坏性变更」五类计数。**breaking 关键词表**（`BREAKING_PATTERNS`）：
   `破坏性|BREAKING|需迁移|不再|已移除|移除|改名|更名|minimum|最低|engines|协议` 等。
   ⚠ 关键词只用来**提高关注度**，不用来下结论 —— 它同时是误报源（见 §6 的实例）。
3. **依赖面实测**（核心，也是本设计的立论处）：
   - 读 AGINT 自身的依赖面：扫 `plugins/**` 的 `from '@deepseek-ai/<pkg>'` 汇总去重。
   - 对**每个命中的包**，拉 npm tarball（`https://registry.npmjs.org/<pkg>/-/<pkg>-<ver>.tgz`），
     用 `node:zlib` 的 `gunzipSync` + 自写 tar 头解析（512 字节块，`ustar` 下取 name@0-100 /
     size@124-136 八进制）只提取 `lib/types/*.d.ts` 与 `lib/index.js`。
   - 与**本机已装版本**的同名文件做行级 diff，抽出：
     `addedExports` / `removedExports` / `changedSignatures`（只取含 `export` / `declare function` /
     `interface` 的行做集合差）。
   - 得出 `apiRisk: { pkg, verdict: 'compatible'|'additive'|'breaking'|'unknown', evidence[] }`。
   - **拿不到 tarball ⇒ `unknown`，不猜 `compatible`。** 这一条的阴性对照见 §5 的验收项。

4. 汇总成 `facts`（纯数据，无判断），落 `digests` 表。

**段 2：LLM 判读（可失败）**

只在 `facts` 满足任一条件时触发（省 token）：
- `level` 为 major 或 minor
- `breakingHits > 0`
- 任一包 `apiRisk.verdict` 为 `breaking` 或 `unknown`

调法与 `agint-dream` 的 consolidation 完全同构（`lib/consolidation.js:273-316`）：
`ctx.agents.create({ meta: { cwd, origin:'subagent', agentPreset }, agentOptions: { provider, model, reasoningEffort } })`
+ `ctx.subagents.startActivation({ provider:'spawn', request: { ..., agentPreset, agentOptions, outputSchema }, delivery:'caller' })`。
⛔ `agentPreset` 必须显式传（K114：缺它 child 是空壳）。

输入三份材料：`facts`（结构性事实）、release body 摘要、AGINT 的依赖面清单。
输出 schema 固定：

```
{ verdict: 'no-impact' | 'opportunity' | 'gap' | 'risk',
  confidence: number,
  headline: string,          // 一句话结论，≤80 字
  rationale: string,         // 依据，必须引用 facts 里的具体条目
  proposals: [{ title, body, category }] }   // 0..n 条，可为空
```

**LLM 失败/超时/输出不合 schema** ⇒ `digests.llmStatus='failed'` + `llmReason`，
**不产提案**，`facts` 照常落库供人查看。面板可见「有事实、无结论」。

**产提案**：逐条 `agint.evolve.propose({ title, body, category, source: 'upstream-watch:<tag>',
autoExecutable: false, assumedBy: 'dsh <tag>' })`。
`assumedBy` 记版本号，这样 dsh 再往前走的时候，v0.12.0 的「成立条件」机制能自动把老提案标成口径失效。

### 4.3 存储

域 `agint_upstream_watch`（`defineDomain`，v1）：

| 表 | 主键 | 内容 |
|---|---|---|
| `releases` | `tag` | `{ tag, name, publishedAt, prerelease, entryCount, breakingHits, bodyDigest, fetchedAt }` |
| `digests` | `tag` | `{ tag, level, facts, factsDigest, llmStatus, llmReason, verdict, headline, rationale, proposalIds[], createdAt }` |
| `config` | `id` | `{ enabled, autoPropose, maxProposalsPerRelease, model, ... }` |

⚠ 新增字段一律 `nullish()`（`.optional()` 只认 `undefined` 不认 `null`，见
`agint-input-gateway/lib/storage.js` 里 `CountersSchema` 的现场取证注释）。域版本**不升**。

### 4.4 可见性

| 面 | 形态 |
|---|---|
| service | `agint.upstreamWatch`：`status()` / `digest(tag)` / `runNow(tag)` / `listDigests({limit})` / **`calibration()`**（v0.3）/ **`backfill()`**（v0.3，手动触发回填） |
| 工具 | `upstream_status`（只读）、`upstream_digest`（写，走 ask 门禁）、**`upstream_calibration`**（只读，v0.3） |
| 指标 | `status().lag`（`{installed, latestVersion, behind, level}`）、`status().calibration`（对拍摘要） |
| 面板 | **v0.2 起已接**：家族面板「上游」分区（`family-panel` 0.9.0）。四个 KPI（本机 / 上游最新 / 落后 / 判读记录）+ 一张按时间倒排的表 + 一张「判读对拍」格；语义差异只在展开行里给 |
| 回填 | **v0.3**：`outcomes` 表（按 tag 主键），宿主启动与每次 digest 后自动扫一次 |

---

## 5. 边界：它自己能做到哪、哪一步必须人

| 环节 | AGINT | 说明 |
|---|---|---|
| 发现新版本、拉变更 | ✅ | 频道 |
| 实测 API 差异、算影响面 | ✅ | 判读段 1 |
| 判机会/缺口、写提案 | ✅ | 判读段 2 |
| 备好迁移补丁与回滚方案 | ✅ | 走 driver 生成，不自动 commit |
| **安装 / 升级 dsh 本身** | ❌ | AGENTS.md 红线：不动 dsh 安装目录。宿主环境动作，人做 |
| **决定这条提案要不要做** | ❌ | `autoExecutable: false`，人拍板 |

⇒ 终局形态是「**它发现、它判读、它备好补丁和回滚方案，人按一下**」。
这不是能力不足的妥协，是边界的一部分：一个能自己升级宿主的 AGINT，也能把自己弄死。

---

## 6. 已知限制与刻意不做的事

1. **关键词判据是误报源。** 2026-10-28 实例：`0.2.2-alpha.2` 的 changelog 写
   「插件需迁移 `tools.resolve/executable`」，按关键词会判「重度风险」；
   实测 `ctx.tools.register(def)` 只是**新增一个可选第二参**，`defineTool` 的 options 一字未变，
   140 处调用零改动。所以关键词只提高关注度，**结论必须由实测段给出**。
2. **语义面覆盖「有结构化落点」的那部分，仍不覆盖纯运行时行为。**
   v0.2 补了四类可确定性判定的：`engines` 下限、依赖增删、导出常量**值**变化、
   新增 `@deprecated`。仍然抓不到的典型：
   `storage-domain` 把版本校验从「丢弃旧版本记录」改成「接受并列出的版本」——
   签名没动、包里也没有任何声明承载这个变化，只有实现代码里的一段逻辑变了。
   这类只能靠 changelog 的 LLM 判读兜，是**已知缺口，不假装覆盖**。
   为什么不去 diff 全部 `lib/*.js`：实现文件天天变，全量 diff 会让噪声淹没信号，
   而判读器一旦开始喊狼来了，三次之后没人看。
3. **首次运行必然静默。** 基线策略决定第一天不产信号，要看效果得等第二个版本。
   面板/状态里必须能看出「已建基线，等新版本」，否则会被当成坏了。
4. **面板（v0.2 已接，`family-panel` 0.9.0）。** 加分区时 `v2-scan` 基线按惯例重冻了一次
   （第六次：家族 code 键 212 → 215，逐条账写在 `test/fixtures/v2-scan-baseline.json` 的 note 里）。
   分区刻意只给「是/否 + 有多急」，不给图表：这一节要回答的是
   「上游又动了，跟我有没有关系」，不是「上游历史趋势」。
   ⛔ 四种状态（未启用 / 取不到 / 只建基线 / 正常）在页面上必须长得不一样，
   `test/upstream-view.test.mjs` 逐条钉住了这一点。
5. **不追 dsh 的 master 分支 commit，只追 release。** commit 粒度太细，日更场景下信噪比极差。

---

## 7. 验收判据

| 项 | 命令 | 通过判据 |
|---|---|---|
| 频道可跑 | `gateway.forceFetch('upstream-release')` | 首次 `emitted=0`（建基线），第二次起有信号 |
| 无网不假绿 | 断网后 forceFetch | 返回 `ok:false` + `lastError` 非空，**不返回 `ok:true, emitted=0`** |
| 版本比较 | `node test/upstream-watch.test.mjs` | 12 组用例全绿（含 prerelease 排序的正负对照） |
| tar 解析 | 同上 | 用固定小 tgz 夹具，测得文件数 = 期望值；坏包返回 `null` 不抛 |
| API 实测 | `digest('0.2.2-alpha.2')` | 对 `dsh-tools` 判 `additive`，`evidence` 含 `register` 行 |
| LLM 失败不发提案 | 断模型 / 超时 | `digests.llmStatus='failed'`，`proposalIds` 为空，`facts` 非空 |
| 提案不可自动执行 | 面板/`listProposals` | 全部 `autoExecutable === false` |
| 门禁 | `bin/plugin-check.sh plugins/agint-upstream-watch` | 无 FAIL |
| 接线 | `node bin/check-wiring.mjs` | exit 0，硬缺口不增加 |
| 边界 | `node bin/check-boundary.mjs` | 无新增越界（新插件须进 §2 归属表） |
| 清单 | `node bin/verify-manifests.mjs` | ERROR 0 |
| 语义面 | `node --test plugins/agint-upstream-watch/test/semantics.test.mjs` | 18 条全绿（含 6 处阴性对照） |
| 引擎判定 | 同上一行 | 本机满足 ⇒ `warn`；本机不满足 ⇒ `blocker`（同一条变化两种结论） |
| 对拍 | `node --test plugins/agint-upstream-watch/test/calibration.test.mjs` | 17 条全绿；误报/漏报/确认/不可判四分支各有正负用例 |
| 面板四态 | `node --test plugins/agint-family-panel/test/upstream-view.test.mjs` | 10 条全绿（未启用 / 取不到 / 只建基线 / 正常 / 对拍三态） |
| 校准入分 | `node --test plugins/agint-quality/agint-quality-eval/test/effectiveness-calibration.test.mjs` | 6 条全绿；非判读类 target 不受影响（阴性对照） |

---

## 8. 分期

| 期 | 内容 | 状态 |
|---|---|---|
| v0.1 | 频道 + 判读器（两段式）+ 存储 + service/工具/指标 | ✅ 2026-10-28（`0c40d16`） |
| v0.2 | 语义差异检测（`lib/semantics.js`）+ 面板「上游」分区（`family-panel` 0.9.0，v2-scan 基线第六次重冻） | ✅ 2026-10-28 |
| v0.3 | 判读质量仪器：`prediction` 台账 + `outcomes` 回填 + `calibration()` 服务/工具 + 并入 `quality-eval` 的 effectiveness | ✅ 2026-10-28 |

v0.3 才是让这套东西**可自证**的关键 —— 没有它，前两期做得再好也只是「多了个会说话的告警器」。

### v0.3 的判据设计（为什么不是「准确率」）

判读器对自己负责，唯一可证伪的东西是：**「当时说 AGINT 用到的这些符号在目标版本里还在不在」**。
升级发生后，用真实安装树重算一次，两个方向都对拍：

| 当时判 | 升级后实测 | 结论 |
|---|---|---|
| `breaking` | 符号还在 | 误报（白改代码） |
| 非 breaking | 符号没了 | **漏报**（上线即坏） |

⛔ 两个方向必须一起算。只算漏报会诱导它「全都报 breaking」，只算误报会诱导它「什么都不报」。
⛔ 不给合成分数：两类错的代价不对称，合成一个数就把不对称抹掉了。`summarizeCalibration()`
   分别给两个比率与各自的**包数分母**。
⛔ 三种情形不下结论：目标版本没装上（`pending`）、拿不到安装位置、接口面为空。
