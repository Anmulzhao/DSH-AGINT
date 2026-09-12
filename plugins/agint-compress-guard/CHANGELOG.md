# CHANGELOG — agint-compress-guard

## v0.1.0（2026-09-13，Sprint 20 实施）

设计稿：`DSH-AGINT.wiki/设计-P3-1-记忆压缩检查点机制.md` v0.3（2026-09-12）。
P7.5 编号 P3-1；里程碑 M4（记忆压缩不丢失上下文，fail-closed）。

### 新增

- **插件骨架 + manifest**：独立域 `agint_compress_guard`（4 表，schemaVersion 1）；
  inject = storageDomain + agint.memory；event-bus / memory-provider 软依赖。
  manifest object 参数显式 `additionalProperties: true`（K19）。
- **编排状态机（§3.2，Q2 两段式）**：`checkpoint()` 永不 throw；检查点写入失败 →
  BLOCKED_CHECKPOINT（硬门），洞察提取失败/超时（3s 软超时）→ DEGRADED_INSIGHT（软降级）；
  guard_log 审计 + `compress-guard.blocked` / `compress-guard.checkpointed` 事件发布。
- **shadow 观察档（§七挂载策略）**：默认 `shadowMode=true`——BLOCKED 记录告警不真中止，
  观察一周误触发率后拍板转硬门（§11.2 判据预注册：BLOCKED 误触发 0 + DEGRADED < 20%）。
- **恢复探测（不变量 8，R16）**：连续写失败降级满 `recoveryProbeMs`（默认 300s，Hermes
  「跳闸 → 冷却 → 探针 → 复位」同构）放行探针级检查点，成功复位 fail-closed。单测注入验证。
- **B 档接线（§5.3 v0.3 唯一主战场）**：`ctx.on('session/event')` 过滤
  `compaction/start|summary|end|prune`，消费 `compactionId` / `shadowedSeqs` /
  `shadowedTokenCount` 做事后精确补偿；`end.error` 非空 → 等价 BLOCKED 告警。
  事件名已 grep 宿主源码核实（dsh-session known-event-types.js + dsh-compaction-basic）。
- **C 档显式入口**：`checkpoint()` 直调；p1-kind + messages 时 raw 快照委托
  `agint.memoryProvider.runPreCompressCheckpoint`（Q3 分层不重建，复用既有防死锁闸门）。
- **Q6 单一入口**：InsightProvider（apiVersion=2）注册进 P1-1 registry（不自动激活，
  shadow 期由老板拍板 `active_provider → 'compress-guard'`）；prefetch/syncTurn 完整
  委托 `agint.memory`（激活后召回行为与 builtin 一致）。
- **三类规则提取器（Q1 规则版）**：decision / fact / preference（preference 默认
  highRetention），rawOffset 可回溯，内容 ≤ 2KB，`maxInsightsPerCompress=20` 防提取风暴；
  `extractor: 'rule-v1'`，LLM 默认关（`setLlmExtract(true)` 显式拒绝，Sprint 21 拍板）。
- **恢复双通道（Q4）**：① `compress_recall` 工具；② 检索兜底——装饰 `agint.memory.search`，
  miss 时追加一次洞察检索并标注 `[来源：压缩洞察 ins_xxx]`，LRU 单次、单向、不回写
  记忆库（切断「压缩产物 → 记忆 → 再压缩」自我污染回路）；`enabled=false` 一并关闭。
- **session-reader（R10「原文可检索」入口）**：dsh 多帧 zstd 会话文件逐帧解码
  （magic 切帧 + zstdDecompressSync + JSON 校验；宿主流式 API 实测不续解后续帧），
  按 `shadowedSeqs` 回溯被压缩原文（只读，mtime/size 缓存）。
- **FROZEN 6 Service**：checkpoint / extract / search / recall / stats / setEnabled；
  非 FROZEN：setLlmExtract / reindex（显式未实现）。
- **测试 63 用例**：状态机三分支 / 不变量 1 validate / 软超时降级 / 恢复探针复位 /
  熔断直通 / 兜底单次不回写 / supersededBy 链 / 事件名静态核实（K19 同款）/ 多帧 zstd
  回溯 / fail-open 注错 / 零数据 NO_SOURCE_REACHED（不变量 6）。

### 标定期实测（2026-09-13）

- **R10 探针**：本机 `$DSH_HOME/sessions` 155 会话 / 140,109 事件全部可解，
  compaction/summary = **0**（M1=0，零压缩流量）→ `stats()` 恒 `NO_SOURCE_REACHED`，
  属诚实指标非故障（§六bis；§11.5 Q6「零流量推迟实施」的 B 档部分照设计稿实现，
  真实压缩一发生即开始计数）。

### 关联变更（P1-1 最小 PR）

- `agint-memory-provider/lib/manager.js`：`memory.pre-compress-checkpoint` 事件载荷补
  `checkpointId` + `sessionId`（设计稿 §5.1 载荷缺口正解②，< 5 行授权范围内）。
  PR 生效前 compress-guard 的 P1-1 路径洞察以 `linkPending` 落库、事件回填。
