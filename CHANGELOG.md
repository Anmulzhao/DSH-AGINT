# AGINT CHANGELOG

> 本文件记录 AGINT 仓库每个版本的可观察变更。遵循 [Keep a Changelog](https://keepachangelog.com/) 风格。
>
> **版本节奏**（详见 `ROADMAP.md`）：
> - 插件接口稳定 → 发 minor
> - 破坏性变更 → 发 major
> - L0-frozen 字段变更 → 发 major + 人类多签
>
> **本文件与 git tag 一一对应**：tag message 是简版，CHANGELOG 是详细版。

## [v0.3.1] — 2026-08-21 — D-QAF 端到端流水线接入（P3 收口）

> **里程碑**：v0.3.x 系列收口。D-QAF Phase 2/3/4 流水线接通，`agint-quality-eval` / `agint-quality-sandbox` / `agint-evolution-memory` / `agint-quality-policy` 4 个 plugin 形成端到端反馈环。
> **破坏性变更**：无（向后兼容 v0.3.0）。

### 新增
- **Sprint 3.1** — `agint-quality-eval` Phase 2 调 `agint.qualitySandbox.runSmoke()` 作为 gate（commit `6ddd74d`）
  - sandbox 失败 → 该 target safety=0 → compositeScore=null → REJECT 路径
  - target.path 缺失时跳过 gate（向后兼容 skill 类）
  - 4 个 eval 场景全过
- **Sprint 3.2** — `weeklyTask` 接 3 个新 hook（commit `53a0dbd`）
  - 每个 EvalResult → `evo.logPhase4({targetId, targetKind, decision, scores, findings, tags:['weekly']})`
  - `runBaselineSuite()` → regression 自动触发 `evo.addFailure('regression:<severity>')`
  - `checkStagnation()` → 读 evolution-log 计算增量
  - 4 个 eval 场景全过
- **Sprint 3.3** — rules deny + policy 骨架（commit `64a1405`）
  - `agint-rules` 加 `bash-delete-evolution-log` seed rule（deny / L1 / L0-frozen）
  - 新建 `agint-quality-policy` 骨架 plugin：Service `decide()` 占位
  - safety veto → REJECT，其余 PENDING_REVIEW
  - REJECT → `evo.addFailure(pattern='policy-reject:<decision>')`
  - 任意 decision → `evo.logPhase4(targetKind='composite')`
  - 10 个 eval 场景全过

### 修复
- 修复 `agint-quality-policy` 的 `shouldReportToEvolution` bug：原代码比较 `decision === 'REJECT'`（decision 是 object），改为 `decision?.decision === 'REJECT'`。原 bug 导致 Sprint 3.1 + 3.2 阶段 policy.REJECT 路径从未真正触发 addFailure，Sprint 3.3 修。

### 验证
- **49/49 eval 场景全过**（含 v0.3.0 39 个 + Sprint 3 新 10 个）
- D-QAF 端到端链路打通：eval.sandbox-gate → evaluator.evaluateAll → weeklyTask.logPhase4 → runBaselineSuite → checkStagnation → policy.decide → evo.addFailure

### 已知限制（v0.3.1 未做，留 v0.4）
- **完整 4 决策 + 加权综合分**：policy 当前占位（Sprint 4 升级）
- **反和谐检测器**：定义"伪和谐模式"清单（v0.3 → v0.4 推进项）
- **预算对齐**：Phase 3 加入 `有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)` 校验
- **真沙箱后端**：eval 走 in-process fallback；生产需 `dsh-sandbox-local`
- **端到端测试脚本**：`cron → dream → memory → metrics → evolve → quality-eval` 闭环

### 配套 git tag
```
git tag -a v0.3.1 -m "AGINT v0.3.1 — D-QAF 端到端流水线接入（P3 收口）"
```

---

## [v0.3.0] — 2026-08-20 — 沙箱 + 进化记忆 + 退化探测（P3 主体收口）

> **里程碑**：P3 阶段 v0.3 主体收口。D-QAF Phase 2/3 关键机制落地。
> **破坏性变更**：无（向后兼容 v0.2.x）。

### 新增
- **`agint-evolution-memory` plugin**（commit `bbe5ed5`，物理隔离的进化记忆层）
  - 独立 storage domain `agint_evolution`（三表 `evolution_log` / `failure_pattern` / `success_template`）
  - Service 接口：`logPhase4 / addFailure / addSuccess / queryFailures / queryTemplates / getLogRange / decayScanRun / stats`
  - L1-L4 衰减（纯复制 `agint-memory/lib/decay.js`，老板拍板"纯复制定制化"）
  - 上限：failure 100 / template 50，超限 warn 不自动 prune
  - 检索：线性扫 + lowercase substring（老板拍板，<100 条足够）
- **`agint-quality-sandbox` plugin**（commit `bf67263`，D-QAF Phase 2 动态沙箱）
  - 桥接 dsh `ctx.sandbox` 服务（生产用 bwrap/Landlock/Seatbelt）
  - 两条路径：真沙箱（生产 dsh 启动）+ In-process fallback（dev/CI/eval）
  - 资源限制：timeout 30s / memory 512MB（ROADMAP P3 §沙箱 限定）
  - 6 项冒烟脚本（lib/smoke.js）：plugin-exists / package-json-parses / package-json-esm / main-file-exists / plugin-exports / no-external-network
  - 失败自动上报 `agint.evolution.addFailure(pattern='sandbox-smoke-failed:<reason>')`
- **退化探测**（commit `3d22a1d`，`agint-quality-eval` 扩展）
  - 4 级 severity：`ok / warn@2% / high@10% / blocker@25%`
  - 4 个 Service 方法：`runBaselineSuite / setBaseline / getBaseline / checkStagnation`
  - 9 个固定 baseline target（memory/rules/metrics/cron/dream/evolve/wiki/tool-stats/quality-contract）
  - 停滞检测：最近 K-1 个 delta（K=5）全 < 0.5 → isStagnated
  - 告警写 `evo.addFailure(pattern='regression:<severity>', tags=['freeze'])`

### 验证
- **31/31 eval 场景全过**（含原 v0.2.0 25 个 + 新 6 个 regression）
- `agint-evolution-memory` 7 场景：log/dedupe/search/template/decay/isolation/stats
- `agint-quality-sandbox` 5 场景：service-shape / fallback / 不存在 / 缺 path / health
- 退化探测 6 场景：4 级 severity / active-growth / detected / insufficient-data / passrate / baseline shape

### 已知限制（v0.3.0 未做，留 v0.3.x 或 v0.4）
- **Sprint 3 接入流水线**（D-QAF 端到端）：
  - `agint-quality-eval` Phase 4 完成 → `evo.logPhase4()` 自动写入
  - `agint-quality-policy` REJECT 决策 → `evo.addFailure()` 自动写入
  - `agint-rules` 的 `delete-evolution-log` deny 规则
  - `agint-evolve` 周复盘的归纳 + 蒸馏自动化
  - `agint-dream` Deep 阶段读 success-templates
- **真沙箱后端**：eval 走 in-process fallback；生产 dsh 启动需 `dsh-sandbox-local`
- **静态检查**（ROADMAP §5.2 提到的 `agint-quality-static-*`）：老板拍板本 Sprint 不做
- **Sprint 1.6 跨平台验证**：跳过（dev 主机仅 Linux）

### 配套 git tag
```
git tag -a v0.3.0 -m "AGINT v0.3.0 — 沙箱 + 进化记忆 + 退化探测（P3 主体收口）"
```

---

## [v0.2.0] — 2026-08-20 — D-QAF 评估引擎 + 自进化宪法 + install 安全左移

> **里程碑**：P2 阶段 v0.2 收口。评估引擎初版落地、自进化宪法三件套就位、install.sh 安全加固。
> **破坏性变更**：无（向后兼容 v0.1.x）。

### 新增
- **D-QAF 评估引擎初版**（`agint-quality-eval`，commit `4260fdb`）
  - 7 维评分（trust / reliability / effectiveness / safety / integrability + convention/adaptability）
  - 综合分：safety 权重 0.30 一票否决
  - HARM 简版：H/M 中性 0.5；A ≈ trust；R ≈ reliability
  - WeeklyScheduler：每周日 04:30 批量评估，写 `agint.memory`
- **评估场景集基础设施**（`eval/`，commits `2c78e71` + `80216f7`）
  - 5 个核心 plugin 冒烟测试 + 6 个 install 安全属性断言 = 13 场景
  - mock ctx + 5 dispatchers + JSON loader（无 yaml 依赖）
  - `eval/setup.sh`：软链 dsh runtime 到 plugins（dev-only）
  - **13/13 场景通过**
- **自进化宪法三件套**（commit `c9bb648`）
  - `docs/evolution-framework.md`：D-QAF + HARM + 进化记忆层 + 预算对齐 + 退化探测收口
  - `docs/security-boundary.md`：硬约束清单（har_constraints）
  - `docs/evolution-philosophy-checkpoints.md`：哲学锚点工程化检查项
- **install.sh 安全左移**（commit `a6950fa`，§5.2 落地）
  - `install/agint-security-checks.sh`：13 项独立安全检查（path 9 + runtime 4）
  - `rsync --no-links` + exclude 列表（防 node_modules 软链污染 `$DSH_HOME`）
  - 中央备份 `$DSH_HOME/.agint-backups/` + 保留 10 个
  - trap EXIT + partial-install 回滚栈
  - 装后静态校验（YAML 解析 / package.json / agent.cordis.yml）
  - `uninstall.sh --list-backups` / `--restore` / `--purge-backups`
- **Plugin 改进**
  - `agint-cron`：cron_list 输出改 host 本地时区 ISO
  - `agint-dream`：启动时从 diary mtime 恢复 lastSweep

### 修复
- dream sweep 阈值：0.5/1/1 → 0.75/3/2（与 OpenClaw 对齐，更严）
  - 决策凭据见 memory:dream-sweep-threshold-2026-08
- dream 阈值原 commit message 引用未沉淀日期 → 配套 `docs/lessons/v0.2-sweep-threshold-decision.md`（commit `90fe47b`）
- ROADMAP checkbox 撤销乐观勾选（"文档落地 ≠ 机制可用"，commit `cf7de2c`）
- AGENTS.md "哲学对齐检查" 规则拆两层（PR 必含 / 复盘报告推荐，commit `89acf34`）

### 文档
- `docs/lessons/v0.1-install-and-load-bugfixes.md`（v0.1 三个 install bug 的排查实录）
- `docs/lessons/v0.2-sweep-threshold-decision.md`（sweep 阈值决策凭据澄清）
- `docs/lessons/v0.2-install-security.md`（install 安全左移设计取舍）
- `ROADMAP.md`：v0.2 落地状态对齐（repo 名 / 退化探测归属 / 评估集说明）
- `README.md`：plugin 数 9 → 10，加 D-QAF 评估说明
- 全文档同步 v0.2：AGENTS.md + architecture.md + 9 个 plugin README

### 已知限制（不在 v0.2.0 范围）
- `agint-quality-policy` / `agint-quality-sandbox` / `agint-quality-report`（v0.3+ 推进）
- 进化记忆层（v0.3 引入）
- 退化探测 / 预算对齐机制（v0.3 验证）
- `eval/scenarios/` 仍不含 `agint-quality-eval` 自身场景（老板拍板：留 Sprint 1.4 用合成候选）
- `uninstall.sh` 仍把 `agint-quality-eval` 当独立顶层 plugin 删（沿用 v0.1 逻辑）
- 跨平台 install 验证（Sprint 1.6 跳过，dev 主机仅 Linux）

### 验证
- **eval/scenarios：13/13 通过**（5 plugin 冒烟 + 6 install 安全 + 2 metrics cron 双场景）
- `agint-quality-eval` 已在 dev 主机加载并写首次评估快照
- install --dry-run 全链路通过；agint-security-checks.sh --strict 退出码 0
- 同步 memory 决策：dream-sweep-threshold-2026-08 / amend-old-commit-risky-in-current-env

### 配套 git tag
```
git tag -a v0.2.0 -m "AGINT v0.2.0 — D-QAF 评估引擎初版 + 自进化宪法 + install 安全左移"
git tag -a v0.1.2 -m "AGINT v0.1.2 — install.sh 整段重建法"
git tag -a v0.1.1 -m "AGINT v0.1.1 — D-QAF evaluation contract"
git tag -a v0.1.0 -m "AGINT v0.1.0 — self-evolution framework (8 plugins, 3 presets, 1 patch)"
```

---

## [v0.1.2] — 2026-08-18 — install.sh 整段重建法

修复 v0.1.0/v0.1.1 的 install.sh「按 id 存在性跳过」bug：
- 老 id 段被跳过，导致新内容无法注入 dsh
- AGINT 仓库与 dsh 跑的 patch 长期分叉
- 第 9 插件（D-QAF）始终进不去

改为「整段重建」+ substring 幂等判断。

验证：
- install 后 9 个 agint.* Service 全加载（probe 实测）
- 二次 install 完全幂等（dst 已含 src_text 副本则跳过）

## [v0.1.1] — 2026-08-18 — D-QAF evaluation contract

新增：agint-quality-contract（D-QAF FROZEN 层契约）
增强：agint-rules 的 frozenness 字段、agint-tool-stats 的 C-HARM 数据
文档：docs/plugins/agint-quality.md + 两份融合方案归档

实现层（agint-quality-{eval,policy,sandbox,report}）留待 v0.2+ 推进。

## [v0.1.0] — 2026-08-18 — AGINT 自进化框架初版

迁移完成。8 个 Cordis 插件 + 3 个 preset + 1 个 patch + 顶层文档 + install 脚本，可安装可运行。
