# Known Limitation: skills_root 整目录 rename 突发 EPERM

> 建档：2026-09-21。首次发现：2026-09-17（release job 真实现场）。
> 宿主版本基线：`@deepseek-ai/dsh`（`dsh-skill-filesystem` Chokidar watcher 形态）。
> 相关代码：`plugins/agint-skill-autocreate/lib/release-manager.js`

## 缺口是什么（一句话）

**技能发布时的「整目录 rename 进 skills_root」会以约 0.3%~1% 的概率撞上
Windows 瞬时 `EPERM`；当前靠退避重试兜住，但退避窗口与实测占用窗口的关系
从未被量化，且 09-17 提出的根因级修法（tmp 目录移出 skills_root）至今未实施。**

注意措辞：这是**已缓解的性能/可靠性缺口**，不是「技能挂不上」的现行故障
——重试已经把最终失败率压到观测不到（详见 §4）。

## 1. 现象与现场证据

### 1.1 唯一一次真实现场（2026-09-17 06:04:49Z）

生产存储 `storages/agint_skill_autocreate.json` 的 `audit_log` 里有且仅有 1 条：

```json
{
  "timestamp": "2026-09-17T06:04:49.608Z",
  "action": "release_publish_failed",
  "targetId": "sc_20260917_6939ae",
  "details": { "skillName": "pwsh-pwsh-pwsh-pwsh" },
  "reason": "EPERM: operation not permitted, rename
    'C:\\Users\\Administrator\\.dsh\\.agent-presets\\agint\\skills\\.pwsh-pwsh-pwsh-pwsh.tmp-1789625089555'
    -> 'C:\\Users\\Administrator\\.dsh\\.agent-presets\\agint\\skills\\pwsh-pwsh-pwsh-pwsh'"
}
```

旁证：skills_root 留下 `.pwsh-pwsh-pwsh-pwsh.tmp-1789625089555.failed-1789625089600`；
45ms 后把同一目录改名到 `.failed-*` 是**成功**的 → 说明是**瞬时占用**，不是权限配置问题。

⚠️ **注意时间**：该次失败发生在 `renameWithRetry` 合入（`d359692`，09-17 22:41）**之前**。
即「重试兜底生效后，是否还发生过一次最终失败」——**目前没有观测到，但这不等于不会发生**。

### 1.2 机理（09-17 源码级取证）

`dsh-skill-filesystem` 是 dsh 的本地技能 provider，`watch: true` 默认开
（Chokidar 监听技能根）。其 `isPotentialSkillPath`（`lib/index.js:555`）
**只跳过 `.system`**，`<root>/<name>/SKILL.md` 一层深即视为候选技能。

→ 插件在 skills_root **内部**新建的 `.<name>.tmp-*` 目录**会被 watcher 发现并读取
其 `SKILL.md`**（Windows 上持有句柄）→ 紧随其后的整目录 `rename` 报 `EPERM`。

**次生问题**：`.tmp-*` / `.failed-*` 目录**会被当成技能发现**（不只 `.system` 被跳过）
→ 失败的落盘仍会让该技能名进入技能目录；且孤儿目录无清理路径。

### 1.3 退出码语义（一个易踩的坑）

Node 的 `fs.rename` 把 Windows `MoveFileExW` 的「拒绝访问」统一报成 `EPERM`。
这与「路径不在允许范围内」这类**确定性** EPERM **同码**。

→ **不能凭 `code === 'EPERM'` 断定是瞬时占用**。判据要看：**同一操作立刻重试是否成功**
（瞬时占用会成功，确定性错误不会）。

## 2. 当前缓解（已落地）

`release-manager.js:220` `renameWithRetry(src, dest, opts)`：

```js
const delays = opts.delays ?? [0, 40, 120, 300, 700];
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
```

- 只对瞬时码退避重试；确定性错误立即抛出（不浪费预算）；
- 两个调用点（`release-manager.js:279` publish / `:293` archive）都已改用它；
- 失败时错误信息附带重试次数 + 源路径，便于取证。

**退避结构**：

| 尝试 # | 触发时刻（累计 ms） |
| --- | --- |
| 1 | 0 |
| 2 | 40 |
| 3 | 160 |
| 4 | 460 |
| 5 | 1160 |

即 5 次尝试、总窗口 **1160 ms**。

## 3. 2026-09-21 窗口量化（新取证）

### 3.1 实验 1：占用窗口到底多长

探针 `D:\DSH\_probe_eperm_window.mjs`。真实 skills_root；撞 `EPERM` 后**每 25ms
重试一次直到成功**，记录等待毫秒数（无上限 60s）。**刻意不加退避** —— 要的是窗口本身。

| 轮次 | 轮数 | 撞上次数 | 实测等待 |
| --- | --- | --- | --- |
| probe1 | 40 | 0 | — |
| probe2 | 300 | 3 | 32 / 42 / 46 ms |
| probe3 | 400 | 3 | 31 / 40 / 48 ms |
| **合计** | **740** | **6（0.81%）** | **全落在 31~48 ms** |

**结论 1**：实测占用窗口 **31~48 ms**。
**结论 2**：现有退避（5 次 / 1160ms）对该窗口是**大幅过剩** —— 第 2 次尝试（t=40ms）
即可覆盖其中一部分，第 3 次（t=160ms）覆盖全部。
**结论 3**：**从未观测到 >1.16s 的窗口**。也就是说，现有的退避长度不是瓶颈
——「退避不够长」这个假设**没有数据支持**。

### 3.2 实验 2：根因级修法对照（tmp 移出 skills_root）

09-17 曾建议但**从未实施**的修法：把 tmp 目录建到 skills_root **之外**
（同盘兄弟目录，保证 rename 仍原子），watcher 就看不到临时目录。

探针 `D:\DSH\_probe_eperm_rootcause.mjs`。三组同循环、同进程、**均不做重试**
（这是关键：加了 retry 两组都会成功，掩盖差别；要测的是**故障发生率**）：

- A 组：tmp 在 skills_root 内（现状做法）
- B 组：tmp 在 skills_root 外（根因修法）
- C 组：tmp 在内 + 先等 60ms 再 rename

| 轮次 | A（内） | B（外） | C（内+等60ms） |
| --- | --- | --- | --- |
| rc1 (300) | **3 失败 (1.0%)** | 0 | 0 |
| rc2 (300) | 0 | 0 | 0 |
| rc3 (500) | 0 | 0 | 0 |
| **合计 (1100)** | **3 (0.27%)** | **0** | **0** |

**⚠️ 统计诚实性（必须写清）**：A 组 3/1100、B 组 0/1100。
Fisher 精确检验 **p ≈ 0.25 → 不显著**。

**这组数据支持「tmp 在内是诱因」这个方向，但样本量不足以宣称 B 优于 A。**
要把它做成统计显著（p<0.05），按当前 0.27% 的基线率，两组各需约 **3000~4000 轮**。

**结论 4**：故障是**突发型**（bursty）而非稳态 —— rc1 撞 3 次、rc2/rc3 各 1100 轮共撞 0 次。
与宿主/杀软的活动节律相关，不可按「固定 5%」建模。

**结论 5**：C 组（在内 + 等 60ms）0 失败，与「窗口只有 31~48ms」自洽
—— **光是等待就足以跨过**，不需要把 tmp 移出去。

## 4. 当前是否还在咬人（诚实边界）

| 问题 | 答案 |
| --- | --- |
| 重试生效后，有过最终失败吗？ | **没观测到**。audit 里 `release_publish_failed` 仅 1 条，且早于重试合入。 |
| 重试有效吗？ | **实测有效**：实验 1 中 6 次撞窗口，激进重试全部在 ≤48ms 内成功。 |
| 那还需要修吗？ | **优先级应下调**。这是「已被重试兜住」的缺口，不是现行故障。 |

⚠️ **但有两个真实残留**（与重试无关）：

1. ~~**孤儿目录泄漏**：`.tmp-*` / `.failed-*` 会被 watcher 当技能发现，且**无清理路径**，
   会长期堆积在 skills_root。~~ → **✅ 已于 2026-09-21 修复**（见 §5.1）。
2. **可观测性不足**：重试成功时**不留任何痕迹**（`return i + 1` 直接返回，
   只有失败才留 audit）。→ 「这次发布到底是一次过还是重试过的」**无人知道**，
   出问题时也无法判断重试是否正在承压。**（仍待修）**

## 5. 未实施的修法（按性价比排序）

| # | 修法 | 收益 | 成本 | 证据支持 |
| --- | --- | --- | --- | --- |
| **1** | ~~清理孤儿 `.tmp-*` / `.failed-*`~~ | 消除技能目录污染 | 低 | ✅ **已做（§5.1）** |
| **2** | **重试成功时记痕**（attempts>1 落 audit/日志） | 让「重试在不在承压」可观测 | 极低 | §4 残留 2，**仍待修** |
| **3** | 把 `delays` 前两档缩短（如 `[0, 25, 150, 450, 900]`） | 降低平均延迟 | 低 | §3.1（窗口 31~48ms） |
| **4** | tmp 移出 skills_root | 根因级规避 | **中**：需新增 staging 配置项 + 跨目录 rename 的同盘保证 | §3.2 **方向支持但不显著** |
| **5** | 加长 `delays` | ❌ 无收益 | — | §3.1 **明确反对**：从未见 >1.16s 窗口 |

### 5.1 ✅ 已实施：孤儿清理（2026-09-21，提交 `6c2b0d4`）

**做法**：`release-manager.js` 新增两个导出 ——

- `isOrphanTmpDir(name)`：判据 `/^\.\S+\.tmp-\d{10,}(\.failed-\d{10,})?$/`。
  ⚠️ **必须同时满足「点开头 + `.tmp-` + ≥10 位数字时间戳」**，否则会误删
  **用户以点开头的真实技能目录**（如 `.system`、`.config`、`.hidden-skill`）。
  宁可漏删，不可误删 —— 测试里有专门的红线用例。
- `sweepSkillOrphans({skillsRoot, ttlMs, nowMs, dryRun})`：**带 TTL**（默认 1h）
  的目录清理。为什么不是立刻删：正在发布的那个 tmp 是**活的**，立刻删会打断进行中的发布；
  1h 远大于实测占用窗口 31~48ms，足够安全。结构照抄已验证的 `staging.cleanupStale`。

**接线**：挂在 **`detect()`（日聚合入口）** 末尾，而不是发布流程里 ——
发布失败是低频事件（0.27~0.81%），挂那儿可能几天不跑一次；日聚合每天必跑，是天然兜底节拍。
返回 `detect()` 的 `orphanSweep` 字段 + 写 audit（`action: orphan_sweep_completed`）。

**开关**：`orphan_sweep_enabled`（默认 **true**，K51 出厂即开）+
`orphan_sweep_ttl_minutes`（默认 60），两个都在 `RUNTIME_CONFIG_KEYS` 里，可运行时关。

**验收（硬证据）**：
- 单测 7 例（判据 2 + TTL/红线/dryRun/目录不存在/同名文件 5）→ **全套 324/324 PASS**；
- 真实 skills_root 端到端：造 3 个孤儿 → 超 TTL 2 个被清、新鲜 1 个保留、
  **真实技能 11 个全部未动**、跑完 skills_root 恢复原状；
- **完整 `detect()` 路径**（宿主真字节 + mock ctx）→ `orphanSweep.removed`
  有值、文件系统核对通过 → **证明接线真的通了，不是"函数写好了没人调"**；
- 宿主部署位 md5 对账一致；`bin/check-tool-schemas.mjs` 25 文件 / 109 schema / 0 invalid。

**⚠️ 冒烟测试抓出的一个真缺陷（值得记）**：第一版把 audit 写入和清理放在**同一个 try** 里，
audit 因缺 `targetId` 抛错 → 整个 `orphanSweep` 被 catch 覆盖成 `{removed: [], error}`。
**文件已经删了，但对外显示"什么也没做"** —— 正是 K51「可观测 > 可审批」要防的形态。
修法：**结果先存，audit 单独 try**，audit 挂了只记 `auditError`，不抹掉已发生的清理事实。

**污染真实性（源码级 + 实测双证据）**：宿主 `isPotentialSkillPath`
（`dsh-skill-filesystem/lib/index.js:552-563`）只跳过 `.system`，
`<root>/<seg0>/SKILL.md` 一律视为技能。实测形态 `.foo.tmp-<ts>/SKILL.md` → 判定为「技能」，
名字形如 `.foo.tmp-1789625089555`。
⚠️ **复现时的坑**：宿主两边都走 native `resolve()`（分隔符一致）；
若用 `path.join()` 造路径却和正斜杠 `root` 比较，会得到**假阴性**（我第一次就踩了）。

## 6. 与官方原子写实现的对照（一个值得知道的事实）

宿主自带 `@deepseek-ai/dsh-atomic-write`（`writeFileAtomic`）也做同样的退避重试：

```js
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20;
const WINDOWS_RENAME_RETRY_MAX_MS = 200;
const WINDOWS_RENAME_RETRY_LIMIT = 8;
// 指数退避 20→40→80→160→200→200→200→200，总计约 1.1s
```

**有意思的是**：官方参数（初始 20ms / 上限 200ms / 8 次 / 总约 1.1s）与 AGINT 手写的
`[0,40,120,300,700]`（总 1160ms）**总窗口几乎一致**，且官方初始延迟更短（20ms vs 40ms）
—— 与我们实测窗口下界 31ms 更贴近。

⚠️ 另注：`dsh-storage-json` 的 `writeAtomic`（存储域落盘）**自身不带重试**
（直接 `rename` 后 `catch` 清理）。这是宿主行为，AGINT 侧改不了。

⚠️ **同时这也纠正一条我此前的错误说法**：我曾在汇报中说「存储域原子写完全无重试，
且这是 EPERM 的第二条路径」。**证据不支持这个断言** —— 生产 audit 里
`release_publish_failed` 只有 1 条，原因字段明确指向 **skills_root 的目录 rename**，
没有任何一条证据指向存储域落盘。**存储域从来没被观测到 EPERM。**

> ⛔ **2026-09-26 反证 —— 上述结论已被推翻**
>
> 当日「诊断自激环」事故中，`agint-diagnosis` 的 `memory.write` **反复报 EPERM**，
> 目标正是存储域文件 `C:\Users\Administrator\.dsh\storages\agint.json`
> （写临时文件后 rename 覆盖失败）。**存储域确实会发生 EPERM，而且是反复发生，不是孤例。**
>
> **为什么此前"没观测到" —— 这是取样偏差，不是它没发生。**
> 上文的依据是「生产 audit 里没有存储域条目」。但**存储域的落盘失败根本不写 audit**：
> 宿主 `dsh-storage-json` 的写链是 fire-and-forget，失败被 `write.catch(() => {})` 静默吞掉；
> AGINT 侧 `memory.write` 调用点又用 try/catch 包住、只 `console.warn`。
> **两条静默叠加 ⇒ audit 天然看不到它 ⇒「audit 里没有」推不出「从未发生」。**
> ⇒ **教训（可复用）：在用「某审计面没有记录」推断「某事件不存在」之前，
> 先确认该事件**是否会被写进这个审计面**。** 同类：静默失败（`docs/known-limitations/` 多处）。
>
> **触发条件（推断，未确证）**：存储域是 `atomic: json` 的**单文件全量重写** ——
> 每写一条都要把整个文件重写一遍。事故中 `agint.json` 被自激环撑到 **50 MB**
> （基线 211 KB，涨 200+ 倍），单次全量重写耗时显著拉长，
> 撞上 Windows「文件正被占用」窗口的概率随之上升。
> 与 skills_root 的目录 rename **不是同一条路径，但同属一类根因：
> Windows 占用窗口 + 无重试**。

## 7. 复现方式

探针已归档进仓库（`bin/`），可直接跑：

```bash
# 实验 1：占用窗口测定（无退避，激进探测）
node bin/probe-rename-eperm-window.mjs <runTag> <轮数>

# 实验 2：根因对照 A/B/C（均不重试）
node bin/probe-rename-eperm-rootcause.mjs <runTag> <每组轮数>
```

两个探针都**只写 `zzprobe*` / `.probe*` 前缀**，每轮结束自清，不碰生产数据。
外部 staging 目录：`C:\Users\Administrator\.dsh\.agent-presets\agint\_probe_staging`
（若不再需要可整个删除）。

**想拿到统计显著结论**：实验 2 每组跑 **3000~4000 轮**（按 0.27% 基线率）。

## 8. 诚实清单（这份文档没证明什么）

- ❌ **没有证明** B 组（tmp 移出）在统计上优于 A 组 —— 方向一致但 p≈0.25。
- ❌ **没有证明** 重试生效后从未发生最终失败 —— 只是「没观测到」，
  且这恰恰因为**重试成功不留痕**（§4 残留 2）而无法自证。
- ❌ **没有证明** 占用窗口永不超 1.16s —— 740 轮只撞 6 次，
  对长尾的估计能力很弱。若真实存在 1% 概率的秒级窗口，本实验测不到。
- ❌ **没有证明** 机理是 watcher 独占 —— 「tmp 在内 vs 在外」的差别是**相关**，
  §1.2 的 watcher 解释是**源码级合理推断**，未做句柄级验证（如 Process Monitor 抓占用者）。
