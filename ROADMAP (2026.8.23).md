# ROADMAP.md — AGINT 进化路线

从「散落的 dsh patch」到「可独立版本化的自进化框架」，再到「真正闭环进化的智能体系统」。

本文按 **D-QAF 阶段**（contract → eval → sandbox → policy → report → SDK）+ **进化闭环引擎**（diagnosis → mutator → population → self-model → curriculum → meta-evolution）+ **横向护栏**（安全 / 预算 / 哲学 / 退化）编排。完整收口见 `docs/evolution-framework.md`。

---

## 当前状态

**v0.5.1 已发**（SDK ↔ D-QAF 流水线接通，Sprint 6 / v0.5 Part 2/2 收口）

详见 `CHANGELOG.md#v0.5.1` 与 `git tag v0.5.1`。

**历程**：v0.3.1（P3 收口）→ v0.4.0（P4 策略引擎 + 反和谐 + 元评估 + 报告）→ v0.5.0（Prompt SDK Part 1/2）→ v0.5.1（Prompt SDK ↔ D-QAF 流水线 Part 2/2）。

**下一步**：P6 进化闭环引擎（v0.6）——填补 L2→L3 的关键缺口，让 AGINT 从"有纪律的反思系统"变为"真正的自进化系统"。

---

## 已有

- **13 个 Cordis 插件**：memory / wiki / cron / dream / rules / metrics / evolve / tool-stats / evolution-memory + quality 子家族 6 个（`agint-quality-contract` / `agint-quality-eval` / `agint-quality-sandbox` / `agint-quality-policy` / `agint-quality-report` / `agint-quality-sdk`）；policy 与 report 已从占位升级到 v0.4 完整版
- **3 个 preset**（agint / agint-blockchain / agint-investor，原 agint-coder 已重命名为 agint-blockchain 并新增 5 个 web3 skill）
- **1 个 profile-patch**（web/cordis.patch.yml）+ 1 个 SDK row（v0.5.0 启用）
- **4 个 skill** + 3 个 prompt preset（hello / coder / investor，由 `agint-prompt-init` CLI 生成）
- **顶层文档**（README / AGENTS / PHILOSOPHY / VERSION / CHANGELOG）+ D-QAF 融合方案 / 评估框架完整汇总 / 整体优化改进方案 三份设计文档
- **自进化宪法文档**：`docs/evolution-framework.md` / `docs/security-boundary.md` / `docs/evolution-philosophy-checkpoints.md`
- **评估场景集**：84/84 全量 PASS（v0.3.1 时 49 → v0.4 加 19 评估 + e2e 10 步 → v0.5.0 SDK 加 14 step e2e → v0.5.1 Sprint 6 加 8 单元）
- **install 安全左移**（Sprint 1.5）
- **Sprint 2 三大块**（P3 收口）：
  - `agint-quality-sandbox`：桥接 ctx.sandbox + 6 项冒烟 + 30s/512MB 资源限制
  - `agint-evolution-memory`：独立 storage domain + 三表 + L1-L4 衰减 + 100/50 上限
  - 退化探测：baseline-regression-suite（4 级 severity）+ stagnation-check（K=5/threshold=0.5）
- **Sprint 3 三大块**（v0.3.1）：eval Phase 2 sandbox gate（sandbox 失败 → safety=0 → REJECT）+ weeklyTask 3 hook（logPhase4 + runBaselineSuite + checkStagnation）+ rules deny evolution-log + policy 占位骨架
- **Sprint 4 五大块**（v0.4.0）：policy 完整 4 决策 + 加权综合分 / 反和谐检测器（rejection-uniformity + false-consensus + regression-underreporting）/ 元评估委员会（shadow + auto-promote N=10 + rollback）/ `agint-quality-report` HARM 报告（markdown → wiki + JSON → memory）/ 端到端闭环 e2e（cron → dream → memory → metrics → evolve → eval → policy → report，10/10 PASS）
- **Sprint 5 Part 1/2**（v0.5.0）：Prompt SDK 基础设施——`PromptManifestSchema` FROZEN 契约 + 模板引擎（`extractPlaceholders` / `renderPrompt`）+ 静态检查三类（注入 / 占位符滥用 / manifest 不一致）+ CLI `agint-prompt-init` + 3 presets + SDK row 启用 + `manifest.regressionTests ≥ 5` 哲学护栏
- **Sprint 6 Part 2/2**（v0.5.1）：SDK ↔ D-QAF 流水线接通——cron `prompt-static-check` (daily 04:45) + `evalPromptStatic` 维度（权重 0.20，tags 触发）+ policy prompt 决策 path（更严 thresholds + blocker 强制 REJECT）+ report markdown prompt section + e2e 8/8 PASS
- **运维保命工具**（v0.4 之后）：`bin/safe-update.sh` 一键挂载保命脚本 + `bin/agint-mount.sh` 升级/回滚/重启 + PLUGIN-SPEC 8 维度准入规范 + lint 脚本 + 12 份 manifest 草案
- **教训归档**（3 份 lessons）+ safe-update SOP 文档（2026-08-21 重启事故复盘）

---

## 没有（按阶段重新归档）

### P6 推进项（v0.6）
- `agint-diagnosis`：归因引擎（根因标注 + 反事实模拟 + 模式聚类）
- `agint-mutator`：变异构造器（Prompt/Tool/Strategy 三类变异）
- `agint-population`：种群管理器（简化版 3-5 变体 + 锦标赛选择）
- 静态检查增强（`agint-quality-static-*` 全面升级）：原老板拍板 v0.4 不做，现纳入 P6
- 进化记忆异步批量写入（EvolutionLogBuffer）
- Prompt-A/B 测试基础设施（Phase 5.2）
- 沙箱自由度分级：`verify`（严格）+ `explore`（宽松探索）

### P7 推进项（v0.7）
- `agint-self-model`：能力图谱 + 推理模式画像 + 资源感知
- `agint-curriculum`：自主课程生成器（能力边界探测 + 难度调节）
- `agint-transfer`：跨域迁移引擎（策略抽象 + 迁移匹配 + 验证）
- Plugin Registry / Marketplace（原 P5 内容，降级至此）
- 真沙箱后端：eval 走 in-process fallback；生产需 `dsh-sandbox-local`
- 跨平台 install 验证（Sprint 1.6 跳过）
- 预算对齐：Phase 3 有效进化增量校验
- A/B 流量切分：shadow mode + auto-promote + rollback 是基础设施，流量切分留此处
- 每周 ≤ 3 次自动部署护栏接入 weekly hook
- 社区化技术前提：插件接口契约形式化描述（JSON Schema / OpenAPI）+ 插件 SDK 模板生成器 + 3 个官方示例 Plugin + 外部贡献者跑通流程

### P8 推进项（v0.8+）
- `agint-meta-evolution`：元进化引擎（进化过程监控 + 策略调整 + HARM 权重自适应）
- CI / 自动化测试
- 多 Agent 协同进化场景（共享环境 + 竞争合作 + 群体涌现）

---

## 阶段总览

| 阶段 | 版本 | 核心目标 | 关键交付 | 状态 |
|------|------|----------|----------|------|
| P0 | v0.1.0 | 基础能力搭建 | 9 个插件 + 3 个 preset + 1 个 patch | ✅ |
| P1 | v0.1.1 | D-QAF 契约层 | `agint-quality-contract` + frozenness 三层 | ✅ |
| P2 | v0.2 | D-QAF 评估引擎 + 完整性 | `agint-quality-eval` + 自进化宪法文档 | ✅ |
| P3 | v0.3 | 沙箱动态验证 + 进化记忆 | `agint-quality-sandbox` + `evolution-log` + 退化探测 | ✅ |
| P4 | v0.4 | 策略引擎 + 灰度发布 + Prompt 进化 | `agint-quality-policy` + `agint-quality-report` + Prompt 插件类型 | ✅ |
| P5 | v0.5 | Prompt SDK + 流水线接通 | `agint-quality-sdk` + cron/eval/policy/report 全链路 | ✅ v0.5.1 |
| **P6** | **v0.6** | **进化闭环引擎** | **diagnosis + mutator + population + 静态增强** | 🔜 Next |
| **P7** | **v0.7** | **自我认知 + 自主课程 + 社区化** | **self-model + curriculum + transfer + Registry** | 📋 Planned |
| **P8** | **v0.8+** | **元进化 + 多 Agent 协同** | **meta-evolution + HARM 自适应 + 协同进化** | ⏳ Deferred |

---

## 调整记录

相比 `DSH自进化系统评估框架完整汇总.md` 给出的 P0→P4 框架，本次重写吸纳了 `DSH自进化系统整体优化改进方案.md` §5 的五条 ROADMAP 建议：

- **评估基础设施前置**（§5.1）：`eval/scenarios/` 最小可行集提前到 P2 初期，与 `agint-quality-eval` 同步开发
- **安全左移**（§5.2）：`install.sh` 内置基础安全检查；`agint-quality-sandbox` 与 `agint-quality-static-*` 并行
- **社区化技术前提前置**（§5.3）：P4 第一个里程碑改为"外部贡献者成功提交一个合规 Plugin 并通过 CI"
- **进化节奏量化护栏**（§5.4）：每周最多 N 次自动部署 + 进化健康度仪表盘（见节奏章节）
- **哲学锚点工程化检查点**（§5.5）：每个 P 阶段验收标准显式包含哲学对齐检查（详见 `docs/evolution-philosophy-checkpoints.md`）

**本次重大调整**（自进化能力断裂分析驱动）：

- **新增 P6 进化闭环引擎**：基于"完整自进化闭环七断裂点"分析（断裂①归因 → 断裂②变异构造 → 断裂③种群选择 → 断裂④自主课程 → 断裂⑤自我模型 → 断裂⑥元进化 → 断裂⑦跨域迁移），将 P6 定位为填补 L2→L3 关键缺口的阶段
- **P5 社区化拆分降级**：Plugin Registry / Marketplace 从 P5 移至 P7，理由：没有归因和变异能力之前，开放社区贡献的插件无法被进化系统有效消化。先让系统能"吃掉"并"改进"外部插件，再建市场
- **P7 新增自我认知与自主课程**：解决进化方向盲目性和驱动力缺失问题
- **P8 新增元进化**：L5 层能力，仅在 P6-P7 稳定运行 ≥ 3 个月后启动
- **沙箱哲学重定义**：沙箱从"质量门禁"扩展为"进化实验场"——沙盒内允许激进探索，沙盒外严格约束

---

## P1：仓库成型（v0.1）✅

- [x] `install/install.sh` + `install/uninstall.sh` 可执行、可回滚
- [x] `.gitignore` 排除 runtime 数据（storages / dreams / wiki / reviews）
- [x] 每个插件一份 `docs/plugins/agint-*.md`：设计意图 / Service 契约 / 存储 schema / 与其他插件关系
- [x] 首版 git tag `v0.1.0`
- [x] 推到 `github.com/Anmulzhao/DSH-AGINT`（v0.1.2 之前；v0.2 累积 10 commit 领先 origin，待 push）

---

## P2：可移植性 + D-QAF 评估引擎（v0.2）🚧 进行中

目标：评估引擎在最小场景集上的准确率 ≥ 90%。每个核心插件至少 1 个冒烟测试伴随开发。

### 可移植性

- [ ] `cordis.patch.yml` 的 `$HOME` 默认值在不同平台（macOS / Linux / WSL）下测过
- [ ] `VERSION` 写明 dsh 兼容矩阵；CI 在 dsh 最新 release 上跑插件 test
- [ ] 把 `AGINT_HOME` / `DSH_HOME` 概念写进安装脚本
- [ ] 提供 `install/docker-compose.yml` 演示（可选）
- [x] `install.sh` 内置基础安全检查（路径遍历防护 / 权限校验 / 备份机制）—— §5.2 安全左移

### D-QAF `agint-quality-eval`（v0.2 初版）

- [x] 7 维评分（trust / reliability / effectiveness / safety / integrability + convention/adaptability 留 v0.3 sandbox 补）
- [x] 综合分计算：safety 权重 0.30 一票否决
- [x] HARM 简版：H/M 中性 0.5；A ≈ trust；R ≈ reliability
- [x] WeeklyScheduler：每周日 04:30 批量评估，写 `agint.memory`
- [x] 最小场景集覆盖冒烟测试（`eval/scenarios/` 定义）—— §5.1 评估基础设施前置（13 场景，5 插件冒烟 + 6 install 安全属性断言 + 2 metrics cron 双场景）
- [ ] 评估引擎在最小场景集上的准确率 ≥ 90%（Sprint 1.4，老板拍板用合成候选 + 期望分位）

### 自进化宪法文档（仅文档落地；HARM 全量 / 退化探测 / 预算对齐机制仍待 P3 验证）

- [x] `docs/evolution-framework.md` —— D-QAF + HARM + 进化记忆层完整收口
- [x] `docs/security-boundary.md` —— 硬约束清单（har_constraints + sandbox_permissions）
- [x] `docs/evolution-philosophy-checkpoints.md` —— 哲学锚点工程化检查项
- [ ] P3 验收：机制在 D-QAF Phase 2/3 实际跑通（沙箱 + 评估 + 退化探测闭环）

---

## P3：沙箱动态验证 + 进化记忆（v0.3）

目标：D-QAF Phase 2/3 落地 + 系统不再"忘事"。

### D-QAF Phase 2：沙箱

- [x] `agint-quality-sandbox`：桥接 dsh `ctx.sandbox` 服务（生产用 bwrap/Landlock/Seatbelt；eval 走 in-process 降级）
- [x] 沙箱配置：mode=`workspace-write`（plugin 目录可写）+ 网络隔离（bwrap `--unshare-net`）+ 资源限制 timeout 30s / memory 512MB
- [x] 动态沙箱执行结果写入 `agint.evolution`（Sprint 2.A 在 sandbox service 内部 addFailure；Sprint 3 改由 policy 触发）
- [ ] 与 `agint-quality-static-*` 并行开发（非串行）—— §5.2 安全左移（静态检查本 Sprint 未做，老板拍板留后续，**已移入 P6**）

### D-QAF Phase 3：集成演练 + HARM + 预算对齐

- [ ] `agint-quality-eval` 接入全量 HARM（取代 H/M 中性 0.5）
- [ ] 预算对齐：Phase 3 加入 `有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)` 校验
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
- [x] 自动化写入 Service 接口已就位（logPhase4 / addFailure / addSuccess），由 D-QAF 流水线自动落点（Sprint 3.1 部分接入 eval sandbox gate；Sprint 3.2 接 weekly hook；Sprint 3.3 接 policy）
- [x] 定向读取：Service 接口已就位（queryFailures / queryTemplates / getLogRange），日常任务推理不读（Sprint 3 接入 eval/dream）

### v0.3.x — D-QAF 端到端流水线接入

- [x] Sprint 3.1 — `agint-quality-eval` Phase 2 调 `agint.qualitySandbox.runSmoke()` 作为 gate：sandbox 失败 → 该 target safety=0 → compositeScore=null → REJECT 路径。target.path 缺失时跳过 gate（向后兼容 skill 类）。
- [x] Sprint 3.2 — weeklyTask 末尾：每个 EvalResult → `evo.logPhase4({targetId, targetKind, decision, scores, findings, tags:['weekly']})`；runBaselineSuite() → regression 自动触发 `evo.addFailure('regression:<severity>')`；checkStagnation() → 读 evolution-log 计算增量。3 个新 Service hook 全跑。
- [x] Sprint 3.3 — `agint-rules` 加 `bash-delete-evolution-log` deny 规则（L1 严重度 + L0-frozen：禁止 rm/unlink/rmdir 命中 evolution_log/，允许 mv 做 rotate）；新建 `agint-quality-policy` 骨架 plugin：Service `decide()` 占位（safety veto → REJECT，其余 PENDING_REVIEW）；REJECT → 自动 `evo.addFailure(pattern='policy-reject:<decision>')`；任意 decision → `evo.logPhase4(targetKind='composite')`。Sprint 4 升级 4 决策 + 加权逻辑。

### 评估集

- [ ] `eval/scenarios/`：每个插件一个回归用例（输入 → 期望 Service 行为）
- [ ] 端到端测试：从 `cron` 触发 → `dream` sweep → `memory` 提升 → `metrics` 采集 → `evolve` 复盘 → `quality-eval` 评估的闭环
- [ ] 用例可被 dsh headless 跑：`dsh --profile headless "..."`

### 退化探测

- [x] `agint-quality-eval` 增加 `baseline-regression-suite` 跑分（`runBaselineSuite` Service 方法 + `regression.js` 纯函数 + 9 个固定 baseline target）
- [x] 基线回归套件通过率下降 > 2% → 立即冻结进化并告警（4 级 severity: ok/warn@2%/high@10%/blocker@25%；触发 `evo.addFailure(pattern='regression:<severity>', tags=['freeze'])`）
- [x] 连续 K=5 次进化 HARM 增量 < 0.5 → 判定进化停滞（`checkStagnation` Service 方法 + K=5/threshold=0.5；最近 K-1 个 delta 都 < 0.5 → isStagnated=true）

---

## P4：策略引擎 + 灰度发布 + Prompt 进化（v0.4）

目标：D-QAF 全链路闭环 + Prompt 层进化能力 + 社区化技术前提到位。

### D-QAF Phase 4：灰度发布

- [x] `agint-quality-report@0.4.0`：写 Markdown → `agint-wiki` + JSON → `agint-memory`（Sprint 4.4）
- [x] `agint-quality-policy@0.4.0`：完整 4 决策（AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN）+ 加权综合分 + audit + thresholds（Sprint 4.1）
- [x] 反和谐检测器（Sprint 4.2）：rejection-uniformity / false-consensus / regression-underreporting 三类精确算法
- [x] 元评估委员会（Sprint 4.3）：shadow / rollback / history source-of-truth + N=10 自动升
- [x] 端到端闭环脚本（Sprint 4.5）：`cron → dream → memory → metrics → evolve → eval → policy → report`，eval/e2e/sprint4-closed-loop.js 10/10 PASS
- [ ] 灰度发布：A/B 测试 + 实时熔断（部分完成：shadow mode + auto-promote + rollback 是基础设施，A/B 流量切分留 v0.7）
- [x] HARM 不能独立决策：Safety<0.5 / Trust<0.3 → REJECT veto（综合分 safety 权重 0.30 一票否决）
- [ ] 安全护栏：每周最多 N 次自动部署护栏（v0.7+ 接入 weekly hook）
- [x] 静态检查（`agint-quality-static-*`）：老板拍板 v0.4 不做 → **已移入 P6**

### Prompt 层进化

- [x] Sprint 5 (Part 1/2) — `agint-quality-sdk@0.5.0`:
  - PromptManifestSchema FROZEN 契约 (lib/schema.js): `name / version / description / kind / variables / regressionTests / contractRef`
  - 模板引擎 (lib/template-engine.js): `extractPlaceholders` / `renderPrompt` (required + enum 校验)
  - 静态检查三类 (lib/static-check.js): 注入 / 占位符滥用 / manifest 不一致
  - 老板拍板: regressionTests ≥ 5 (P3 哲学护栏的 prompt 层延伸)
  - CLI `bin/agint-prompt-init.js`: 3 presets (hello/coder/investor), 生成 manifest+template+tests+README
  - 3 个示例 (`examples/{hello,coder,investor}-prompt`) 由 CLI 生成
  - profile-patches/web/cordis.patch.yml: SDK row 启用
- [x] Sprint 6 (Part 2/2) — SDK ↔ D-QAF 流水线接通:
  - 6.1 cron `prompt-static-check` (daily 04:45) — batchStaticCheck + reportFailuresToEvo → evo
  - 6.2 `evalPromptStatic` dimension (权重 0.20，仅 prompt target 通过 tags 触发)
  - 6.3 policy prompt 决策 path (promptThresholds 更严 + blocker finding 强制 REJECT)
  - 6.4 report markdown prompt section (`Prompt summary (Sprint 6)`)
  - 6.5 e2e (`cron → check-all → evalPromptStatic → policy REJECT → report`)
- [ ] Prompt-A/B 测试基础设施 (Phase 5.2) → **已移入 P6**
- [ ] 系统 Prompt 模板视为可版本化资产，纳入语义版本管理
- [x] 关键约束：Prompt 变更必须附带至少 5 个回归测试用例 → 已落地 manifest.regressionTests ≥ 5

### 安全护栏

- [x] 元评估委员会机制（Sprint 4.3）：shadow run + auto-promote N=10 + rollback（≥50% REJECT）
- [x] 核心契约（`agint-quality-contract`）语义版本锁定：FROZEN（QualityEvaluator/Policy/Reporter/Lifecycle 接口签名）+ ADJUSTABLE（harmWeights / thresholds / sandboxLimits）护栏
- [x] L0 字段修改走 `validatePatch` 守门（contact plugin 已实现） + AGENTS.md 文档化人类多签路径

### 社区化技术前提 → **已移至 P7**

- [ ] 插件接口契约形式化描述（OpenAPI / JSON Schema）—— §5.3 社区化技术前提前置
- [ ] 插件 SDK + 模板生成器：`dsh plugin init --name my-eval`
- [ ] 3 个官方示例 Plugin（静态检查 / 沙盒测试 / HARM 评分）
- [ ] "外部贡献者成功提交一个合规 Plugin 并通过 CI"（先于文档就绪）

### v0.4 sprint 完成度

| Sub-task | 内容 | 场景 | commit |
|----------|------|------|--------|
| 4.1 | policy 完整升级 | 10 | 375273a |
| 4.2 | 反和谐检测器 | 7 | eb58829 |
| 4.3 | 元评估委员会 | 6 | 916806a |
| 4.4 | HARM 报告生成 | 3 | 51681d7 |
| 4.5 | 端到端测试 | 1 脚本 (10 步) | c76de17 + 38320d7 |
| 合计 | | 26 场景 (19 + 7 旧移除 + e2e) | 6 commits |

---

## P5：Prompt SDK + 流水线接通（v0.5）✅

> 原 P5 社区化内容已拆分：SDK 部分保留为 P5 并完成；社区化（Registry / Marketplace / 贡献者流程）移至 P7。

- [x] `agint-quality-sdk` 完整落地（Sprint 5-6）
- [x] SDK ↔ D-QAF 全链路接通（cron → check → eval → policy → report）
- [x] 84/84 全量 eval PASS

---

## P6：进化闭环引擎（v0.6）🔜 Next

> **定位**：填补 L2→L3 的关键缺口，让 AGINT 从"有纪律的反思系统"变为"真正的自进化系统"。
>
> **核心洞察**：AGINT 建了一座很好的"进化工厂"（D-QAF、HARM、规则门禁），但工厂里没有原材料（归因）、没有工人（变异构造器）、没有竞争（种群）。P6 的目标是让流水线跑起来。
>
> **前置条件**：v0.5.1 SDK ↔ D-QAF 流水线全量 PASS。

### 进化闭环目标架构
感知失败 → 归因分析 → 构造变异 → 沙盒验证 → 选择保留 → 整合部署 → 监控退化
↑ │
└──────────────────────────────────────────────────────────────┘

### Sprint 7：归因引擎（v0.6.0）

> 对应断裂①：没有自主归因能力。没有归因，所有后续改进都是盲目的。

- [ ] `agint-diagnosis` 插件：
  - [ ] 失败轨迹回放：重放失败任务的完整推理链
  - [ ] 因果标注：对每个失败节点标注根因类别
    - `PROMPT_DEFICIENCY` → prompt 表述不够精确
    - `TOOL_GAP` → 缺少必要工具
    - `KNOWLEDGE_GAP` → 知识库中缺少关键信息
    - `REASONING_ERROR` → 推理链逻辑错误
    - `PLANNING_FAILURE` → 任务分解策略不当
    - `ENVIRONMENT_SHIFT` → 外部环境变化导致失效
  - [ ] 反事实模拟：用修改后的策略重跑失败任务
  - [ ] 根因聚类：将多次失败的根因聚合为"能力缺口"
- [ ] 最小可行版：先支持 `PROMPT_DEFICIENCY` 和 `TOOL_GAP` 两类根因，用最近 10 次失败任务验证归因准确率
- [ ] 归因结果自动写入 `agint-evolution-memory`
- [ ] eval 场景：≥ 10 个归因准确率测试

**验收标准**：失败任务自动标注根因类别 ≥ 4 种；反事实模拟成功率 ≥ 70%

### Sprint 8：变异构造器（v0.6.1）

> 对应断裂②：没有假说生成与变异构造。没有构造能力，"改进提案"永远停留在纸面上。

- [ ] `agint-mutator` 插件：
  - [ ] 变异类型：
    - `PROMPT_MUTATION` → 修改现有 skill 的 prompt
    - `TOOL_SYNTHESIS` → 生成新的工具/插件代码
    - `STRATEGY_REWRITE` → 重写任务分解策略
    - `PIPELINE_REORDER` → 调整 D-QAF 流水线顺序/参数
    - `ARCHITECTURE_PATCH` → 修改插件间的交互方式
  - [ ] 变异约束：
    - 每次变异只改一个组件（原子性）
    - 变异必须附带"预期效果"声明（可被 D-QAF 证伪）
    - 变异必须附带"回滚条件"
  - [ ] 变异来源：
    - 基于归因结果的定向变异
    - 基于梦境整合的随机探索
    - 基于进化记忆中失败模式的反向变异
- [ ] 变异输出格式与 `agint-quality-contract` FROZEN 契约对齐
- [ ] 变异体自动进入 D-QAF 流水线（Phase 1 → Phase 2 → Phase 3）

**验收标准**：支持 Prompt/Tool/Strategy 三类变异；每次变异附带预期效果 + 回滚条件

### Sprint 9：种群管理器（v0.6.2）

> 对应断裂③：没有种群与选择压力。这是最根本的缺失——没有种群，就没有选择；没有选择，就没有进化——只有"改良"。

- [ ] `agint-population` 插件（简化版）：
  - [ ] 变体库：每个变体 = 一组 (prompt, tools, strategy, rules) 的快照
  - [ ] 变体谱系树：记录谁从谁变异而来
  - [ ] 适应度历史：HARM 分数序列
  - [ ] 选择机制：
    - 锦标赛选择：K 个变体在同一任务上竞争
    - 精英保留：top-N 变体永远不被淘汰
    - 多样性保护：防止种群收敛到单一策略
  - [ ] 淘汰机制：连续 M 轮适应度低于阈值 → 淘汰
- [ ] 简化起步：先用"当前生产变体 + 1 个定向变异 + 1 个随机变异"三变体锦标赛
- [ ] 利用 DSH 的插件热插拔能力，每个"变体"就是一组不同的插件配置
- [ ] 被淘汰变体的"失败教训"写入进化记忆

**验收标准**：维护 3-5 个变体并行评估；锦标赛选择 + 精英保留机制跑通

### Sprint 10：安全与性能收口（v0.6.3 - v0.6.4）

- [ ] 静态检查增强（`agint-quality-static-*` 全面升级）：
  - [ ] 原"老板拍板 v0.4 不做"项正式落地
  - [ ] 沙箱 seccomp/AppArmor 配置（syscall 白名单）
  - [ ] 沙箱自由度分级：`verify`（当前模式，严格约束）+ `explore`（新增，宽松约束但网络/文件系统完全隔离）
  - [ ] 变异构造器的输出默认进 `explore` 沙箱，通过后再进 `verify` 沙箱
- [ ] 进化记忆异步批量写入：
  - [ ] `EvolutionLogBuffer`：buffer + flush（≥10 条或 ≥5s 触发）
  - [ ] 高频评估期 I/O 降低 ≥ 3x
- [ ] Prompt-A/B 测试基础设施（Phase 5.2）
- [ ] 回滚操作增加事务语义（原子快照 + 回滚后 smoke test + 失败恢复）

**验收标准**：syscall 白名单落地；进化记忆写入性能提升 ≥ 3x；沙箱双模式可用

### P6 评估集

- [ ] 每个新插件（diagnosis / mutator / population）至少 10 个回归用例
- [ ] 端到端测试：`失败 → 归因 → 变异 → 沙箱验证 → 选择 → 部署/回滚` 完整闭环
- [ ] 种群竞争测试：3 变体在同一任务上的锦标赛结果可复现

### P6 哲学对齐检查

- [ ] 简洁：每个新插件净增代码 ≤ 300 行（diagnosis/mutator 允许放宽至 400 行，需附理由）
- [ ] 安全：所有变异必须经过 D-QAF Phase 1-3 才能进入种群
- [ ] 真实：归因结果必须展示原始失败轨迹，不允许美化
- [ ] 靠谱：每个变异附带回滚条件，种群管理器支持一键回退到任意历史变体
- [ ] 主动：归因覆盖率低于阈值自动告警

---

## P7：自我认知 + 自主课程 + 社区化（v0.7）📋 Planned

> **定位**：解决进化方向盲目性和驱动力缺失问题，同时启动社区化。
>
> **前置条件**：P6 进化闭环引擎稳定运行 ≥ 4 周；归因覆盖率 ≥ 80%；变异成功率 ≥ 15%。

### Sprint 11：自我模型（v0.7.0）

> 对应断裂⑤：没有自我模型。没有自我认知，进化方向是随机的。

- [ ] `agint-self-model` 插件：
  - [ ] 能力图谱：
    - 我能做什么（已验证的能力清单）
    - 我不能做什么（已确认的能力边界）
    - 我不确定能不能做（未探索区域）
    - 每个能力节点的置信度和最后验证时间
  - [ ] 推理模式画像：
    - 我倾向于什么样的推理策略
    - 我在什么条件下容易犯错
    - 我的推理链通常在哪里断裂
    - 我的"认知偏见"是什么
  - [ ] 资源感知：
    - 上下文窗口限制
    - 工具调用成本
    - 响应延迟特征
    - 知识截止边界
  - [ ] 模型更新：
    - 每次任务完成后更新能力图谱
    - 每次失败后更新推理模式画像
    - 定期校准（防止自我模型与现实脱节）

### Sprint 12：自主课程生成器（v0.7.1）

> 对应断裂④：没有自主挑战生成。进化的驱动力是环境压力，没有新挑战就没有进化动力。

- [ ] `agint-curriculum` 插件：
  - [ ] 能力边界探测：
    - 基于自我模型的成功/失败分布
    - 识别"刚好在能力边缘"的任务类型
    - 生成略高于当前能力的挑战
  - [ ] 挑战类型：
    - 已知领域的更深问题（深度）
    - 相邻领域的新问题（广度）
    - 对抗性挑战（鲁棒性）
    - 组合性挑战（整合能力）
  - [ ] 难度调节：
    - 连续成功 → 提升难度
    - 连续失败 → 降低难度或拆解子目标
    - 停滞 → 切换领域或引入随机扰动
  - [ ] 挑战来源：
    - 自动生成（基于能力模型）
    - 从进化记忆中的失败模式反向构造
    - 从外部基准测试集中采样

### Sprint 13：跨域迁移（v0.7.2）

> 对应断裂⑦：没有跨域迁移。在区块链领域学到的策略不能迁移到投研领域。

- [ ] `agint-transfer` 插件：
  - [ ] 策略抽象：将领域特定策略抽象为领域无关的模式
  - [ ] 迁移匹配：检索其他领域的抽象策略，评估结构相似度
  - [ ] 迁移验证：迁移后的策略必须经过 D-QAF 验证
  - [ ] 迁移成功/失败都写入进化记忆

### Sprint 14：社区化（v0.7.3）

> 原 P5 社区化内容 + 插件市场。

- [ ] 插件接口契约形式化描述（OpenAPI / JSON Schema）
- [ ] 插件 SDK + 模板生成器：`dsh plugin init --name my-eval`
- [ ] 3 个官方示例 Plugin（静态检查 / 沙盒测试 / HARM 评分）
- [ ] "外部贡献者成功提交一个合规 Plugin 并通过 CI"
- [ ] Plugin Registry / Marketplace
- [ ] `CONTRIBUTING.md` + issue template
- [ ] CHANGELOG.md 自动生成
- [ ] 选 1-2 个社区贡献者跑通流程

### P7 其他推进项

- [ ] 真沙箱后端：生产用 `dsh-sandbox-local`（替代 in-process fallback）
- [ ] 跨平台 install 验证（Sprint 1.6 跳过项）
- [ ] 预算对齐：Phase 3 有效进化增量校验
- [ ] A/B 流量切分
- [ ] 每周 ≤ 3 次自动部署护栏接入 weekly hook

### P7 哲学对齐检查

- [ ] 自我模型更新不改变 HARM 权重（自我认知 ≠ 自我修改）
- [ ] 自主课程生成的挑战必须可被 D-QAF 验证
- [ ] 跨域迁移后的策略不继承原领域的安全豁免

---

## P8：元进化 + 多 Agent 协同（v0.8+）⏳ Deferred

> **定位**：L5 层能力。仅在 P6-P7 稳定运行 ≥ 3 个月后启动。
>
> **核心原则**：元进化是最高级但也最危险的能力。进化过程改进自身时，必须施加比对象进化更严格的约束。

### Sprint 15：元进化引擎（v0.8.0）

> 对应断裂⑥：没有元进化。Agent 不能改进自己的进化过程。

- [ ] `agint-meta-evolution` 插件：
  - [ ] 进化过程监控：
    - 每轮进化周期的"进化效率"（改进量 / 时间成本）
    - 变异成功率（多少变异被保留）
    - 归因准确率（归因后修改是否真的解决了问题）
    - 探索-利用比（多少资源用于探索 vs 利用）
  - [ ] 进化策略调整：
    - 变异成功率低 → 增大变异幅度或改变变异方向
    - 归因准确率低 → 改进归因方法
    - 探索不足 → 增加随机变异比例
    - 利用不足 → 增加精英保留比例
    - 进化停滞 → 触发"大突变"（架构级重构）
  - [ ] HARM 权重自适应：
    - 根据进化历史动态调整 H, A, R, M 的权重
    - 例：近期进化主要来自"简化"（R），则降低 R 权重，鼓励其他方向
- [ ] **元进化硬约束**：
  - [ ] 元进化本身也需要经过 D-QAF 验证
  - [ ] 元进化的修改频率 ≤ 对象进化频率的 1/5（防止振荡）
  - [ ] 元进化有独立的回滚点
  - [ ] 元进化不修改 FROZEN 契约
  - [ ] 元进化不修改安全护栏参数

### Sprint 16：多 Agent 协同进化（v0.9+）

- [ ] 多 Agent 协同进化场景（共享环境 + 竞争合作 + 群体涌现）
- [ ] CI / 自动化测试

### P8 哲学对齐检查

- [ ] 元进化不违反五条黄金准则中的任何一条
- [ ] 元进化的"进化效率"度量本身不包含元进化自身的改进（防止自指悖论）
- [ ] 多 Agent 协同中的"群体涌现"必须可归因到个体行为

---

## 不做的事

- 不 fork dsh
- 不在 AGINT 仓里放 runtime 数据
- 不追求大而全的 AGI 路线图——AGINT 是工程化骨架，不是宣言
- 不预设 AGI 时间表
- 不引入新的架构层——所有改进都必须在现有插件化架构内完成（来自 `DSH自进化系统整体优化改进方案.md` 核心原则）
- 不修改 L0-frozen 字段（除非走人类多签 + CI 禁改）
- **不在 P6 之前引入元进化**（防止进化过程振荡）
- **不在沙箱内施加与沙箱外相同的安全约束**（沙盒内允许激进探索，`explore` 模式）
- **不追求单体最优解**——种群多样性 > 单变体极致优化
- **不让适应度函数成为唯一目标**（HARM 是信号不是目的，保留人工否决权）
- **不在归因覆盖率 ≥ 80% 之前启动自动变异**（防止盲目变异）

---

## 节奏

### 周节奏

| 时间 | 任务 |
|------|------|
| 周日 03:00 | `night-dream` job 跑梦境 light→REM→deep |
| 周日 04:00 | `metrics-collect` job 采集快照 |
| 周日 04:30 | `agint-quality-eval` 批量评估所有 AGINT Skills + Plugins |
| 周日 18:00 | `evolve-review` job 写复盘报告 |
| 复盘后 | 老板过复盘报告，决定哪些 proposal 进 backlog |

### 版本节奏

- 插件接口稳定才发 minor
- 破坏性变更发 major
- L0-frozen 字段变更需要发 major + 人类多签

### 文档节奏

- 每次 plugin README 改动同步更新 `docs/architecture.md`
- 每次 ROADMAP 调整同步更新 `docs/evolution-framework.md`
- 每次新增 plugin 同步更新 `docs/plugins/agint-*.md`

---

## 进化健康度护栏（`§5.4 五大建议 #4`）

### 基础指标（v0.4 已有）

| 指标 | 阈值 | 触发动作 |
|------|------|----------|
| 每周自动部署次数 | ≤ 3 次 | 超限 → 强制进入人工审核队列 |
| 进化回滚率 | ≤ 20% | 连续 3 周超限 → 暂停自动部署 |
| 人工干预率 | ≤ 30% | 连续 3 周超限 → 评估是否过度工程 |
| HARM 趋势 | 4 周滑动平均 ≥ 上月 95% | 低于 → 触发 `baseline-regression-suite` 跑分 |
| 基线测试通过率 | ≥ 95% | 下降 → 立即冻结进化并告警 |

### 进化闭环专属指标（P6 新增）

| 指标 | 阈值 | 触发动作 |
|------|------|----------|
| 归因覆盖率 | ≥ 80% | 低于 → 暂停自动变异，进入人工归因校准 |
| 变异成功率 | ≥ 15% | 连续 4 周低于 → 触发 meta-evolution 调整变异策略（P8 之前由人工调整） |
| 种群多样性指数 | ≥ 0.3 | 低于 → 强制注入随机变异或切换探索领域 |
| 自我模型校准误差 | ≤ 10% | 高于 → 触发能力图谱全量重评估（P7 起生效） |
| 自主挑战完成率 | 40%-70% | <40% → 降低难度；>70% → 提升难度（P7 起生效） |

---

## 哲学锚点护栏（`§5.5 五大建议 #5`）

每个 P 阶段验收必须显式包含哲学对齐检查，详见 `docs/evolution-philosophy-checkpoints.md`：

- **简洁 > 冗余**：新增代码行数 / 功能点数 ≤ 阈值（每新增功能 ≤ 200 行净增；P6 归因/变异引擎放宽至 400 行，需附理由）
- **安全 > 效率**：所有性能优化提案必须附带安全影响分析
- **真实 > 讨好**：评估报告禁止隐藏失败案例，必须展示原始数据
- **靠谱 > 聪明**：行为可预期 > 一次惊艳；变更可回滚 > 一步到位
- **主动 > 被动**：隐患看见了就动手；重复任务第二次就自动化

### 进化闭环张力平衡检查点（P6 新增）

> AGINT 的哲学锚点是"美"（简洁、真实、靠谱、主动、安全），但进化的本质是"变异"（随机、冗余、冒险、打破常规）。以下检查点用于平衡这一张力：

- **探索 > 利用**：每轮进化周期中，随机变异占比 ≥ 20%（防止过早收敛）
- **冗余 > 简洁（仅限沙盒内）**：种群变体数 ≥ 3；沙盒外仍遵循简洁原则
- **失败 > 成功（仅限进化记忆）**：`failure_pattern` 写入优先级 > `success_template`
- **可证伪 > 可解释**：每个变异必须附带可被 D-QAF 证伪的预期效果声明

---

## 哲学锚点

任何争议回到 `PHILOSOPHY.md`：

- 简洁 > 冗余
- 真实 > 讨好
- 靠谱 > 聪明
- 主动 > 被动
- 安全 > 效率

---

## 自进化能力层次参照（P6 新增）

> 来源：Schmidhuber 97 页综述 / Darwin Gödel Machine (ICLR 2026) / AlphaEvolve / Red Queen Gödel Machine

| 层次 | 能力 | AGINT 现状 | 对应阶段 |
|------|------|-----------|----------|
| L0 | 静态执行 | ✅ 已超越 | — |
| L1 | 反应式适应（记忆、反思、规则） | ✅ 已具备 | P0-P2 |
| L2 | 结构化自改进（评估、指标、复盘） | ✅ 已具备 | P3-P5 |
| **L2→L3** | **归因 + 变异构造** | ❌ **断裂** | **P6** |
| L3 | 自主代码生成（自己写插件并部署） | ⚠️ DSH 支持但 AGINT 未利用 | P6 |
| L4 | 架构自修改（重新设计自身组件） | ❌ 未涉及 | P7 |
| L5 | 元进化（改进进化过程本身） | ❌ 未涉及 | P8 |
| L6 | 开放式进化（无目标涌现） | ❌ 理论极限 | 不可达 |
