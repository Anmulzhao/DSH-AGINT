# 已知限制：`curriculum.challenge-verdicted` 总线仍为 0 条 —— 出队不自动执行

> 状态：**断链仍成立，但根因已于 2026-10-09 01:33 发生变化**——
> `submit()` 判定路径**确实跑过一次**（`attempts` 表已有 1 行、`status=passed`），
> 只是那次是**带外提交**（无活跃宿主 ctx），`publishEvent` 无处可发，
> 所以总线仍是 0 条。下方「症状 / 取证」两节记录的是**订正前**的历史观测，
> 已逐条标注当前值。
> 相关：[diagnosis-completed-upstream-starved.md](./diagnosis-completed-upstream-starved.md)。

## 症状

- 总线 `curriculum.challenge-verdicted` **全历史 0 条**（2026-10-09 12:15 实读仍为 0）。
- 下游 `agint-input-gateway` 的 `adversarial` 频道订阅了它
  （`plugins/agint-input-gateway/lib/channels/adversarial.js:74-77`，三个主题并列），
  但从未收到过该主题的任何一个事件。
- ~~`agint_curriculum` 域 `attempts` 表恒 **0 行**~~ —— **此条已失效**。
  当前 `attempts` 表 **1 行**（`att_20261008_7df873`，`result=pass`）。
  判定逻辑确实执行过，只是执行路径上**没有活的宿主 ctx 去发事件**。

## 结论

**发布方存在，且接线正确** —— `plugins/agint-curriculum/lib/index.js:369`
在 `submit()` 判定路径末尾发布本主题。

**总线 0 条有两个互不替代的原因，需要分开看：**

1. **主因（未变）**：系统内没有执行器。「出队」之后没有任何自动驱动，
   全库 `curriculum.submit` 的唯一调用方仍是 `curriculum_submit` 工具。
2. **新增（2026-10-09 01:33）**：人做了这个挑战，但走的是**带外路径**——
   `publishEvent` 依赖活的 `ctx.get('agint.eventBus.publish')`
   （`lib/index.js:87-97`，取不到就静默 `return false`，不抛不记）。
   宿主不在运行时，事件根本没有发布环节可言。

⇒ **「attempts 表 0 行」不能再用作本条的判据**。用它来论证断链，
会在下一次带外提交后立刻失真。判据应改为「总线 `curriculum.challenge-verdicted` 计数」。

## 断点在哪：cron 自己的 description 就写明了

`plugins/agint-cron/lib/jobs.js:402` 的 `curriculum-weekly`，
description 原文：

> `边界探测 -> 对待练域逐一生成挑战（出队不自动执行）（weekly）`

完整链条：

1. **cron `curriculum-weekly`**（Thu 09:30）触发
   → `curriculum.probe()`
   → 读 self-model snapshot，`probeDomains()` 选域
   → **发布 `curriculum.boundary-probed`** ✅ 已发生 3 次
2. `curriculum.generate()`
   → **写 `challenges` 表**，`status=open`、`attemptCount=0` ✅ 已发生
3. **【出队不自动执行 —— 断在这里】** ⚠️ 2026-10-09 起不再是死路：
   人可以手工做掉，但**没有任何一条受支持的路径**把 4→6 串起来
4. （需要 agent 显式驱动）`curriculum_next` 工具
5. （agent 实际完成任务）
6. `curriculum_submit` 工具
   → 写 `attempts` 表 ✅ 已发生 1 次（2026-10-09 01:33，带外）
   → **发布 `curriculum.challenge-verdicted`** ❌ 仍 0 条

**全库搜 `curriculum.submit`，唯一调用方是 `curriculum_submit` 工具**
（`plugins/agint-curriculum/lib/tools.js:72`）。
**没有任何 cron、没有任何自动执行器。**

## ⚠️ 订正：2026-10-09 01:33:38 的一次带外提交

**这次提交绕过了宿主，所以三处记录彼此对不上——排查时请以本节为准。**

时间线（+08）与其在存储中的落点：

| 时刻 | 事件 | 落点 |
| --- | --- | --- |
| 10-08 09:30:45 | cron 生成挑战，`status=open`、`attemptCount=0` | `challenges` / `audit_log` |
| 10-09 00:08:30 | `curriculum_stats` 被调用 → 报 `attempts.total=0` | `agint_tool_stats.jsonl` ts=1791475710465 |
| **10-09 01:33:38** | **判定落库**：`attempts` +1 行、`status→passed`、`attemptCount→1` | `attempts.verifiedAt=2026-10-08T17:33:38.685Z` |
| 10-09 12:10:48 | `curriculum_list` 被调用 → 报 `attempts=1 [passed]` | `agint_tool_stats.jsonl` ts=1791519048082 |

⚠️ **`curriculum_stats` 的 `attempts.total` 与 `curriculum_list` 的 `attempts=`
是两个不同的数据源**（前者数 `attempts` 表行数，后者读 `challenge.attemptCount`
这个 challenges 表字段）。二者当前一致，但没有任何机制保证一致。
跨时刻比较这两个数会得出「矛盾」的假象——上面两次调用相隔 12 小时，
中间正好夹着 01:33 那次提交。

判定为带外提交（而非走活跃宿主的 `curriculum_submit` 工具）的三条证据：

1. `agint_tool_stats.jsonl` 里 curriculum 系工具只有 `curriculum_list` 与
   `curriculum_stats` 各 1 次，**没有 `curriculum_submit`**；
2. `audit_log` **没有 `challenge_next`** —— `nextChallenge()` 每次必写一条审计，
   没有就是没跑过（`submit()` 无状态守卫，`open` 可直接 submit）；
3. 提交时刻落在总线一段 **32.7 分钟静默期**（17:05:58Z → 17:38:39Z）正中，
   宿主当时无会话、全线无事件。

另有一条毫秒级时序佐证它跑的确实是 `submit()` 本体：
`attempts.verifiedAt`(…38.685) → `challenges.updatedAt`(…38.706) →
`difficulty_state.lastAdjustedAt`(…38.709) → `audit_log.timestamp`(…38.712)，
与 `submit()` 内部的写入顺序逐项吻合。

**代价**：这次人工投入没有留下任何总线事件，`adversarial` 频道依旧收不到东西；
且出队环节缺失，审计链上只有 `challenge_generated` → `challenge_verdicted`。

## 取证

**订正前（2026-10-09 00:08 前后的观测）与当前（2026-10-09 12:15 实读）对照：**

| 观测项 | 订正前 | 当前 |
| --- | --- | --- |
| `agint_curriculum.challenges` | 1 | 1 |
| `agint_curriculum.attempts` | 0 | **1** |
| `agint_curriculum.difficulty_state` | 1 | 1 |
| `agint_curriculum.audit_log` | 1 | **2** |
| 总线 `curriculum.boundary-probed` | 3 | 3 |
| 总线 `curriculum.challenge-verdicted` | 0 | **0**（未变） |

那个 challenge 是真的，生成于最近一次 cron，后被 01:33 的提交判定为 pass：

```
id=clg_20261008_064839   domain=integration   level=D1
status=passed   attemptCount=1        ← 订正：原为 open / 0
createdAt=2026-10-08T01:30:45.518Z
updatedAt=2026-10-08T17:33:38.706Z   ← 订正：新增
audit_log: challenge_generated / reason="boundary-probe 驱动的挑战生成"
audit_log: challenge_verdicted / result=pass / reason="steps 5 步且包含全部必需关键词"
```

对应 cron 运行记录：`curriculum-weekly` `lastRunAt=2026-10-08T01:30:45.696Z`、
`lastResult=ok`、摘要 `generated=1` —— 与 challenge 的 `createdAt` 对得上。

## 上游已经恢复，断点下移了

三次 `curriculum.boundary-probed` 事件载荷：

| 探测时间 | `domains`（待练） | `unverifiable` |
| --- | --- | --- |
| `2026-09-29T16:55:51Z` | `[]` | `[]` |
| `2026-10-01T01:30:17Z` | `[]` | `[]` |
| `2026-10-08T01:30:45Z` | **`['integration']`** | `[]` |

⇒ 前两次探测命中 0 域（与 `docs/wiring-exemptions.json` 当时的记录一致），
**2026-10-08 探出了 `integration` 并成功生成挑战**。

## 对既有档案的订正

`docs/wiring-exemptions.json` 中 `adversarial` 频道那条豁免的 `reason` 写着：

> 「...上游发布方存在（agint-curriculum 会发），但该主题总线全历史 0 条
> —— curriculum 从未判定出任何 challenge。根因不属网关接线：同文件 domains 的
> agint_curriculum 条已查明 self-model 能力画像过薄，probe 命中 0 域
> => 无 challenge 可判。」

**这段在 2026-10-05 写下时是准确的**（当时最近一次探测是 10-01，确实 `domains=[]`），
**但现已过时**：上游 self-model 已恢复出 `integration` 域，challenge 也生成了。

**按现在的描述去修会修错地方** —— 会去追 self-model 能力画像，而那里现在没问题了。
真实断点是「挑战出队后无人执行」。

⚠️ 同一条豁免的 `evidence` 另有一处数字对不上：
它写「2026-10-05 实测总线有 `curriculum.boundary-probed=5` 条」，
但总线全历史只有 **3** 条（09-29 / 10-01 / 10-08）。总线最早事件在 2026-09-29，
且更早的老事件仍在、无轮转或驱逐迹象，所以这个 5 对不上。
按本文档所在目录的取证纪律（「数生产存储的行数，口径必须精确」），
这条 evidence 数字应订正为 3。

⚠️ **2026-10-09 第二次订正**：该豁免（及 `domains` 里的 `agint_curriculum` 条）
此前还以「`attempts` 表恒 0 行」作为判据之一，现已不成立（`attempts`=1）。
两处已按当前实测数据改写，判据改为总线主题计数。
⚠️ `domains` 那条写「challenges 永远 0 条 → 存储域无文件可落盘」——
现在 challenges=1、attempts=1，存储域文件早已存在，该条实质已解除。

## 下游还叠了一层：只转发 fail

`plugins/agint-input-gateway/lib/channels/adversarial.js:130-131`：
`curriculum.challenge-verdicted` **只转发 `result=fail`**，pass 不转发。

⇒ 即使本主题通电，绝大多数判定结果也不会变成 adversarial 信号。
评估这条链是否值得通电时，这一层必须一起算进去。

## 复核命令（换机器时重跑）

前置：`export DSH_HOME=<你的 AGINT-data 目录>`，下文路径由 shell 展开。
⚠️ 注意不要写成转义版（反斜杠加美元符）：`python3 -c "..."` 外层是双引号，
转义会把美元符变成字面量，Python 收到的是一串普通字符，直接 FileNotFoundError。
本文档 2026-10-09 之前的 4 条命令都踩了这个坑，已一并订正。

```bash
# 1) curriculum 域四张表行数
python3 -c "import json;print({k:len(v) for k,v in json.load(open('$DSH_HOME/storages/agint_curriculum.json'))['tables'].items()})"

# 2) 三个相关主题的总线条数（challenge-verdicted 是本条的**唯一**判据）
python3 -c "
import json, collections
d = json.load(open('$DSH_HOME/storages/agint_event_bus.json'))
c = collections.Counter(v.get('topic') for v in d['tables']['events'].values())
for t in ['curriculum.boundary-probed','curriculum.challenge-created','curriculum.challenge-verdicted']:
    print(c.get(t,0), t)
"

# 3) 看探测选出了哪些域（上游是否恢复的直接证据）
python3 -c "
import json
d = json.load(open('$DSH_HOME/storages/agint_event_bus.json'))
rows = [v for v in d['tables']['events'].values() if v.get('topic') == 'curriculum.boundary-probed']
rows.sort(key=lambda v: v.get('occurredAt') or '')
for v in rows:
    p = (v.get('envelope') or {}).get('payload') or {}
    print(v.get('occurredAt'), 'domains=', p.get('domains'), 'unverifiable=', p.get('unverifiable'))
"

# 4) 确认 submit 仍无自动调用方（除工具外）。⚠️ 这条要在**仓库根**跑（找 plugins/），
#    与其余按 $DSH_HOME 定位存储的 1/2/3/5 条工作目录不同
rg -n "curriculum\.submit|\.submit\(" plugins/ --glob '!**/test/**' --glob '!**/node_modules/**'

# 5) 判定是否走带外路径：curriculum_next 应出现在 audit_log，
#    且 tool_stats 里应有 curriculum_submit
python3 -c "
import json
cur = json.load(open('$DSH_HOME/storages/agint_curriculum.json'))
acts = [v.get('action') for v in cur['tables']['audit_log'].values()]
print('audit actions:', acts)
print('有 challenge_next 吗:', 'challenge_next' in acts)
tools = set()
for line in open('$DSH_HOME/storages/agint_tool_stats.jsonl'):
    try: tools.add(json.loads(line).get('tool'))
    except: pass
print('curriculum 系工具:', sorted(t for t in tools if t and t.startswith('curriculum_')))
"
```

**第 5 条是判别「带外提交」的关键**：若 `audit actions` 里没有 `challenge_next`、
且工具集里没有 `curriculum_submit`，但 `attempts` 表非空 ——
那就是有人绕过宿主直接写的域，总线 0 条属预期，不要据此判定「从未判定」。

## 裁定：按设计休眠收口（2026-10-09）

**老板裁定：不建自动执行器，本条不再作为待修缺陷跟踪。**

理由：

1. 与 `AGENTS.md` 边界冲突 —— 「智进不是业务 agent，业务任务 >= 2 次就沉淀为
   skill / 自动化，不再由智进手工执行」。curriculum challenge 正是这类任务。
2. 下游叠一层「只转发 fail」，即使这条链通电，多数判定结果也不会成为
   adversarial 信号，投入产出比差。
3. 「出队不执行」本身自洽 —— 挑战是给人练手的，不是给系统自转的。

⚠️ **这条裁定的前提是「人可以选择去做」。** 若日后连人也不做这些挑战，
那 `challenges` 表会持续积压（cap 未知），届时需要单独评估清理策略 ——
本裁定不覆盖那个场景。

⚠️ **前提已被部分行使，但行使方式暴露一个流程缺口**：
2026-10-09 01:33 人确实做了这个挑战（`待办核销报告-20261009.md` 记为「真做了」），
但走的是带外路径 —— 绕过了 `curriculum_next` / `curriculum_submit` 两个工具，
于是**既没进审计链的出队环节，也没发总线事件**。
「裁定」本身不变（仍不建自动执行器），但补一条：
 **日后人工作业应走 `curriculum_next` → `curriculum_submit` 工具**，
 否则人工投入对下游（adversarial）与审计追溯都是不可见的。

## 若日后改主意要通这条链

断点在上游执行器，**不在 self-model**（那里的画像已恢复，2026-10-08 探出了
`integration` 域）。需要同时满足：

1. 补一个能驱动 `curriculum_next` -> 完成任务 -> `curriculum_submit` 的执行器，
   或建立人工流程；
2. ~~`agint_curriculum.attempts` 表出现非 0 行~~ —— **已满足**（2026-10-09 带外提交，
   attempts=1）。但它**不能**当作通电证据：带外提交不发事件，只证明判定逻辑能跑。
3. 出现 `result=fail` 的判定，才会有 adversarial 信号（只转发 fail）。

届时应同步修订 `docs/wiring-exemptions.json` 中
`input.signal.adversarial.curriculum-result` 那条的 `reason` 与 `unblockWhen`。

## 关联

- 需订正：`docs/wiring-exemptions.json`（`adversarial` 频道那条豁免的
  `reason` 与 `evidence`）
- 同一条 `adversarial` 断链的另一条腿：
  [diagnosis-completed-upstream-starved.md](./diagnosis-completed-upstream-starved.md)
- 同族：[event-bus-shadow-publish-gap.md](./event-bus-shadow-publish-gap.md)
  「未覆盖/待查」一节已列了「发了没人收」这一类
- 教条同源：**「有 10 处调用点」不等于「调用成功」；数调用点只证明有人喊，
  不证明有人应**
