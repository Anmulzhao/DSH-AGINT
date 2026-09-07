# CHANGELOG

## 0.1.0（2026-09-08 · Sprint 14 Part B · 仓库实现，不挂载 prod）

P7 自主课程生成器首个可用版本，按 Sprint14-设计稿 §4/§5 落地。

### 新增

- **边界探测**（`probe`）：消费 `agint-self-model` v0.7.1 `snapshot()` 能力画像；
  筛选 UNCERTAIN / calibration miscalibrated / CAN 超期未复验（默认 30 天）三类域，
  按「缺口权重 × 久未验证」排序；无模板域诚实留白（unverifiable，C1/Q5）。
- **挑战生成**（`generate` / `nextChallenge`）：4 域确定性模板（codegen /
  reasoning / planning / tool-use）× D1–D5 五档；挑战必带可自动判定 `verifySpec`
  （C1）；同域 24h 冷却 + 批量上限 5 防爆炸；出队只置 in_progress，**不自动执行**
  （§4.5）。
- **外部化判定**（`submit`）：按 verifySpec 断言（exit-code-output /
  conclusion-match / step-list / tool-match）判 pass/fail；C2 自评剥离进 notes；
  C3 无 evidence 记 fail；防御性 fail（宁 fail 不 pass）。
- **难度调节**（`difficulty`）：28 天滚动窗口 + 样本 <5 不调档（cold-start）；
  连续 pass/fail ≥3 强制升降档（防刷分/防挫败，行为信号优先于统计）；
  完成率 40%–70% 护栏；连续 fail ≥3 标 cannotCandidate 供 self-model 复验。
- **回写与事件**：判定结果经 `self-model.update()` 回写（trigger
  task-completed / task-failed，只提供证据，§4.9，不改 capability 表）；
  软依赖 event-bus 发布 4 类事件（boundary-probed / challenge-created /
  challenge-verdicted / difficulty-adjusted）。
- **D1 隔离**：挑战执行 `sessionId` 带 `curriculum-` 前缀；D4 黑名单副本三处
  （curator / skill-autocreate / curriculum）一致，`DATA_SOURCE_BLACKLIST_VERSION`
  = 2026-09-14.v1。
- **运维**：pause / resume / config 运行时开关；audit_log 唯一滚动清理；
  存储超限 warn 不 prune；不订阅任何 tools/pre-execute 类 waterfall 事件。

### 测试

- 60 个断言用例全绿：smoke（契约/枚举/LIMITS/storage spec/pack 元数据/
  generate 确定性/verdict C2C3/boundary-probe）、boundary-probe、challenge-gen、
  verdict、difficulty、pipeline（端到端：probe→generate→next→submit→
  难度演进→self-model 回写→事件→冷却→unverifiable→D1 隔离）。
- D4 三处一致性由 agint-curator 的 `const-consistency.test.mjs` 自动扫描覆盖。

### 不挂载 prod（Sprint14 拍板 Q1 / §0.3）

- prod 观察窗（变异成功率 ≥15% + 归因覆盖率 ≥80%，4 周）最早 10 月底满足；
  本版本只仓库实现 + 测试，挂载待 2026-09-25 影子挂载拍板会。
