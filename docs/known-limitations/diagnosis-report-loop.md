# 已知限制：`agint-diagnosis.report()` 自激/连续调用导致存储膨胀（2026-09-26）

> 状态：**环已掐断（数据已清、守门已加），但"谁在调"未拿到直接证据。**
> 本文记录现场取证、两次修复的边界，以及下一次复发时的一条命令定位法。

## 症状

- `agint-mutator` 控制台持续刷 `[agint-mutator.observe] diagnosis.completed reportId=... observationCount=<递增>`，
  每条约 106 ms（≈11 次/秒）。
- `agint_diagnosis.json` 里 `reports` 堆到 **12,615 条**，而 `LIMITS.REPORTS = 50`。
- `agint.json` 里 `memory` 同步多出 **12,605 条** `pattern` 记录
  （`Sprint 7 diagnosis report windowDays=7 annotations=0 top=...`）。
  两个数字**精确相加**（322 + 12,605 = 12,927），即**每次 `report()` 都写了一条 memory**。

## 时间线（本地时间，UTC+8）

| 时刻 | 事件 | 证据 |
|---|---|---|
| 11:32 | 上一轮清理落盘（reports→10，memory→322） | `_backup_storages_0926/*.bak-2026-09-26T03-32-*` |
| 11:39:28 | 宿主启动 | `.agint-restart/marker.json` `lastBootAt`；`agint_memory_provider.json` mtime 11:39:30 |
| 11:40:33 | **事件表最后一次写入**（之后 18 分钟零记账） | `agint_event_bus.json` mtime 11:40:33；最后一条 `evolution.evaluated@03:40:33.938Z` |
| 11:40:40 | `report()` 开始连续调用（首条 memory 记录 `generatedAt=03:40:40.376Z`） | `agint.json` memory 记录 |
| 11:58:10 | 最后一次写入；宿主随后被关闭 | 两文件 mtime |

## 取证结论（每条都有硬证据）

1. **不是 cap 判据写错。** 部署位与仓库 **415 个文件 0 差异**；`LIMITS.REPORTS = 50`；
   实测导入部署位模块：`{"ANNOTATIONS":200,"CLUSTERS":50,"REPORTS":50}`。
2. **不是 storage-domain 缺 `size`。** 全机仅两份 `dsh-storage-domain`（AppData 与
   `@agint/host/node_modules`），**同版本 0.1.7-rc.1、字节一致**，`KvTableImpl.get size()`
   存在且 `put()` 会 `this.records.set(key, value)`。
3. **cap 在真环境是好用的。** 用**真 `JsonStorageBackend` + 真 `DomainFacility` + 部署位那份
   `agint-diagnosis`** 复现：预置 10 条 → 写 40 条 → 第 41 次抛
   `reports table full (cap 50)`。脚本 `D:/DSH/_repro_cap_0926.mjs`。
4. **不是 self-model 的 A6 再入边。** 全部 12,615 条报告 `windowDays` **都是 7**
   （= `aggregateCapabilityEvidence` 的 `fromDiagnosisEvent=false` 分支）；
   且 `agint_self_model.json` 自 11:12:59 起**没再写过**（若走 A6，`recomputeCapabilities`
   会写 `capability_map`）。
5. **不是事件总线记账。** 事件表全历史只有 **6 条** `diagnosis.completed`，本次窗口 **0 条** ——
   `bus.js` 的 `events.put` 在 `await deliverAsync(...)` **之后**，分发链不返回就走不到记账。
6. **不是诊断文案里的 4 个 reportId 落盘失败。** 那 4 个 id 全部在 reports 表里 ——
   写入成功，即 cap 检查当时"放行"了。
7. **不是 mutator。** `STRATEGY_REWRITE` 只 `_checkDep` 校验 `diagnosis.report` 是函数，**不调用**。
8. **不是工具调用。** 会话记录里没有 `diagnosis_report` 调用痕迹（唯一命中是 9-3 的文档片段）。
9. **不是变异/影子脚本。** `_mutation_test_0926.mjs` 会就地改写部署位文件再还原，
   但部署位 `agint-diagnosis/lib/index.js` mtime 停在 **10:21:25**（同步那一刻），
   说明 10:21 之后没被改过；`_realdata_cap_shadow_0926.mjs` 是只读影子。

## 最可能的根因（未直接取证）

**11:40–11:58 那个进程跑的很可能不是磁盘上那版代码。**
理由：`publish` 是 `await deliverAsync(...)`（**串行 await handler**），
所以在**已加载熔断版**的前提下，一条 `report()` 不可能再引出下一条 ——
而现场是 12,605 条串行产出。这只有两种解释：

- (a) 运行的进程是 10:21 之前启动的（旧代码），`marker.lastBootAt=11:39:28` 是**假启动记录** ——
  与 K47.7「验收脚本会骗人 / 永远用 netstat+tasklist 交叉验证真实 pid」同源；
- (b) 存在第二个未被我发现的 dsh 进程。

⚠️ 因此**"已部署修复"≠"跑的修复"**。`agint-restart` 的 `codeFingerprint` 只对本插件
自己的 `lib/*.js` 取哈希，**不能**用来判定其它插件跑的是哪版 —— 这次想用它验证时才发现。

## 已落地的两道守门（2026-09-26 二修）

- **频率熔断（主）**：`report()` 入口 60s 滑动窗口，超 `RATE_MAX`（默认 30，低于 cap 50）
  **抛错**；首次触发 `console.warn` + **调用方栈前 8 帧**。
- **在途计数（辅）**：cap 判据并入 `_reportsInFlight`，`tr.put` 处二次校验，
  闭合「读 `size` → 写磁盘」之间的并发窗口。
- 可观测：`stats().reportRateGuard`。

## 复发时的一条命令定位法

如果 `[agint-diagnosis] agint.diagnosis.report 频率熔断 ... 调用方栈：` 出现在控制台，
**栈里第 2~4 帧就是驱动方**（`agint-curriculum` 的挑战判定？某个 preset 工具？外部脚本？）。
拿到那一帧再回来堵边，而不是继续猜。

## 教训

- **同一个"表满守门失效"症状，可能有两个完全不同的成因**：写法错（一修）与执行体不是新版（二修前提）。
  "部署了"与"跑的是它"必须分开验证。
- **堵再入边之前先确认驱动来源**：这次是 `windowDays` 字段（7 vs 28）把范围钉死的 ——
  一个字段值域比十行推理更有效。
- **可观测优先**：与其继续猜调用方，不如让代码在下一次自己把调用栈吐出来。
