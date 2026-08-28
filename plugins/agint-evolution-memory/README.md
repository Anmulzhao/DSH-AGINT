# agint-evolution-memory

> 物理隔离的进化记忆存储域。Sprint 10 v0.6.4 #7 加 EvolutionLogBuffer 异步批量写入。

## 是什么

3 表 + Sprint 10 v0.6.4 #7 加 buffer 层：
- `evolution_log` — D-QAF Phase 4 自动写入
- `failure_pattern` — REJECT 决策触发 + 周复盘归纳
- `success_template` — 周复盘蒸馏
- `EvolutionLogBuffer`（v0.6.4 #7 新增）— logPhase4Buffered / readLogRangeMerged / flushLogBufferNow

## Service 契约（FROZEN）

```js
agint.evolution = {
  logPhase4,                    // 同步路径（保留向后兼容）
  logPhase4Buffered,            // v0.6.4 #7 异步批量
  readLogRangeMerged,           // v0.6.4 #8 读时合并（buffer + storage）
  flushLogBufferNow,            // v0.6.4 #7 立即强制 flush
  addFailure, addSuccess, queryFailures, queryTemplates, getLogRange,
  decayScanRun, stats, limits,
};
```

## Sprint 10 v0.6.4 #7 设计

EvolutionLogBuffer（`lib/log-buffer.js`，117 行）：
- **flush 策略**：计数 ≥10 或时间 ≥5s 触发同步落盘
- **退出钩子**：`ctx.effect()` disposer 在 plugin dispose 时强制 flush（不挂 `process.on`，避免测试死锁）
- **失败兜底**：flush 失败 → 写 `agint.memory` 一条 `buffer-lost:<count>`，不丢元数据
- **读时合并视图**（#8）：buffer + storage 合并去重，不污染 storage
- **并发控制**：Promise 队列锁，避免重入

## 验证

```sh
node --test plugins/agint-evolution-memory/test/log-buffer.test.mjs
bin/plugin-check.sh plugins/agint-evolution-memory
```

## L0-frozen 保护

- 不引用 quality-contract FROZEN 接口
- 不修改 evolution-memory 已有 5 个 Service 签名（logPhase4 / addFailure / addSuccess / queryFailures / queryTemplates）
- 不引入新的中心化服务

## 相关

- `AGINT.wiki/Sprint10-设计稿.md` §二.5 EvolutionLogBuffer
- `AGINT.wiki/ROADMAP.md — AGINT 进化路线（优化版：架构解耦与真正插件化）.md` §进化健康度护栏