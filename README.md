# AGINT

> 基于 DeepSeek Harness (dsh) 的自进化智能体框架。原 OpenClaw 版 AGINT 迁移到 dsh 后的规范化版本。

AGINT = **AGI INTelligence**，把 dsh 当 runtime，在它之上构建一套「持续自进化」的能力：长期记忆、定时反思、规则门禁、进化指标、周复盘、梦境整合。

## 不是什么

- 不是 dsh 的 fork。dsh 是上游 runtime，AGINT 是 dsh 之上的规范 + 组件。
- 不是 AGI 实现。它是**通往 AGI 的工程化骨架**：记忆、反思、约束、度量、迭代。

## 是什么

| 层 | 内容 | 来源 |
|---|---|---|
| **preset** | 智进人格 + 工具集（含 4 个 AGINT 专属 skills） | `presets/agint/` |
| **plugin** | 9 个 Cordis 插件，提供 AGINT 专属 host Services（含 D-QAF `agint-quality-contract`） | `plugins/agint-*/` |
| **patch** | 把 8 个插件挂入 dsh profile 的 user-patch 层 | `profile-patches/web/cordis.patch.yml` |
| **data** | 长期记忆 / 规则 / 指标 / 提案 / 工具统计 / 梦境 / 复盘 | runtime 数据，**不**进仓库 |

## 仓库结构

```
AGINT/
├── README.md                    你正在看
├── AGENTS.md                    给 AGINT agent 自己读的工作守则
├── PHILOSOPHY.md                设计哲学：美是起源与终极追求
├── ROADMAP.md                   进化路线 P0→P1→P2→P3→P4
├── VERSION                      兼容 dsh 版本表
├── LICENSE                      MIT
│
├── presets/                     ── dsh agent-presets/
│   ├── agint/                   智进主 preset（含 4 个 skills）
│   ├── agint-coder/             派生：编程专用
│   └── agint-investor/          派生：投研专用
│
├── plugins/                     ── dsh profile plugins/
│   ├── agint-memory/            P1 长期记忆四层遗忘
│   ├── agint-wiki/              知识库
│   ├── agint-cron/              定时任务
│   ├── agint-dream/             夜间梦境 light→REM→deep
│   ├── agint-rules/             规则门禁
│   ├── agint-metrics/           进化指标
│   ├── agint-evolve/            周复盘 + 改进提案
│   ├── agint-tool-stats/        工具使用画像
│   └── agint-quality/           D-QAF 评估框架（v0.1.1 仅 contract；eval/policy/sandbox/report 留待 v0.2+）
│       └── agint-quality-contract/
│
├── profile-patches/             ── dsh user-patch 层
│   └── web/cordis.patch.yml     把 8 个插件挂入 dsh web profile
│
├── docs/                        设计文档 / 架构图 / 插件契约
│   ├── plugins/                 每个插件一个 README
│   └── lessons/                 经验教训归档(踩坑实录 + 修复方案 + 教训)
│       └── *.md
│
├── eval/                        评估集（占位）
└── install/                     安装/卸载脚本
```

## 安装

### 前置

- Node.js ≥ 20
- `@deepseek-ai/dsh` ≥ 0.1.0-rc.6（参见 `VERSION`）
- dsh 已初始化（`dsh web` 至少跑过一次，会自动建 `$DSH_HOME`）

### 装到本机

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh
```

`install.sh` 做三件事：
1. 把 `presets/agint/` 复制到 `$DSH_HOME/.agent-presets/agint/`（已存在则备份为 `agint.bak-<timestamp>`）
2. 把 `plugins/agint-*/` 复制到 `$DSH_HOME/profiles/web/plugins/`
3. 把 `profile-patches/web/cordis.patch.yml` 合并到 `$DSH_HOME/profiles/web/cordis.patch.yml`（已存在则备份 + 合并 agint-* insert 段）

**安装后必须重启 dsh web**（user-patch 层不热更新）。

### 卸载

```sh
./install/uninstall.sh
```

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据/配置根 | `$HOME/.dsh` |
| `AGINT_HOME` | AGINT workspace（dream/wiki/reviews 落点） | `$HOME/projects/AGINT` |

`AGINT_HOME/dreams/`、`AGINT_HOME/wiki/`、`AGINT_HOME/reviews/` 由 agint-dream / agint-wiki / agint-evolve 自动创建。

## 与 dsh 的关系

- **AGINT 依赖 dsh**，不 fork dsh、不修改 dsh 源码
- 所有 AGINT 能力走 dsh 的「user-patch 层」+「agent-preset 层」注入
- dsh 主线升级后跑 `install/uninstall.sh` 重装即可
- dsh API 变更会在 CI 中暴露（计划中）

## 状态

- **v0.1.0**（2026-08）：迁移完成。8 个插件 + 3 个 preset + 1 个 patch 已就位，可安装可运行。
- **v0.1.1**（2026-08）：新增 D-QAF 评估框架 `agint-quality-contract`（仅 Seam 层；eval/policy/sandbox/report 留待 v0.2+）。`agint-rules` 已通过 `frozenness` 字段（提案 a6ba79a3）接入 D-QAF 的 L0/L1/L2 边界概念。

后续路线见 `ROADMAP.md`。

## 许可

MIT