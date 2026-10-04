# agint-mascot

AGINT 桌宠状态源。读四个 AGINT 信号源，聚合成一条健康判定，推进 dsh-pet 的气泡。

- 版本：v0.1.0（2026-10-04）
- 形态：宿主半（node 平面，单实例）
- 许可：MIT

## 是什么

桌宠本身由第三方插件 [`dsh-pet`](https://github.com/zhu1090093659/dsh-pet) 提供，本插件不做任何渲染。它只做一件事：**把 AGINT 的系统状态翻译成桌宠能显示的一句话**。

桌宠的七个相位（idle / waiting / thinking / tool / review / done / failed）是**会话级**的，回答「AI 在干什么」。本插件补的是另一层：**系统健不健康**。两者不互相替代。

## 三块的分法

| 块 | 位置 | 许可 |
|---|---|---|
| 宠物插件本体 | `Anmulzhao/agint-pet` fork | Apache-2.0 |
| 状态源（本插件） | `DSH-AGINT/plugins/agint-mascot` | MIT |
| AGINT 宠物资产 | `$DSH_HOME/pets/agint/` | MIT 或 CC0 |

AGINT 代码不进 fork。fork 保持成上游的近亲，重基成本才低。

## 核心纪律

**读不到的状态源永远不算健康。**

三种降级，各有各的扣分和语调：

| 情况 | 记为 | 扣分 | 后果 |
|---|---|---|---|
| 服务不在 context 上（未挂载） | `absent` | 15 | 至少 `warn` |
| 调用抛异常 | `error` | 30 | 强制 `low`，不可被平均掉 |
| 返回形状不对 / 数据为空 | `warn` | 8 | 至少 `warn` |
| 正常读到 | `ok` | 0 | — |

关键一条：**只要有一个源 `error`，tone 直接压到 `low`，不管其他源多健康。** 采集探针抛异常是真实故障，不是可以平均掉的噪声。

这条不是写在注释里的承诺，是测试里断言的性质：`test/smoke.mjs` 遍历 `ok|warn|absent|error` 四态的 4×4×4×4 全部 256 种组合，断言任何含非 `ok` 源的组合都读不出 `tone: 'ok'`。改动 `lib/health.js` 的评分逻辑而违反它，测试会红。

## 借用的 kind（重要）

`pet.announce` 的载荷经过上游封闭校验，`kind` 只接受三个值：

```ts
kind: 'balance' | 'cost' | 'plan'   // agint-pet/src/announce.ts:17
```

没有 status、health 或 error。传别的值直接被丢，`announce()` 返回 `{ ok: false }`，没有任何诊断。

本版借 `plan`：

1. `plan` 是唯一要求 `percent` 的 kind（announce.ts:81），健康百分比正好是这个。
2. `plan` 是唯一承载「等级」而不是「金额」的 kind。
3. `balance` 和 `cost` 都强制要求 `amount`（announce.ts:80），读起来像钱。

`tone` 则是天然匹配：`ok` / `warn` / `low` 直接对应 健康 / 部分未读到 / 故障。

**这是借用，不是原意。** 上游若加 status kind，改 `lib/announce.js` 的 `KIND` 常量一处即可，其余不动。

TTL 传的是轮询间隔。这是上游文档写明的用法（announce.ts:39-45）：常驻公告把自己的轮询周期声明成 TTL，气泡在两次轮询之间不会断。

## 稳健性

1. **没有任何服务是必需的。** `inject` 是空数组。插件存在的意义就是报告谁没挂载，所以它不能因为缺一个源就起不来。
2. **服务全部晚绑。** 用 `ctx.get(key, false)` 在每次轮询时取，不用 inject 等待。任何晚挂载的服务，下一个周期自动接上，不用重启。
3. **每个探针独立守卫。** 一个源抛异常不影响另外三个。
4. **返回形状不对记 `warn` 而不是 `ok`。** 回错类型的服务不是答对了的服务。
5. **不写任何东西。** 无存储域、无文件、无网络、无 DOM。气泡在上游侧是内存态，带 TTL，到期消失。
6. **定时器 unref。** 桌宠不构成宿主关不掉的理由。

## 配置

```yaml
# cordis.patch.yml
- insert:
    - id: agint-mascot
      name: ./plugins/agint-mascot/lib/index.js
      config:
        enabled: true      # 默认 true
        pollMs: 30000      # 默认 30000，范围 5000..600000
```

## 工具

`mascot_status`（只读）。重新跑一次同样的探针并返回同一个判定对象，所以它说的话和桌宠显示的不会漂移。

```
mascot_status: tone=warn percent=85 enabled=true
  AGINT 部分未读到：plugins（3/4 源已读）
  [ok] cron — 12 个任务
  [ok] metrics — 24 项指标
  [ok] selfModel — 6 项
  [absent] plugins — loader 未挂载
  lastPush=no-pet pollMs=30000
```

## 服务

`agint.mascot`：

| 成员 | 说明 |
|---|---|
| `status()` | 上一次判定，周期未完成时为 `null` |
| `refresh()` | 立即跑一轮并返回判定，不等下一个 tick |
| `pollMs()` | 轮询间隔，同时是公告 TTL |
| `lastPush()` | 上一次推进结果：`ok` / `rejected` / `no-pet` / `disabled` / `collect-failed: ...` |
| `setEnabled(next)` / `isEnabled()` | 开关 |

`no-pet` 是正常状态，不是故障。桌宠插件没挂载时它不降低判定。

## 挂载后要做的事

改 `cordis.patch.yml` **要重启 DSH 才生效**。本插件不自行重启，会中断正在进行的会话。重启由人做。

## 测试

```sh
node test/smoke.mjs
```

19 条断言，纯 node 无框架。

## 文档

- 形象规范：`DSH-AGINT/docs/brand/agint-character-spec.md`
- 桌宠总方案：`Anmulzhao/agint-pet` 的 `docs/AGINT/桌宠方案.md`
- 上游契约：`agint-pet/contracts/pet-manifest-v2.schema.json`、`agint-pet/src/announce.ts`
