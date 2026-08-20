# ROADMAP.md — AGINT 进化路线

> 从「散落的 dsh patch」到「可独立版本化的自进化框架」。
>
> 本文按 D-QAF 阶段（contract → eval → sandbox → policy → report）+ 横向护栏（安全 / 预算 / 哲学 / 退化）编排。完整收口见 `docs/evolution-framework.md`。

---

## 当前状态：**v0.2.0 已发**（D-QAF 评估引擎 + 自进化宪法 + install 安全左移）

> 详见 `CHANGELOG.md#v0.2.0` 与 `git tag v0.2.0`。

**已有**：
- **10 个 Cordis 插件**（memory / wiki / cron / dream / rules / metrics / evolve / tool-stats + `agint-quality-contract` + `agint-quality-eval`）
- 3 个 preset（agint / agint-coder / agint-investor）
- 1 个 profile-patch（web/cordis.patch.yml，含 9 个插件 insert 段；`agint-quality-eval` 已在 v0.2 收编）
- 4 个 skill（causal-reasoning / editing-cordis-compositions / memory-discipline / cordis-plugin-development）
- 顶层文档（README / AGENTS / PHILOSOPHY / VERSION / **CHANGELOG**）
- D-QAF 融合方案 + 评估框架完整汇总 + **整体优化改进方案** 三份设计文档
- **自进化宪法文档**：`docs/evolution-framework.md` / `docs/security-boundary.md` / `docs/evolution-philosophy-checkpoints.md`
- **评估场景集**（Sprint 1.3）：5 核心 plugin 冒烟 + 6 install 安全属性断言 = **13 场景全过**
- **install 安全左移**（Sprint 1.5）：`agint-security-checks.sh` 13 项 + `rsync --no-links` + 中央备份 + trap 回滚 + 装后静态校验
- **教训归档**（3 份 lessons）：v0.1 install bug / v0.2 sweep 阈值决策凭据 / v0.2 install 安全设计取舍

**没有**（v0.3+ 推进）：
- `agint-quality-policy` / `agint-quality-sandbox` / `agint-quality-report`
- 进化记忆层（Plan-Plan-Failure-Patterns / Success-Templates）
- 退化/停滞探测机制（v0.3 §退化探测项落地）
- 跨平台 install 验证（Sprint 1.6 跳过）
- CI / 自动化测试（dsh 上游变更时手动适配）
- Prompt 层进化（v0.4 补齐）

---

## 阶段总览

| 阶段 | 版本 | 核心目标 | 关键交付 |
|---|---|---|---|
| **P0** | v0.1.0 | 基础能力搭建 | 9 个插件 + 3 个 preset + 1 个 patch |
| **P1** | v0.1.1 | D-QAF 契约层 | `agint-quality-contract` + frozenness 三层 |
| **P2** | v0.2 | D-QAF 评估引擎 + 完整性 | `agint-quality-eval` + 自进化宪法文档 |
| **P3** | v0.3 | 沙箱动态验证 + 进化记忆 | `agint-quality-sandbox` + `evolution-log` + 退化探测 |
| **P4** | v0.4 | 策略引擎 + 灰度发布 + Prompt 进化 | `agint-quality-policy` + `agint-quality-report` + Prompt 插件类型 |
| **P5** | v0.5+ | 社区化 + 多 Agent 协同 | 插件 SDK + Registry + 协同进化场景 |

> **调整记录**：相比 `DSH自进化系统评估框架完整汇总.md` 给出的 P0→P4 框架，本次重写吸纳了 `DSH自进化系统整体优化改进方案.md` §5 的五条 ROADMAP 建议：
>
> 1. **评估基础设施前置**（§5.1）：`eval/scenarios/` 最小可行集提前到 P2 初期，与 `agint-quality-eval` 同步开发
> 2. **安全左移**（§5.2）：`install.sh` 内置基础安全检查；`agint-quality-sandbox` 与 `agint-quality-static-*` 并行
> 3. **社区化技术前提前置**（§5.3）：P4 第一个里程碑改为"外部贡献者成功提交一个合规 Plugin 并通过 CI"
> 4. **进化节奏量化护栏**（§5.4）：每周最多 N 次自动部署 + 进化健康度仪表盘（见节奏章节）
> 5. **哲学锚点工程化检查点**（§5.5）：每个 P 阶段验收标准显式包含哲学对齐检查（详见 `docs/evolution-philosophy-checkpoints.md`）

---

## P1：仓库成型（v0.1）✅

- [x] `install/install.sh` + `install/uninstall.sh` 可执行、可回滚
- [x] `.gitignore` 排除 runtime 数据（storages / dreams / wiki / reviews）
- [x] 每个插件一份 `docs/plugins/agint-*.md`：设计意图 / Service 契约 / 存储 schema / 与其他插件关系
- [x] 首版 git tag `v0.1.0`
- [x] 推到 `github.com/Anmulzhao/DSH-AGINT`（v0.1.2 之前；v0.2 累积 10 commit 领先 origin，待 push）

---

## P2：可移植性 + D-QAF 评估引擎（v0.2）🚧 进行中

> **目标**：评估引擎在最小场景集上的准确率 ≥ 90%。每个核心插件至少 1 个冒烟测试伴随开发。

### 可移植性

- [ ] `cordis.patch.yml` 的 `$HOME` 默认值在不同平台（macOS / Linux / WSL）下测过
- [ ] `VERSION` 写明 dsh 兼容矩阵；CI 在 dsh 最新 release 上跑插件 test
- [ ] 把 `AGINT_HOME` / `DSH_HOME` 概念写进安装脚本
- [ ] 提供 `install/docker-compose.yml` 演示（可选）
- [x] `install.sh` 内置基础安全检查（路径遍历防护 / 权限校验 / 备份机制）—— **§5.2 安全左移**

### D-QAF `agint-quality-eval`（v0.2 初版）

- [x] 7 维评分（trust / reliability / effectiveness / safety / integrability + convention/adaptability 留 v0.3 sandbox 补）
- [x] 综合分计算：safety 权重 0.30 一票否决
- [x] HARM 简版：H/M 中性 0.5；A ≈ trust；R ≈ reliability
- [x] WeeklyScheduler：每周日 04:30 批量评估，写 `agint.memory`
- [x] **最小场景集**覆盖冒烟测试（`eval/scenarios/` 定义）—— **§5.1 评估基础设施前置**（13 场景，5 插件冒烟 + 6 install 安全属性断言 + 2 metrics cron 双场景）
- [ ] 评估引擎在最小场景集上的准确率 ≥ 90%（Sprint 1.4，老板拍板用合成候选 + 期望分位）

### 自进化宪法文档（**仅文档落地**；HARM 全量 / 退化探测 / 预算对齐机制仍待 P3 验证）

- [x] `docs/evolution-framework.md` —— D-QAF + HARM + 进化记忆层完整收口
- [x] `docs/security-boundary.md` —— 硬约束清单（har_constraints + sandbox_permissions）
- [x] `docs/evolution-philosophy-checkpoints.md` —— 哲学锚点工程化检查项
- [ ] **P3 验收**：机制在 D-QAF Phase 2/3 实际跑通（沙箱 + 评估 + 退化探测闭环）

---

## P3：沙箱动态验证 + 进化记忆（v0.3）

> **目标**：D-QAF Phase 2/3 落地 + 系统不再"忘事"。

### D-QAF Phase 2：沙箱

- [ ] `agint-quality-sandbox`：复用 dsh 沙箱机制（bwrap / Landlock / Seatbelt）
- [ ] 沙箱配置：只读 + 网络隔离 + 资源限制（超时 30s / 内存 512MB）—— 详见 `docs/security-boundary.md`
- [ ] 动态沙箱执行结果写入 `agint.memory` 评估历史区
- [ ] **与 `agint-quality-static-*` 并行开发**（非串行）—— **§5.2 安全左移**

### D-QAF Phase 3：集成演练 + HARM + 预算对齐

- [ ] `agint-quality-eval` 接入全量 HARM（取代 H/M 中性 0.5）
- [ ] **预算对齐**：Phase 3 加入 `有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)` 校验
  - 有效进化增量 ≤ 0 即使 HARM 提升也标记为"无效进化"并拒绝部署
  - 灰度对比测试强制相同 Token 预算 / 相同最大步数 / 相同超时阈值
- [ ] 动态权重调节：探索期提高 Mutability 权重；稳定期提升 Reduction / Alignment 权重
- [ ] 反和谐检测器：定义"伪和谐模式"清单（过度压缩、可读性丧失、强行合并异构逻辑）

### 进化记忆层

- [x] 新增 `agint-evolution-memory`（Sprint 2.B 落地，独立 plugin；未纳入 `agint-quality` 子模块）：
  - `evolution_log/`：每次 D-QAF Phase 4 完成后自动写入（Service 接口已就位，钩子留 Sprint 3 接入）
  - `failure_pattern/`：周复盘时归纳（Service 接口 + 去重 + substring 检索就位）
  - `success_template/`：周复盘时蒸馏（Service 接口 + substring 检索就位）
- [x] 物理隔离：进化记忆 ≠ 任务记忆（独立存储域 `agint_evolution`，三表 `evolution_log` / `failure_pattern` / `success_template`）
- [x] 自动化写入 Service 接口已就位（logPhase4 / addFailure / addSuccess），由 D-QAF 流水线自动落点（Sprint 3 接入 eval/policy）
- [x] 定向读取：Service 接口已就位（queryFailures / queryTemplates / getLogRange），日常任务推理不读（Sprint 3 接入 eval/dream）

### 评估集

- [ ] `eval/scenarios/`：每个插件一个回归用例（输入 → 期望 Service 行为）
- [ ] 端到端测试：从 `cron` 触发 → `dream` sweep → `memory` 提升 → `metrics` 采集 → `evolve` 复盘 → `quality-eval` 评估的闭环
- [ ] 用例可被 dsh headless 跑：`dsh --profile headless "..."`

### 退化探测

- [ ] `agint-quality-eval` 增加 `baseline-regression-suite` 跑分
- [ ] 基线回归套件通过率下降 > 2% → 立即冻结进化并告警
- [ ] 连续 K=5 次进化 HARM 增量 < 0.5 → 判定进化停滞，切换探索模式或暂停

---

## P4：策略引擎 + 灰度发布 + Prompt 进化（v0.4）

> **目标**：D-QAF 全链路闭环 + Prompt 层进化能力 + 社区化技术前提到位。

### D-QAF Phase 4：灰度发布

- [ ] `agint-quality-report`：写 Markdown → `agint-wiki` + JSON → `agint-memory`
- [ ] `agint-quality-policy`：实现决策引擎（AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN）
- [ ] 灰度发布：A/B 测试 + 实时熔断
- [ ] HARM 不能独立决策：必须与 TRACE-P 中的 Safety/Reliability 联合使用（HARM=95 but Reliability<80% 仍不得自动部署）

### Prompt 层进化

- [ ] 新增插件类型：`dsh-quality-prompt-*`
- [ ] 系统 Prompt 模板视为可版本化资产，纳入语义版本管理
- [ ] 复用 D-QAF 流水线：Prompt 变更 → 静态检查（格式 / 注入风险）→ 沙盒 A/B 测试 → HARM 打分 → 灰度发布
- [ ] **关键约束**：Prompt 变更必须附带至少 5 个回归测试用例

### 安全护栏

- [ ] 元评估委员会机制：`agint-quality-policy` 变更需满足 ① 连续 N 次进化未触发回滚，或 ② 经人类审批 + 影子模式验证 7 天以上
- [ ] 核心契约（`agint-quality-contract`）语义版本锁定：接口签名变更必须发 major 版本，旧版本至少保留 3 个 minor 周期

### 社区化技术前提

- [ ] **插件接口契约形式化描述**（OpenAPI / JSON Schema）—— **§5.3 社区化技术前提前置**
- [ ] 插件 SDK + 模板生成器：`dsh plugin init --name my-eval`
- [ ] 3 个官方示例 Plugin（静态检查 / 沙盒测试 / HARM 评分）
- [ ] P4 第一个里程碑："外部贡献者成功提交一个合规 Plugin 并通过 CI"（先于文档就绪）

---

## P5：社区化 + 多 Agent 协同（v0.5+）

- [ ] Plugin Registry / Marketplace
- [ ] `CONTRIBUTING.md` + issue template
- [ ] CHANGELOG.md 自动生成
- [ ] 选 1-2 个社区贡献者跑通流程
- [ ] 多 Agent 协同进化场景（共享环境 + 竞争合作 + 群体涌现）

---

## 不做的事

- 不 fork dsh
- 不在 AGINT 仓里放 runtime 数据
- 不追求大而全的 AGI 路线图——AGINT 是工程化骨架，不是宣言
- 不预设 AGI 时间表
- **不引入新的架构层**——所有改进都必须在现有插件化架构内完成（来自 `DSH自进化系统整体优化改进方案.md` 核心原则）
- 不修改 L0-frozen 字段（除非走人类多签 + CI 禁改）

---

## 节奏

### 周节奏

- **周日 03:00** `night-dream` job 跑梦境 light→REM→deep
- **周日 04:00** `metrics-collect` job 采集快照
- **周日 04:30** `agint-quality-eval` 批量评估所有 AGINT Skills + Plugins
- **周日 18:00** `evolve-review` job 写复盘报告
- 老板过复盘报告，决定哪些 proposal 进 backlog

### 版本节奏

- 插件接口稳定才发 minor
- 破坏性变更发 major
- L0-frozen 字段变更需要发 major + 人类多签

### 文档节奏

- 每次 plugin README 改动同步更新 `docs/architecture.md`
- 每次 ROADMAP 调整同步更新 `docs/evolution-framework.md`
- 每次新增 plugin 同步更新 `docs/plugins/agint-*.md`

### 进化健康度护栏（`§5.4 五大建议 #4`）

| 指标 | 阈值 | 触发动作 |
|---|---|---|
| 每周自动部署次数 | ≤ 3 次 | 超限 → 强制进入人工审核队列 |
| 进化回滚率 | ≤ 20% | 连续 3 周超限 → 暂停自动部署 |
| 人工干预率 | ≤ 30% | 连续 3 周超限 → 评估是否过度工程 |
| HARM 趋势 | 4 周滑动平均 ≥ 上月 95% | 低于 → 触发 `baseline-regression-suite` 跑分 |
| 基线测试通过率 | ≥ 95% | 下降 → 立即冻结进化并告警 |

### 哲学锚点护栏（`§5.5 五大建议 #5`）

每个 P 阶段验收必须显式包含哲学对齐检查，详见 `docs/evolution-philosophy-checkpoints.md`：

- **简洁 > 冗余**：新增代码行数 / 功能点数 ≤ 阈值（每新增功能 ≤ 200 行净增）
- **安全 > 效率**：所有性能优化提案必须附带安全影响分析
- **真实 > 讨好**：评估报告禁止隐藏失败案例，必须展示原始数据
- **靠谱 > 聪明**：行为可预期 > 一次惊艳；变更可回滚 > 一步到位
- **主动 > 被动**：隐患看见了就动手；重复任务第二次就自动化

---

## 哲学锚点

任何争议回到 `PHILOSOPHY.md`：
- 简洁 > 冗余
- 真实 > 讨好
- 靠谱 > 聪明
- 主动 > 被动
- 安全 > 效率
