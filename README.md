<div align="center">
  <img src="docs/assets/brand/png/agint-logo-512.png" width="300" alt="AGINT">
</div>

# AGINT

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

**v0.9.0** · 37 个 Cordis 插件 · 4 套 preset · 25 个 preset 工具行。实时运行数字见 [`AGENTS.md`](./AGENTS.md) 文末 LOCAL-STATE 块。

AGINT = **AGI INTelligence**。把 dsh 当 runtime，在其之上构建持续自进化能力：长期记忆、定时反思、规则门禁、进化指标、D-QAF 质量评估、自进化执行层。

## 设计哲学

> **美是 AGINT 的起源与终极追求**。美 = 简洁 + 真实 + 靠谱 + 主动 + 安全；冲突时取前者，舍冗余、讨好、聪明、被动、效率。

完整论述见 Wiki [PHILOSOPHY](https://github.com/Anmulzhao/DSH-AGINT/wiki/PHILOSOPHY)；工程化检查项见 [`docs/evolution-philosophy-checkpoints.md`](./docs/evolution-philosophy-checkpoints.md)。

## 是什么 / 不是什么

| | |
|---|---|
| 是 | **通往 AGI 的工程化骨架**：记忆、反思、约束、度量、迭代、评估 |
| 不是 dsh 的 fork | dsh 是上游 runtime，AGINT 是 dsh 之上的规范 + 组件 |
| 不是 AGI 实现 | 不承诺智能涌现，只承诺进化机制 |
| 不追求大而全 | 新增功能必须经 D-QAF 评估，并在插件化架构内实现 |

四层结构：

| 层 | 内容 | 位置 |
|---|---|---|
| **bundle** | 整体 = 一个 dsh bundle 包 `@agint/host`（所有插件 + 挂载 patch 都在包内） | `package.json` + `cordis.patch.yml` |
| **preset** | 智进人格 + 工具集 + skills。4 套：`agint`（主线）、`agint-blockchain`、`agint-investor`、`agint-ops` | `presets/agint*/` |
| **plugin** | **37 个** Cordis 插件（另有 2 个嵌套在 `agint-quality/` 内不单列：`quality-contract` / `quality-policy`），提供 host Services | `plugins/agint-*/` |
| **data** | 记忆 / 规则 / 指标 / 提案 / 梦境 / 复盘 / 评估历史 | runtime 数据，**不**进仓库 |

## 插件全景（37）

各插件职责与接口见 [`docs/plugins/`](./docs/plugins/)（规范见 [PLUGIN-SPEC](./docs/plugins/PLUGIN-SPEC.md)）。

| 分组 | 插件 |
|---|---|
| **记忆与知识**（4） | `memory` · `wiki` · `memory-provider` · `search-tools` |
| **调度与治理**（4） | `cron` · `rules` · `metrics` · `tool-stats` |
| **反思与进化**（5） | `dream` · `evolve` · `evolution-memory` · `diagnosis` · `curriculum` |
| **D-QAF 质量层**（6 + 2 嵌套） | `quality` · `quality-sdk` · `quality-static` · `quality-sandbox` · `quality-eval` · `quality-report`；嵌套 `quality-contract`（L0 FROZEN 契约）· `quality-policy` |
| **进化闭环引擎**（5） | `mutator` · `population` · `abtest` · `mount` · `evolution-driver`（提案 → 生成编辑 → 幻觉闸门 → 写仓库，端到端闭环） |
| **自进化执行层**（5） | `skill-autocreate` · `curator` · `skill-graph` · `trajectory` · `compress-guard` |
| **观测与呈现**（6） | `self-model` · `event-bus` · `restart` · `session-extract` · `family-panel` · `ov-strategy` |
| **感知与美学**（2） | `input-gateway` · `aesthetic-oracle` |

## 安装

前置：Node.js ≥ 20 · dsh ≥ 0.1.7-rc.1（兼容矩阵见 [`VERSION`](./VERSION)）· dsh 已初始化（`dsh web` 跑过至少一次）。

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh          # 支持 --dry-run；幂等可回滚，备份保留 10 份
```

装完**必须重启 `dsh web`**（bundle 层与 profile 层都不热更新）。卸载：`./install/uninstall.sh`。

三条红线：

1. `npm install -g @deepseek-ai/dsh@latest` 会**静默降级**（`latest` 可能低于在跑版本）。必须带精确版本号。
2. 包内 `node_modules` junction 是指向 dsh 官方包的软链，卸载时**保留**——`rm -rf` 会跟进删掉 266 个包。
3. 装完像没装、零报错，十有八九是没注册进 `dsh.profile.bundles`（安装步骤 3.5）。

排障：`install.sh` 实际步骤与 dsh 坑位见 [`docs/dsh-integration.md`](./docs/dsh-integration.md)；装完崩溃按症状查 `presets/agint/skills/agint-install-bootstrap-rescue/`；容器部署走 [`docker/`](./docker/)。

## 自进化宪法

**D-QAF 四阶段流水线**（静态准入 → 动态沙箱 → 集成演练 → 灰度发布）+ **HARM 四维指标**（Homogeneity / Alignment / Reduction / Mutability）+ **进化记忆层**（区别于任务记忆）。完整论述见 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。

根本原则：**默认自动化，人工审批只作兜底**。门禁尽量下放为可自动验证的规则；新机制一律带 kill-switch，且出厂即开，配齐「默认开 + 降级回落 + 审计出口 + 一键可关」。

## 仓库自检

改完插件先跑 `check-wiring`（通电），再跑 `check-dsh-compat`（兼容）。

| 命令 | 查什么 |
|---|---|
| `node bin/check-dsh-compat.mjs` | dsh 兼容性四查：悬挂包名 / peer 预演 / 版本漂移 / 改名残留。`--json` 给 CI，`--strict` 让 info 也算失败 |
| `node bin/check-wiring.mjs` | 接线完整性九查：空壳服务 / 主题接线 / 存储域通电 / 双副本一致性等——「挂载了」≠「通电了」 |
| `node bin/check-tool-schemas.mjs` | tool schema 两套方言真编译一遍（写错会让整条 preset 起不来） |
| `node bin/check-memory.mjs` | 记忆层自检：K 号真实性 / 目录分裂 / 体积超限 / 引用存在性。`--json` 供 CI |
| `node bin/agents-local-state.mjs` | 探测本机 host 实况并回写 `AGENTS.md` 文末 LOCAL-STATE 自动块 |

`bin/dsh-direct.mjs` 是绕过 Web GUI 直连宿主 API Gateway 的通道工具（HTTP RPC + WS 流），排障用。

## 文档地图

| 想看什么 | 去哪 |
|---|---|
| 运行现状（真实数字） | [`AGENTS.md`](./AGENTS.md) 文末 LOCAL-STATE 块（自动回写，权威） |
| 运行时架构 / 插件详细 | [`docs/architecture.md`](./docs/architecture.md) · [`docs/plugins/`](./docs/plugins/) |
| dsh 集成边界 / 安装排障 / tool schema 方言 | [`docs/dsh-integration.md`](./docs/dsh-integration.md) · [`docs/dsh-tool-schema-dialects.md`](./docs/dsh-tool-schema-dialects.md) |
| D-QAF / HARM / 进化记忆 | [`docs/evolution-framework.md`](./docs/evolution-framework.md) |
| 安全边界 | [`docs/security-boundary.md`](./docs/security-boundary.md) |
| **已知盲区（先看这个再下结论）** | [`docs/known-limitations/`](./docs/known-limitations/) |
| 运维 SOP / 安全更新 | [`docs/operations/`](./docs/operations/) |
| 踩过的坑（按版本） | [`docs/lessons/`](./docs/lessons/) |
| 评估场景集 | [`eval/scenarios/README.md`](./eval/scenarios/README.md) |
| 路线图 / 变更日志 / PHILOSOPHY | [GitHub Wiki](https://github.com/Anmulzhao/DSH-AGINT/wiki) |

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据/配置根 | `$HOME/.dsh` |
| `AGINT_HOME` | ⚠️ **双语义**：`install.sh` 读它当**源码根**；插件侧读它当**数据根**（dream / wiki / reviews / scenarios 落点） | install 侧自动取脚本上级目录；插件侧 `$HOME/projects/AGINT` |

> 双语义是已知设计（容器里显式拆成 `AGINT_SRC=/opt/agint` + `AGINT_HOME=/persist/agint-data`，见 `docker/entrypoint.sh`）。设错时插件会把数据写进仓库目录。各机制 kill-switch 清单见 [`docs/security-boundary.md`](./docs/security-boundary.md)。

## 许可

MIT
