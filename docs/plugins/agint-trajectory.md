# agint-trajectory

> P2-1：进化轨迹记录（训练数据层）。把 task / dream / eval / evolution / subagent
> 五类执行记为结构化轨迹，成功失败分离存储，ShareGPT / JSONL 导出。
>
> 设计稿：`DSH-AGINT.wiki/设计-P2-1-进化轨迹记录.md` v0.3；插件 README：`plugins/agint-trajectory/README.md`

## 职责

- 提供 `agint.trajectory` host Service（FROZEN 5 + 非 FROZEN 7）
- 独占存储域 `agint_trajectory`（schemaVersion 1）
- 治理：采样 / 脱敏 / 截断 / 预算 / prune / 熔断
- 事件：订阅 6 个（async）+ 发布 3 个
- ❌ 不做微调训练、不做回放引擎、不替代 evolution-memory、不进在线决策

## 数据格式（域表 `trajectories`）

```json
{
  "id": "traj_20261103_a1b2c3d4",
  "source": "evolution",
  "kind": "failure",
  "title": "evolution.evaluated v-7",
  "taskRef": { "sessionId": null, "cronJob": null, "candidateId": null,
               "variantId": "v-7", "round": 7,
               "subagentTaskId": null, "batchId": null },
  "startedAt": "2026-11-03T00:00:00Z",
  "endedAt": "2026-11-03T00:02:00Z",
  "durationMs": 120000,
  "usage": { "tokensIn": 8211, "tokensOut": 1940, "toolCalls": 3,
             "toolStats": { "bash": { "count": 3, "ok": 2, "fail": 1 } },
             "errorKinds": { "timeout": 1 } },
  "outcome": { "errorClass": "TOOL_GAP", "errorMsg": "...", "attributionId": "diag-1" },
  "payload": { "steps": [{ "seq": 0, "role": "human", "content": "..." }],
               "final": { "decision": "PROMOTE" }, "droppedSteps": 0 },
  "truncated": false, "redacted": true, "pinned": false,
  "feedback": null, "via": "event", "bytes": 4096,
  "createdAt": "2026-11-03T00:02:00Z"
}
```

`counters` / `calibration` 各存单条（`key='current'`）。

## 治理矩阵

| 项 | 默认 | 动作 |
|---|---|---|
| 内联上限 | 256KB | 截断（保头 + 保尾）+ `truncated=true` |
| 拒记 | 1MB | `droppedPayload++` |
| 日配额 | 200（仅落盘） | `droppedFull++` + 事件 |
| 容量 | 1800 条 / 64MB | prune 最旧非 pinned |
| 熔断 | 连续 5 次写失败 | `enabled=false` |
| 保留期 | 90 天 | `prune({maxAgeDays})` |

## 与其他插件的关系

- **`agint-event-bus`**：订阅 `dream.completed` / `evolution.*` / `diagnosis.completed` / `evo-orch.*`；发布 `trajectory.*`
- **`agint-tool-stats`**：工具参数正文的权威源（本插件不复存，只留 `toolCallId`）
- **`agint-diagnosis`**：`diagnosis.completed` → `linkAttribution` 回填 `errorClass` / `attributionId`
- **P2-3 `agint-evolve-orchestrator`**：子代理元数据权威源（本插件只存 `subagentTaskId` / `batchId`）
- **P2-2 学习图谱**（下游）：消费 `stats()`
- **`agint-evolution-memory`**：`failure_pattern.evidence` 可引用 `trajectoryId`（只读）

## 文件

```
lib/index.js         Cordis apply() + Service（FROZEN 5 + 非 FROZEN）
lib/schema.js        FROZEN schema / 枚举 / 治理参数 / 预算方程
lib/storage.js       域声明（3 表，version 1）
lib/redact.js        规则脱敏（可配规则表）
lib/payload.js       步骤归一化 / 用量聚合 / 截断（保头保尾）
lib/calibrate.js     标定期（P50/P95/日均/截断率 + ready 判定）
lib/export.js        ShareGPT / JSONL 导出 + 自检 + sidecar
lib/subscribers.js   事件订阅清单 + 映射 + 降级装配
test/*.test.mjs      单测（含静态契约 event-contract）
test/smoke.mjs       冒烟（一行能跑）
```

## 挂载

```yaml
# cordis.patch.yml
- insert:
    - id: agint-trajectory
      name: ./plugins/agint-trajectory/lib/index.js
      config: {}
```

挂载后默认 `count-only`：先干跑攒标定期 → `calibration()` 产出四项齐备的报告 →
老板确认 → `setRecordMode('live')`（无报告会抛错，不变量 #5）。
