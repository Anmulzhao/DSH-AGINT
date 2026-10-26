# CHANGELOG — agint-ov-strategy

## 0.1.1（2026-10-19）

C3（路线图 2.1 检索质量半侧）：`ov.recall.checked` 载荷补 `hitUris`。

- 为什么：此前载荷只有 `{injected, querySize, blockSize, error, sessionId}` ——
  知道"注入了"，不知道"注入了哪几条记忆"，结果无法回填到具体记忆条目（outcome 半侧）。
- 形状：从召回结果文本提取 `viking://…` URI（上游 `recall-core.mjs:396` 每条 hit
  渲染 `- [kind score%] ${item.uri}` ⇒ 身份就在文本里，不另找通道）。去重 + 上限 8。
- 红线照旧：只提 URI 路径，正文一字符不带（与 `argKeys` 同纪律）；错误路径 `[]`；
  纯加法，既有字段一字不动。
- 测试：`a6-recall-sessionid.test.mjs` +5 条 C3 用例（命中/未命中/出错/去重截断/正文不外泄），
  全插件 18/18 绿；红绿自证：hitUris 恒空 ⇒ 红、去重截断撤掉 ⇒ 红。

## 0.1.0（2026-09-27）

首个版本。设计稿：`proposals/agint-ov-strategy.md`（架构定性 2026-09-27 老板拍板：
对 DSH 深度融合、对 OV 薄缝解耦）。

### Service

- `ctx.provide('agint.ovStrategy')`：`remember(input)` / `recall(query)` / `status()`。
- `remember`：伪会话（`dsh-agint-<scope>-<trace>`）→ `runtime.ensureState` →
  `runtime.enqueueWrite(client.addMessage)` → retryable 失败 `runtime.enqueuePending`
  → `runtime.dispose`（官方 teardown commit + 清 states Map）。守卫链：
  disposed / enabled / bundle 存在 / scope 白名单 / 文本长度。
- `recall`：`client.fetchJSON POST /api/v1/search/search {query, mode:'context'}`，
  返回原始 entries，软失败契约（R3）。
- `status`：enabled / runtimeAvailable / counters（attempted/succeeded/failed/recalled）。

### 总线

- 订阅 `dream.completed`（countPromoted>0 才记）与 `diagnosis.completed`（恒记），
  async 模式，软依赖降级。
- 发布 `ov.strategy.remembered` / `ov.strategy.write-failed`（观测出口，软失败）。

### 硬约束

- 全软依赖（`inject=[]`）：bundle 缺席 / 总线缺席 / OV 宕机均不阻断 apply 与主服务。
- 不持有 storageDomain（R2）；不直连 OV REST、不自建队列（R4）。
- kill-switch：config `enabled:false` 或 env `AGINT_OV_STRATEGY=off`，出厂即开。
- 红线：不调 `runtime.capture()`、不用 `mcp__openviking__remember`、不接 ExternalProvider。
