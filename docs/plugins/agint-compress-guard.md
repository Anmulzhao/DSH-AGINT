# agint-compress-guard — 记忆压缩检查点机制（P3-1）

> 设计稿：wiki《设计-P3-1-记忆压缩检查点机制.md》v0.3。本文是插件规格摘要；
> 实施细节与哲学对齐自查见插件 README。

## 定位

P7.5 编号 P3-1，记忆的「安全压缩层」。M4 验收口径（v0.2 精确化）：
**有压缩发生时**，100% 有可恢复检查点（raw 或 shadowedSeqs），且 raw 写失败时压缩被中止。
不含「洞察产出量」——那取决于真实流量，不要把流量问题伪装成功能问题。

## 接线梯子（v0.3：A 档移出，B 档主战场，C 档兜底）

| 压缩发生处 | 档位 | 处置 |
| --- | --- | --- |
| 宿主级会话压缩（自动 + /compact） | **B**：`session/event` 过滤 `compaction/*` | 事后精确补偿（无否决权，但可见可挂） |
| P1-1 memory 域压缩路径 | **Q6 单一入口**：apiVersion=2 的 `onPreCompress` | 注册进 P1-1 registry，shadow 期不自动激活 |
| 梦境 / 周复盘摘要链条 | **C**：显式 `checkpoint()` | Sprint 21 cron hook 接入 |

A 档（继承 `BasicCompactionEngine`）已移出设计——Hermes 反例证明「拿到压缩前位置」
不是必需；重启条件预注册：仅当 B 档被证实「事后补偿不够」时单独立项。

## 否决权缺口（诚实边界）

宿主压缩**一定会发生**，本插件不假装拦得住（`CompactionEngine` 三方法无 veto 语义）。
保证的是：**发生过的东西可被恢复**。详见 `docs/known-limitations/compaction-veto-gap.md`。

## 数据流

```
session/event (compaction/summary)
  └→ checkpoint({ kind:'host-compaction', id: compactionId,
                 shadowedSeqs, shadowedTokenCount, summary })
       ├→ [1] raw 凭据 = shadowedSeqs（会话文件 append-only，原文可按 seq 回溯）
       ├→ [2] 规则提取 ≤20 条 → insights 表（checkpointRef 关联）
       └→ guard_log 一行 + compress-guard.checkpointed 事件

provider.onPreCompress (P1-1 压缩路径, apiVersion=2)
  └→ checkpoint({ kind:'p1-checkpoint', runRawSnapshot:false })
       └→ insights 落库（linkPending）→ P1-1 事件回填 checkpointId（最小 PR 后）
```

## 存储

`agint_compress_guard`（schemaVersion 1）：insights / guard_log / counters / config。
raw 唯一事实源 = P1-1 `pre_compress_checkpoints`（双 id 空间：`pcc_*` / `compactionId`）。

## 验收对照（设计稿 §八）

| 标准 | 状态 |
| --- | --- |
| 单测 ≥16 | ✅ 63 用例全过 |
| 降级可恢复（不变量 8） | ✅ 单测注入「失败 → 冷却 → 探针 → 复位」 |
| 零数据必须响（不变量 6） | ✅ `NO_SOURCE_REACHED` 显式状态 |
| 订阅事件有效性（不变量 7） | ✅ smoke 静态核实（P1-1 manager + 宿主 known-event-types） |
| raw 先于洞察（不变量 1） | ✅ validate 强校验 |
| fail-open（不变量 3） | ✅ 注错单测 |
| 兜底不回写（§6.2） | ✅ 单测断言 memory.write 零调用 |
| 接线档位显式登记 | ✅ `stats().tiers` |
| shadow 档转正 | ⏳ 挂载后观察一周（§11.2 判据预注册） |
| B 档覆盖率 | ⏳ 标定期零压缩流量，`hostCompactionsSeen` 起算后核对 |

## 挂载

仓库发版 + host 同步（`_sync_plugin.mjs` 三段式守门）后，`cordis.patch.yml` 加：

```yaml
  - insert:
      - id: agint-compress-guard
        name: ./plugins/agint-compress-guard/lib/index.js
        config: {}
```

preset 工具 row：`agint-compress-guard-tools`（compress_recall / compress_guard_stats，
均只读）。**挂载与重启由老板走 safe-update 流程**（本设计含新故障模式——压缩中止，
故首周 shadow 档观察，不主动催转正）。
