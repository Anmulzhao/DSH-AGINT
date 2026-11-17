# Known Limitation: 压缩否决权缺口（compaction veto gap）

> P3-1 设计稿 Q5 / §5.3 落档（R9）。替代 v0.1 草案的 `pre-compact-hook-gap.md`
> ——那份文档的标题本身就是错的（见下）。
> 建档：2026-09-13（v0.1.0 实施日）。宿主版本基线：`@deepseek-ai/dsh` 0.1.5-rc.1
> （`dsh-compaction-basic` 随主包）。

> ### ⚠️ 2026-11-06 复核：宿主压缩照常发生；B 档补偿**每次都跑，但每次都提不出洞察**
>
> | 判据 | 2026-11-06 实读 |
> |---|---|
> | `agint_compress_guard.guard_log` | **11 条**，全部 `tier: "B"` / `status: "PASSED"` |
> | 其中 `insightsExtracted` | **11 条全是 0** —— 无一例外 |
> | `note` 字段 | 一律「无可提取文本（0 条洞察，raw 兜底）」 |
> | `rawBytes` | 72,021 / 76,723 / 105,051 … ⇒ **原始内容是有的** |
> | `counters.hostCompactionsSeen` | **10** |
> | `counters.extractFailures` | **0** —— 提取器**没有报错** |
> | `counters.recallHits` / `recallMisses` | **0 / 74** |
> | `counters.p1CheckpointsSeen` | **0** |
> | `agint_compress_guard.insights` 表 | **0 条** |
> | 总线 `compress-guard.checkpointed` | **10 条** |
>
> ⇒ **缺口本身没变**：宿主压缩照样发生、AGINT 侧照样拦不住。
> 但**补偿这一层的实效被量化出来了**：**11 次补偿、0 条洞察。**
>
> ⭐ **这构成一个此前没写下来的事实**：本文说「我们能保证的是『发生过的东西可被恢复』
> （M4 的实际口径）」—— **raw 兜底确实成立**（每次都记下了 72 KB–105 KB 的原文，
> 可检索），**但「B 档事后精确补偿」里的「精确补偿」这四个字目前是空的**：
> 补偿动作在跑，补偿出来的洞察是 0。
>
> ⚠️ **不要误读 `extractFailures = 0`**：它说明**不是提取器报错**，
> 而是提取器**成功运行并判定「无可提取文本」**。这两种情况在
> `insightsExtracted = 0` 面前长得一样，但含义完全不同 ——
> 前者要修提取器，后者要问「什么才算可提取的文本」。
> **本次未能分开**（没有埋点能区分这两种 0）。
>
> ⚠️ **仍未覆盖**：本文 §未覆盖清单第 1 条（宿主压缩发生与 B 档消费之间进程崩溃）
> 依然成立；且 `p1CheckpointsSeen = 0` 说明 **P1-1 raw 检查点这条路一次都没走过**。

## 缺口是什么（一句话）

**宿主级压缩没有否决钩子：dsh 的会话压缩一定会发生，AGINT 侧无法在压缩发生前
拦下它。** 我们能保证的是「发生过的东西可被恢复」（M4 的实际口径），不是「不压缩」。

## 为什么不叫「覆盖缺口」

v0.1 设计稿曾把它写成「宿主 ❌ 不覆盖（无 pre-compact 钩子）→ 承认并绕行」——
**这个判断反了**。实测（2026-09-12 v0.2 取证 + 2026-09-13 实施复核）：

| 能力 | 是否存在 | 证据 |
| --- | --- | --- |
| 压缩前否决（veto） | ❌ 不存在 | `CompactionEngine` 抽象类三方法（compactIfNeeded/compactNow/compactRegion）均无拦截语义 |
| 压缩可见性 | ✅ 存在 | `compaction/start\|summary\|end\|prune` 四个 `SessionEvent`（dsh-session `known-event-types.js`） |
| 压缩挂钩权 | ✅ 存在 | `session/event` post-commit feed（`dsh-compaction-basic` 自身即用 `ctx.on("session/event", ...)`） |
| 精确丢失清单 | ✅ 存在 | `compaction/summary` 载荷携带 `compactionId` / `shadowedSeqs` / `shadowedTokenCount` |
| 压缩前位置 | ✅ 存在但不用 | `ctx.compaction` seam + `BasicCompactionEngine.summarize()` 子类钩子（A 档，已移出设计） |

「拦不住」≠「看不到」。把前者误推成后者，会放弃唯一能达成 M4 的接线点
——这是 v0.1 的最大错误，v0.2 起以三档梯子（v0.3 收为两档）纠正。

## 当前缓解

1. **B 档事后精确补偿**（agint-compress-guard 已实现）：消费 `shadowedSeqs`，
   洞察 + raw 回溯双保险；
2. **原文可检索**（R10 探针 + session-reader）：dsh 会话文件 append-only，
   被压缩（surface 替换）的消息物理上仍在文件中，可按 seq 读回；
3. **P1-1 raw 检查点**：memory 域压缩路径的快照兜底。

## 未覆盖的场景（诚实清单）

- 宿主压缩发生与 B 档事件消费之间，若进程崩溃，该次压缩的洞察提取会丢失
  ——但原文仍在会话文件中（append-only），不算上下文丢失；
- 外部 provider（apiVersion≥2）的压缩语义适配在 Sprint 21（T9）；
- 宿主若未来引入 veto 型钩子，本设计不预设；届时再评估是否收紧。
