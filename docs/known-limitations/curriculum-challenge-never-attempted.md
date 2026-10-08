# 已知限制：`curriculum.challenge-verdicted` 从未执行 —— 出队不自动执行

> 状态：**断链已定性；`docs/wiring-exemptions.json` 里既有的根因描述已过时，需一并订正**
> （见文末「对既有档案的订正」）。
> 观测日期：2026-10-09。
> 相关：[diagnosis-completed-upstream-starved.md](./diagnosis-completed-upstream-starved.md)。

## 症状

- 总线 `curriculum.challenge-verdicted` **全历史 0 条**。
- 下游 `agint-input-gateway` 的 `adversarial` 频道订阅了它
  （`plugins/agint-input-gateway/lib/channels/adversarial.js:74-77`，三个主题并列），
  但从未收到过该主题的任何一个事件。
- `agint_curriculum` 域 `attempts` 表恒 **0 行**。

## 结论

**发布方存在，且接线正确** —— `plugins/agint-curriculum/lib/index.js:369`
在 `submit()` 判定路径末尾发布本主题。

**它从未在生产执行过一次，因为断在它前面一环：挑战「出队」之后没有任何执行器。**

## 断点在哪：cron 自己的 description 就写明了

`plugins/agint-cron/lib/jobs.js:399` 的 `curriculum-weekly`，
description 原文：

> `边界探测 -> 对待练域逐一生成挑战（出队不自动执行）（weekly）`

完整链条：

1. **cron `curriculum-weekly`**（Thu 09:30）触发
   → `curriculum.probe()`
   → 读 self-model snapshot，`probeDomains()` 选域
   → **发布 `curriculum.boundary-probed`** ✅ 已发生 3 次
2. `curriculum.generate()`
   → **写 `challenges` 表**，`status=open`、`attemptCount=0` ✅ 已发生
3. **【出队不自动执行 —— 断在这里】**
4. （需要 agent 显式驱动）`curriculum_next` 工具
5. （agent 实际完成任务）
6. `curriculum_submit` 工具
   → 写 `attempts` 表 + **发布 `curriculum.challenge-verdicted`** ❌ 从未发生

**全库搜 `curriculum.submit`，唯一调用方是 `curriculum_submit` 工具**
（`plugins/agint-curriculum/lib/tools.js:72`）。
**没有任何 cron、没有任何自动执行器。**

## 取证（2026-10-09 实读生产存储）

| 观测项 | 结果 |
| --- | --- |
| `agint_curriculum.challenges` | **1** |
| `agint_curriculum.attempts` | **0** |
| `agint_curriculum.difficulty_state` | 1 |
| `agint_curriculum.audit_log` | 1 |
| 总线 `curriculum.boundary-probed` | **3** |
| 总线 `curriculum.challenge-verdicted` | **0** |

那个 challenge 是真的，且生成于最近一次 cron：

```
id=clg_20261008_064839   domain=integration   level=D1
status=open   attemptCount=0
createdAt=2026-10-08T01:30:45.518Z
audit_log: challenge_generated / reason="boundary-probe 驱动的挑战生成"
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

## 下游还叠了一层：只转发 fail

`plugins/agint-input-gateway/lib/channels/adversarial.js:130-131`：
`curriculum.challenge-verdicted` **只转发 `result=fail`**，pass 不转发。

⇒ 即使本主题通电，绝大多数判定结果也不会变成 adversarial 信号。
评估这条链是否值得通电时，这一层必须一起算进去。

## 复核命令（换机器时重跑）

```bash
# 1) curriculum 域四张表行数（attempts 应 > 0 才说明判定发生过）
python3 -c "import json;print({k:len(v) for k,v in json.load(open('\$DSH_HOME/storages/agint_curriculum.json'))['tables'].items()})"

# 2) 三个相关主题的总线条数
python3 -c "
import json, collections
d = json.load(open('\$DSH_HOME/storages/agint_event_bus.json'))
c = collections.Counter(v.get('topic') for v in d['tables']['events'].values())
for t in ['curriculum.boundary-probed','curriculum.challenge-created','curriculum.challenge-verdicted']:
    print(c.get(t,0), t)
"

# 3) 看探测选出了哪些域（上游是否恢复的直接证据）
python3 -c "
import json
d = json.load(open('\$DSH_HOME/storages/agint_event_bus.json'))
rows = [v for v in d['tables']['events'].values() if v.get('topic') == 'curriculum.boundary-probed']
rows.sort(key=lambda v: v.get('occurredAt') or '')
for v in rows:
    p = (v.get('envelope') or {}).get('payload') or {}
    print(v.get('occurredAt'), 'domains=', p.get('domains'), 'unverifiable=', p.get('unverifiable'))
"

# 4) 确认 submit 仍无自动调用方（除工具外）
rg -n "curriculum\.submit|\.submit\(" plugins/ --glob '!**/test/**' --glob '!**/node_modules/**'
```

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

## 若日后改主意要通这条链

断点在上游执行器，**不在 self-model**（那里的画像已恢复，2026-10-08 探出了
`integration` 域）。需要同时满足：

1. 补一个能驱动 `curriculum_next` -> 完成任务 -> `curriculum_submit` 的执行器，
   或建立人工流程；
2. `agint_curriculum.attempts` 表出现非 0 行；
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
