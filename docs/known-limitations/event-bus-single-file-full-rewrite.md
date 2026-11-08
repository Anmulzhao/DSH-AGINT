# 已知限制：事件总线是「单文件全量重写」，写放大约 23 GB/天，且 93% 是观测噪声

> 建档：2026-11-06。适用版本：agint-event-bus 0.9.0 /
> `@deepseek-ai/dsh-storage-json`（single-unit 布局）。
> 相关：[`event-bus-shadow-publish-gap.md`](./event-bus-shadow-publish-gap.md)、
> [`skills-root-rename-eperm.md`](./skills-root-rename-eperm.md) §6。

## 一句话

**总线的持久化表 `events` 是 single-unit 布局：每写一条事件，就把整个
27 MB 文件重新序列化并重写一遍。当前速率下这等于每天往磁盘写约 23 GB，
而这 23 GB 里 93.1% 是 `agint-ov-strategy` 的观测事件 —— 真正与进化有关的
信号只占 6.9%。**

这不是 bug，是 `atomic: "json"` 布局 + 「只增不删」的事件表的必然结果。
它同时解释了同族的两件事：为什么总线文件比同期任何单个存储域都大一个量级，
以及为什么磁盘上会周期性出现写了一半的孤儿 `.tmp`。

## 一、事实（源码级 + 生产实测，2026-11-06 23:08 快照）

### 1.1 布局与写路径

`plugins/agint-event-bus/manifest.json` → `"storage": { "atomic": "json" }`
⇒ 走 `dsh-storage-json` 的 **single-unit** 布局（整域一个文件）。

`dsh-storage-json/lib/index.js`：

```js
// 单文件单元的 putRecord：改内存 → 整份序列化 → 整份写回
async putRecord(table, key, value) {
    ...
    records.set(key, value);
    await this.publish();          // ← 每次 put 一次，无合并、无去抖
}
async publish() {
    const write = writeAtomic(this.path, serialize(this.descriptor.name, this.state));
    ...
}
```

`dsh-storage-domain` 的 `KvTableImpl.put` → `host.enqueue(...)` → `unit.putRecord(...)`。
写链是**串行**的（`this.chain = result.then(...)`），但**不合并**：
N 条事件 = N 次整文件重写。

事件写入点：`plugins/agint-event-bus/lib/bus.js:133`
`await ctx.tables.events.put(envelope.id, {...})`。

### 1.2 体积严格线性 ⇒ 无轮转、无上限

四个独立采样点，每事件字节数几乎不变：

| 采样时刻 | 事件数 | 文件字节 | 字节/事件 |
| --- | --- | --- | --- |
| 2026-10-26 22:34 | 17,651 | 16,384,210 | 928.1 |
| 2026-10-26 23:23 | 18,828 | 17,478,512 | 928.2 |
| 2026-10-29 12:22 | 25,187 | 23,483,114 | 932.3 |
| 2026-11-06 23:08 | **29,185** | **27,432,800** | **940.0** |

⇒ **每条事件净增约 930 字节，文件里没有轮转、驱逐或压缩**（死信表 0 条，
`events` 表自 2026-09-29 起单调增长）。

⚠️ 容易混淆的一点：`agint-event-bus/lib/observability.js` 里确实有
`capacity = 2000` 的**内存环形缓冲**，但那是给 `inspect` 用的观测窗口，
**与持久化表无关**。持久化 `events` 表无 cap。

## 二、写放大推算

### 2.1 推算过程

「1 次 put = 1 次整文件重写」是源码级确认的事实（见 §1.1）。据此：

**写盘量 = 区间内新增事件数 × 区间内平均文件体积**

| 区间 | 新增事件 | 平均文件体积 | 写盘量 |
| --- | --- | --- | --- |
| 10-26 22:34 → 10-26 23:23 | 1,177 | ~16.9 MB | ~19.9 GB |
| 10-26 23:23 → 10-29 12:22 | 6,359 | ~20.5 MB | ~130.2 GB |
| 10-29 12:22 → 11-06 23:08 | 3,998 | ~25.5 MB | ~101.8 GB |
| **合计（11 天）** | **11,534** | — | **≈ 252 GB** |

**≈ 22.9 GB/天，只为了一条事件总线。**

⚠️ **这是算术推算，不是 I/O 实测**。本机宿主进程在取数时已退出
（`/proc/<pid>/io` 不可读），无法给出 `write_bytes` 直接证据。
验法：宿主运行时读 `/proc/<pid>/io` 的 `write_bytes`，与本表推算量对比。

### 2.2 二次增长（这才是真正要命的部分）

写盘量 ∝ 事件数 × 文件体积，而文件体积 ∝ 累计事件数 ⇒ **写盘量随时间二次增长**。

| 时点 | 事件数 | 文件体积 | 按当前速率的日写盘量 |
| --- | --- | --- | --- |
| 今天（11-06） | 29,185 | 27.4 MB | ~20 GB/天 |
| +30 天（按 748 事件/天均速） | ~51,600 | ~48 MB | ~39 GB/天 |
| +30 天（按 1,500 事件/天忙时） | ~74,000 | ~69 MB | ~104 GB/天 |

里程碑：按 748 事件/天均速，**约 103 天后文件到 100 MB**；按忙时速率则只要 ~51 天。

## 三、93.1% 是 OV 观测噪声 —— 信噪比问题

| 主题族 | 条数 | 占比 | 来源 |
| --- | --- | --- | --- |
| `ov.session.flushed` | 21,960 | 75.2% | `agint-ov-strategy`，每次 `runtime.flush` 调一次 |
| `ov.recall.checked` | 4,923 | 16.9% | 同上，每次 `runtime.recallMessage` 调一次 |
| `ov.profile.delivered` | 202 | 0.7% | 同上，每会话至多一次 |
| `ov.tool.called` | 89 | 0.3% | 同上 |
| `ov.strategy.remembered` | 7 | 0.0% | 同上 |
| **ov.* 小计** | **27,181** | **93.1%** | |
| 其余全部主题 | 2,004 | 6.9% | 进化 / 记忆 / 规则 / 质量 / 调度 … |

⚠️ 主题名有误导性：`ov.session.flushed` 名字像「每会话一次」，实际是
**每次 flush 调用一条**（`agint-ov-strategy/lib/index.js:252` 的
`wrapState.flush = wrapMethod(rt, 'flush', ...)`）。这是它占 75% 的原因。

⇒ 后果：**总线的信噪比 93:7。** 想回答「进化链路今天跑了什么」，
要在 29,185 条里翻 2,004 条。而 `check-wiring` 的生产数据对账
（查 C）正是数总线行数 —— 噪声主题越多，越容易把「有数据」误读成「链路通电」。

`agint-ov-strategy` 有现成的 kill-switch：`config enabled:false`
或环境变量 `AGINT_OV_STRATEGY=off`（`lib/index.js:31`），
外加 `cfg.observe` 可单独关观测。**本条不主张关它** —— 关掉会让
`ov.*` 的真实使用率无从得知；主张的是「总量应当有上界」，而不是「无限增长且无刻度」。

## 四、与孤儿 `.tmp` 的同源关系

`dsh-storage-json` 的 `writeAtomic`：

```js
const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
try {
    ...写 tmp → fsync → rename(tmp, path)
} catch (error) {
    await rm(tmp, { force: true });   // ← 清理只在 catch 里
    throw error;
}
```

进程被 **SIGKILL** 时不抛错 ⇒ `catch` 不执行 ⇒ tmp 留在盘上。
**单次写窗口越长，被杀时残留的 tmp 越大。** 总线文件 27 MB 的一次全量
重写，远比 245 KB 的 `agint_memory_provider` 更容易撞上这个窗口。

2026-11-06 实测（详见 [`skills-root-rename-eperm.md`](./skills-root-rename-eperm.md)
的复核块）：3 个孤儿 `.tmp` 里有 1 个正是 239,936 字节的
`agint_memory_provider` 半截文件。

⇒ 这条限制与那条限制**是同一个机制的两种暴露**：
单文件全量重写既制造了写放大，也拉长了被杀时的残留窗口。

## 五、判据（怎么确认这条还成立）

```bash
# 1) 体积与每事件字节数（预期：单调增长、≈930 B/事件、无上界）
python3 -c "
import json, os, glob
for p in sorted(glob.glob(os.environ['DSH_HOME'] + '/storages/agint_event_bus.json*')):
    try:
        d = json.load(open(p)); n = len(d['tables']['events'])
        print(f'{os.path.getsize(p):>12} B  {n:>7} 事件  {os.path.getsize(p)/n:.0f} B/事件  {p}')
    except Exception as e: print('跳过', p, e)
"

# 2) 主题构成（预期：ov.* 占比 > 90%）
python3 -c "
import json, collections
d = json.load(open('\$DSH_HOME/storages/agint_event_bus.json'))
c = collections.Counter(v.get('topic') for v in d['tables']['events'].values())
tot = sum(c.values()); ov = sum(n for t,n in c.items() if (t or '').startswith('ov.'))
print(f'总 {tot} | ov.* {ov} ({ov/tot*100:.1f}%) | 非 ov {tot-ov}')
"

# 3) 宿主运行时的实际写盘量（把推算换成实测）
grep write_bytes /proc/<dsh-pid>/io
```

## 六、还没做、也不该现在做的事

- **不主张现在就给 `events` 表加 cap。** 加 cap 会**丢事件**，而
  `event-bus-shadow-publish-gap.md` 整篇都在讲「发了没人收 / 数据被回滚」——
  再丢一层历史会雪上加霜。
- **不主张改 `atomic: "json"` → per-record 布局。** 那是宿主 `dsh-storage-json`
  的能力边界，且 per-record 会把 29,185 个小文件塞进同一个目录。
- **主张的是**：先把「总量无上界」这件事**记下来并量化**（本条），
  再由老板决定取舍。可选项大致是：① 观测主题降采样 / 分级；
  ② `events` 表加**保留期**（丢弃 N 天前事件，而不是丢弃前 N 条）；
  ③ 总线域换布局；④ 接受现状并按季度体检。

⚠️ 无论选哪个，**都要先回答「这些事件丢失后，谁会察觉」** ——
这是本文档族反复撞到的同一个坑：有 10 处调用点 ≠ 有产出。

## 关联

- 同族：[`event-bus-shadow-publish-gap.md`](./event-bus-shadow-publish-gap.md)
  （本文档的「接线」部分）
- 同机制：[`skills-root-rename-eperm.md`](./skills-root-rename-eperm.md) §6
  （`writeAtomic` 的 catch-only 清理 ⇒ 孤儿 tmp）
- 同事故形态：[`diagnosis-report-loop.md`](./diagnosis-report-loop.md)
  （`agint.json` 曾被自激环撑到 50 MB —— 同一个「单文件全量重写」放大器）

