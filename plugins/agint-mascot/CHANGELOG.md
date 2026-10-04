# Changelog

## 0.1.1 — 2026-10-04

首次真机运行后修的形状错误。25 条断言（v0.1.0 是 19 条）。

1. **`ctx.loader.entries()` 不是数组，是迭代器。** v0.1.0 用 `Array.isArray` 判形状，把一个完全健康的宿主读成 `warn`。既有调用方是展开的（`agint-family-panel/lib/index.js:188`）。加 `toArray()` 归一化，cron / metrics / plugins 三处共用。
2. **loader 条目的真实形状不是 `runtime.status`。** 真实在 `entry.fiber.state`，是**数字**（FiberState）；id 在 `entry.options.id`。v0.1.0 猜的 `r?.runtime?.status === 'failed'` 两处都错：路径错，类型也错。枚举值 PENDING=0 / LOADING=1 / ACTIVE=2 / FAILED=3 / DISPOSED=4 / UNLOADING=5，抄自 `agint-family-panel/lib/index.js:160-167`。
3. 新增 6 条断言锁住上面两点，外加「字符串不能当集合」「没有数字 fiber.state 的条目不能静默算失败」。

### 首次真机结果（重启后 `mascot_status` 实测）

```
tone=warn percent=92 enabled=true
[ok] cron — 25 个任务
[ok] metrics — 19 项指标
[ok] selfModel — 3 项
[warn] plugins — 返回形状不是条目列表
lastPush=ok pollMs=30000
```

`lastPush=ok` 是第一件要确认的事：`ctx.get('pet', false)` 拿得到 pet 服务，`pet.announce()` 返回 `{ ok: true }`，借用的 `kind: 'plan'` 被上游接受。`plugins` 那条 warn 就是上面第 1 条的 bug，本版已修，待下次重启生效。

## 0.1.0 — 2026-10-04

首个版本。

- 四源探测：`agint.cron.list()`、`agint.metrics.summary()`、`agint.selfModel.stats()`、`loader.entries()`。
- 聚合判定落在 `lib/health.js`，纯函数无 I/O，可单测。
- 经 `ctx.pet.announce()` 推进 dsh-pet 气泡，`kind` 借用 `plan`，见 `lib/announce.js` 顶部说明。
- 读工具 `mascot_status`。
- 19 条冒烟断言，含一条全状态空间负向断言：任何含非 ok 源的输入都不得读出 `tone: ok`。

### 已知取舍

1. `pet.announce` 的 `kind` 是封闭枚举（`balance | cost | plan`），没有 status 类。本版借 `plan` 用 `percent` 承载健康百分比。语义上是借用，不是原意。上游若加 status kind，改 `lib/announce.js` 的 `KIND` 一处即可。
2. `pet` 服务不在 `optionalInject` 列表里，因为它是第三方服务名，宿主注入校验可能不接受。代码用 `ctx.get('pet', false)` 晚绑。
3. 本插件不新增存储域、不写文件。判定只在内存里，气泡 TTL 到期即消失。
