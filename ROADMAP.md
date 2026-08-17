# ROADMAP.md — AGINT 进化路线

> 从「散落的 dsh patch」到「可独立版本化的自进化框架」。

## 当前状态：v0（迁移完成）

**已有**：
- 8 个 Cordis 插件（memory / wiki / cron / dream / rules / metrics / evolve / tool-stats）
- 3 个 preset（agint / agint-coder / agint-investor）
- 1 个 profile-patch（web/cordis.patch.yml）
- 4 个 skill（causal-reasoning / editing-cordis-compositions / memory-discipline / cordis-plugin-development）
- 顶层文档（README / AGENTS / PHILOSOPHY / VERSION）

**没有**：
- CI / 自动化测试（dsh 上游变更时手动适配）
- 安装脚本以外的部署工具
- 评估集（eval/ 是占位）

## P1：仓库成型（v0.1）

- [ ] `install/install.sh` + `install/uninstall.sh` 可执行、可回滚
- [ ] `.gitignore` 排除 runtime 数据（storages / dreams / wiki / reviews）
- [ ] 每个插件一份 `docs/plugins/agint-*.md`：设计意图 / Service 契约 / 存储 schema / 与其他插件关系
- [ ] 首版 git tag `v0.1.0`
- [ ] 推到 `github.com/anmul/AGINT`

## P2：可移植性（v0.2）

- [ ] `cordis.patch.yml` 的 `$HOME` 默认值在不同平台（macOS / Linux / WSL）下测过
- [ ] `VERSION` 写明 dsh 兼容矩阵；CI 在 dsh 最新 release 上跑插件 test
- [ ] 把 `AGINT_HOME` / `DSH_HOME` 概念写进安装脚本
- [ ] 提供 `install/docker-compose.yml` 演示（可选）

## P3：评估（v0.3）

- [ ] `eval/scenarios/`：每个插件一个回归用例（输入 → 期望 Service 行为）
- [ ] 端到端测试：从 `cron` 触发 → `dream` sweep → `memory` 提升 → `metrics` 采集 → `evolve` 复盘的闭环
- [ ] 用例可被 dsh headless 跑：`dsh --profile headless "..."`

## P4：社区化（v0.4+）

- [ ] CONTRIBUTING.md：插件接口契约、命名规范、PR 流程
- [ ] CHANGELOG.md 自动生成
- [ ] 公开 issue template：`bug` / `feature:plugin-*` / `doc`
- [ ] 选 1-2 个社区贡献者跑通流程

## 不做的事

- 不 fork dsh
- 不在 AGINT 仓里放 runtime 数据
- 不追求大而全的 AGI 路线图——AGINT 是工程化骨架，不是宣言
- 不预设 AGI 时间表

## 节奏

- **周节奏**：周日 cron `evolve-review` 跑自动复盘；老板过一眼，决定哪些 proposal 进 backlog
- **版本节奏**：插件接口稳定才发 minor；破坏性变更发 major
- **文档节奏**：每次 plugin README 改动同步更新 `docs/architecture.md`

## 哲学锚点

任何争议回到 `PHILOSOPHY.md`：
- 简洁 > 冗余
- 真实 > 讨好
- 靠谱 > 聪明
- 主动 > 被动
- 安全 > 效率