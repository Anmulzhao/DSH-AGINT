# AGINT CHANGELOG

> 本文件记录 AGINT 仓库每个版本的可观察变更。遵循 [Keep a Changelog](https://keepachangelog.com/) 风格。
>
> **版本节奏**（详见 `ROADMAP.md`）：
> - 插件接口稳定 → 发 minor
> - 破坏性变更 → 发 major
> - L0-frozen 字段变更 → 发 major + 人类多签
>
> **本文件与 git tag 一一对应**：tag message 是简版，CHANGELOG 是详细版。

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
