# Changelog — agint-rules

## [0.3.0] — 2026-11-17

### Added — 规则引擎自保护（提案「护住规则引擎自身」A1/A2/A3）

**起因（实测取证）**：`rule_check(rule_set_enabled, {id, enabled:false})` →
`NO_MATCH`；`rule_list` 实况里没有一条规则覆盖 `rule_add` / `rule_remove` /
`rule_set_enabled` ⇒ 被门禁约束的 agent 可以把 deny 规则关掉。
与 RSI 综述同一类失效：系统既是改进者，又改得动自己的评估过程
（看守自己的锁由被看守者拆）。

**A1（deny 级规则在引擎内不可变）**：
- `rule_remove(deny 规则)` → 抛错拒绝
- `rule_set_enabled(deny 规则, false)` → 抛错拒绝
- `rule_add` 改写既有 deny 规则（含改 `reason`）→ 抛错拒绝

仍允许两件事：**新建**规则（新建 deny 是加固）、`enable(true)`（恢复生效
不等于削弱约束）。`advisory` / `ask` 级规则不受此约束 —— 日常运维不能被锁死。

**A2（删规则走人工确认）**：`rule_remove` 命中 ask 级。参数里只有 `id`，
正则无法判别被删规则是 deny 还是 advisory，故按提案取舍用 ask 而非 deny，
保留「误建的坏规则由人确认后删除」的口子。

**A3（新增规则的 reason 走人工确认）**：`rule_add` 命中 ask 级。
`reason` 会被 `buildAdvisoryMessage` 拼进注入消息 ⇒ 任意文本可经 reason
进入模型上下文（提示注入面）。

**补种口径（关键）**：`seedIfEmpty()` 原本第一行就是「规则表非空就 return」
⇒ 老装机永远拿不到这三条 ⇒ 写在代码里的门禁形同虚设。这正是 `seedEpistemic`
当初被拆出来的同一个坑。现在三条自保护规则**无条件补种**：
- 按 id 幂等（重复 boot 不重复播种）；
- 已被「同 tool + 同 action + 同 pattern」的等价规则覆盖时跳过（避免 lint
  判成 `duplicate-pattern`）；
- 已存在但被停用（`enabled=false`）的会被**重新启用** —— 停用自保护规则
  正是本提案要堵的失效形态。

**参数文本口径**：这三个工具的 args 没有 `command`/`cmd` 键 ⇒ `argText` 走
`JSON.stringify(args)`，产出**无空格** JSON（如 `{"id":"x","enabled":false}`）
⇒ pattern 必须按无空格写。

**人工解封**：引擎内不可变 ⇒ 误建的 deny 规则无法用工具删，须由人改
agint_rules 存储的文件层 / 带签名写入路径。

**验证**：
- `node --test test/self-protection.test.mjs` → 5/5（补种口径：非空表补种 /
  幂等 / 停用后重新启用 / 等价规则跳过 / lint 不误报 duplicate-pattern）
- `node --test test/audit-persist.test.mjs` → 12/12（新增第 9 组 3 条：
  三条削弱路径全拒绝 / `enable(true)` 放行 / ask 级规则不受约束）
- 声明的测试命令四文件合计 → **59/59 全绿**
  （`node --test test/epistemic.test.mjs test/audit-persist.test.mjs
  test/domain-version-compat.test.mjs test/self-protection.test.mjs`）
- `node test.mjs` → 23/23 全绿
- `node bin/verify-manifests.mjs` → ERROR 0（并顺带清掉本插件此前
  manifest 0.2.2 ≠ package 0.2.1 的 VERSION_DRIFT WARN）
- `node bin/check-l0-frozen.mjs` → 11 个受保护单元未变更

**已知代价**：deny 级规则一旦写错，工具层面无法删除或停用，只能走人工解封路径。

**回滚**：`git revert` 本提交即可；已补种的三条自保护规则留在存储里，
需人工从 agint_rules 存储层删除。

## [0.2.2] — 2026-11-02

### Added — 命中计数持久化（提案 09ae2017：重启不清零）

**起因**：`rule_audit` 返回的 hits/denies/asks/advisories 原本只是
`lib/index.js` 里的内存 Map，dsh 重启即清零。后果是「这条 ask 门禁历史上到底
拦过多少次」永远答不出来——2026-09-07 排查 abtest_start 两次调用是否被
`tools/pre-execute` 拦过，回溯不到就是当时的实测卡点。epistemic 护栏命中数
同样每次重启归零。

**改法**：
- `agint_rules` 域加第二张表 `rule_audit`（key = ruleId，
  值 = `{hits, denies, asks, advisories, epistemics, firstHitAt, lastHitAt}`），
  **version 保持 1**（升版本会让存量 `agint_rules.json` 打不开，见 README 边界）。
- `bump()`：同步改内存 → 标脏 → 微任务里合并成一次 flush → `put` 落库。
  写失败只告警，拦截判定不受影响。
- 启动时 `loadAuditBaseline()` 把表里的基线**合并**进内存（存储值 + 本次启动
  已累计的 delta），boot 早期命中的计数不会被基线盖掉。
- `audit()` **保持同步**（`agint-metrics` 读 `rules.audit().totals` 不 await，
  改成 Promise 会让 rules.hits / adherencePct 静默变恒 0）。
- `rule_remove` 不再删计数：历史账本与规则表分离。
- 行数上限 100，超限按 hits 升序淘汰。

**语义变化（重要）**：`rule_audit` 的数值从「本会话」变成「跨重启累计
（lifetime）」。`rules.hits` / `rules.adherencePct` 指标也随之为累计口径，
delta 才是「上次采集以来的活动量」。

**验证**：
- `node --test test/audit-persist.test.mjs` → 9/9（含反向控制：删掉
  `queueFlush()` 或 `loadAuditBaseline()` 会红 1 / 3 条）
- `node --test test/domain-version-compat.test.mjs` → 2/2（真实 json 后端：
  老文件→新代码可开、审计行落盘、重开仍在、老代码可读回；对照测试证明
  version 升到 2 必然 version-mismatch）
- 既有 57 条 + smoke 4/4 全绿，无回归。

**回滚**：`git revert` 本提交即可。已落库的 `rule_audit` 表在旧代码下被忽略
（旧代码按 descriptor.tables 遍历），不会打挂存储。

## [0.2.1] — 2026-09-28

### Fixed — lint() 不再误报 epistemic 三规则为 duplicate-pattern

**根因**：`lint()` 的 pairwise 去重段（动作层正则通道）从未排除 `claim: true`
的规则。三条 claim 种子在 `seedEpistemic` 时被显式注入占位 pattern `(?!)`
（schema 通过用），三条 pattern 字符串字面相等，导致 lint 把 epistemic 三规则
两两报为 `duplicate-pattern`，每周被 `agint-aesthetic-oracle` 当作"冗余度"
扣分（redundancy 7.55%，满扣 20 分）。

**修法**：lint 的 pairwise 段加一行
```js
if (a.claim || b.claim) continue;   // 认知层规则走独立 engine，不参与动作层去重
```

**验证**：
- 单元 smoke 4/4 通过（plugin-preflight §2 兜底）
- `node test/smoke.mjs` 退出 0
- 旧的 23 条动作型规则回归不变（smoke 中 fake-dup-a<+fake-dup-b 仍被报 duplicate）
- 实测 oracle weekly 在修后冗余度维从 7.55% → 0%（待 oracle 跑后复验）

**回滚**：单行 delete `if (a.claim || b.claim) continue;` 即可。lint 行为退回到
误报 epistemic 三规则但动作层逻辑零影响。

## [0.2.0] — 2026-09-21

### Added — 断言型护栏（epistemic guard）

在原有「动作层」正则护栏之外，新增第二条**认知层**通道：检查模型输出里的
**断言有没有带证据**。起因是 2026-09-21 的一次自我复盘——工作区 68 条 K 记录里，
同一族错误反复出现（K30 / K33 / K34 / K59 / K68），共同动作都是
「用『看起来对』的推理替代『跑一遍』的验证」，而这类错误**不触发任何现有规则**
（它们不像删错文件那样当场炸）。

- `evaluateEpistemic(rule, text)` — 纯函数，三档断言识别：
  - `existence`：存在性断言（不存在 / 没有 / 不支持 / 无 / 未挂载…），要求宾语是技术实体
  - `quantifier`：全称量化（全部 / 所有 / 均 / 恒 / 从未…），要求量化词 + 复数宾语 + 封闭信号三者齐备
  - `negated-self`：否定式自述（"我没有删除过任何文件"），无法自证
- `epistemicSeedRules()` — 三条内置种子，全部 `action: 'advisory'`（首版不做硬拦）
- `buildEpistemicMessage(toolName, hits)` — advisory 注入，措辞是「这句话需要证据」
  而非「你违规了」，避免模型读成指责后开始辩解
- service 新增 `checkClaims(text)` / `seedEpistemic()`；audit 新增 `epistemics` 计数
- `tools/post-execute` 新增通道 2：扫描工具参数与结果里的自由文本
  （`extractScannableText`），与通道 1（动作层 advisory）**互不干扰**，两条通道
  各自去重、合并注入

### 豁免优先（设计铁律）

**豁免先于命中**——误杀正常交流的代价远大于漏放一条断言。命中前先过五道豁免：
`EVIDENCE`（已带 grep/行号/命中数/K 编号/实测/取证）→ `BENIGN_OBJECT`
（权限/报错/时间/必要…天然不可争议的宾语）→ `QUESTION`（疑问推测）→
`TASK`（祈使任务）→ `HEDGE`（已声明"还没查"）。另有三处通道内豁免：
条件句（"如果接口不存在…"）、非技术宾语、`negated-self` 的权限类宾语。

### 实测数据（2026-09-21）

| 指标 | 结果 |
|---|---|
| 单元测试 | **40/40 PASS**（A 组 10 条必拦 / B 组 25 条必放 / C 组 5 条结构不变量） |
| 回归兼容 | 原 23 条动作型测试全绿，0 条动作型规则串入断言通道 |
| E2E 误杀率 | **0/10**（修复前 2/10） |
| 真实语料泛滥率 | **3.79%**（2218 句命中 84；>15% 判为泛滥需回退） |
| 宿主部署位 | 仓库/部署位 md5 一致，引擎可从宿主字节 import |

### 已知边界（诚实记录，不做过度承诺）

- **命中率有限**：历史错判原句里 3/8 被拦。"这个字段是自造的"（判断而非存在性）、
  "全为 heuristic-degraded"（宾语非技术实体）在边界外，**这是刻意的取舍**——
  为压低误杀而牺牲了这两类。
- **扫不到模型的消息流**：`tools/post-execute` 只能读到工具参数与结果，
  读不到"模型接下来会说的那句话"。当前是**半影子档**：靠工具产物里的文本
  在下一次请求前完成提醒。真正的全覆盖需要 message-level 钩子（宿主暂无）。
- **单字动词是激进的**：`无/未/没/非/缺` 极易泛滥，靠 `TECH_OBJECT_RE` 收窄。
  已用 B17–B22 六条抗误杀测试 + 3.79% 泛滥压测守住；若后续出现噪音，
  回退顺序应为：先删单字动词，再考虑关掉 `quantifier` 档。

### 回滚

本版只增不改：原 `check()` / 动作层 advisory 路径**字节级未动**。
回滚 = 用 `D:/DSH/_backup_rules_20260921/` 下的 host 备份覆盖部署位，
或直接把三条种子的 `enabled` 置 false（`rule_set_enabled` 工具即可，无需重启）。
