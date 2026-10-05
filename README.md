<div align="center">
  <img src="docs/assets/brand/png/agint-logo-512.png" width="300" alt="AGINT">
</div>

# AGINT

[English](README.en.md) | 中文

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

**v0.11.0** · 38 个 Cordis 插件 · 4 套 preset · 25 个工具行。实时运行数字见 [`AGENTS.md`](./AGENTS.md) 文末 LOCAL-STATE 块。

- **哲学**：美 = 简洁 + 真实 + 靠谱 + 主动 + 安全；冲突时取前者。论述见 Wiki [PHILOSOPHY](https://github.com/Anmulzhao/DSH-AGINT/wiki/PHILOSOPHY)。
- **定位**：dsh 是上游 runtime，AGINT 是其上的规范 + 组件，不是 fork；不是 AGI 实现，是通往 AGI 的工程化骨架（记忆 / 反思 / 约束 / 度量 / 评估）；新增功能必须经 D-QAF 评估。
- **宪法**：D-QAF 四阶段流水线 + HARM 四维指标 + 进化记忆层，见 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。默认自动化，人工审批只作兜底；新机制一律带 kill-switch，出厂即开、配齐降级回落与审计出口。

## 四层结构

| 层 | 内容 | 位置 |
|---|---|---|
| **bundle** | 整体 = dsh bundle 包 `@agint/host`（全部插件 + 挂载 patch） | `package.json` + `cordis.patch.yml` |
| **preset** | 智进人格 + 工具集 + skills，4 套：`agint`（主线）、`agint-blockchain`、`agint-investor`、`agint-ops` | `presets/agint*/` |
| **plugin** | 38 个 Cordis 插件，8 组（记忆 / 调度 / 反思 / 质量 / 闭环 / 执行 / 观测 / 感知），清单见 [`docs/plugins/`](./docs/plugins/) | `plugins/agint-*/` |
| **data** | 记忆 / 规则 / 指标 / 梦境 / 复盘 | runtime 数据，不进仓库 |

## 安装

前置：Node.js ≥ 20 · dsh ≥ 0.1.7-rc.1（矩阵见 [`VERSION`](./VERSION)）· `dsh web` 跑过至少一次。

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh          # --dry-run 支持；幂等可回滚
```

装完**必须重启 `dsh web`**（bundle 与 profile 层不热更新）。卸载 `./install/uninstall.sh`。

三条红线：

1. 升级 dsh 必须带精确版本号——`npm i -g @deepseek-ai/dsh@latest` 会静默降级。
2. 包内 `node_modules` junction 是指向 dsh 官方包的软链；`rm -rf` 会跟进删包，卸载时必须保留。
3. 装完像没装、零报错，十有八九是没注册进 `dsh.profile.bundles`（安装步骤 3.5）。

更多排障见 [`docs/dsh-integration.md`](./docs/dsh-integration.md)；容器部署走 [`docker/`](./docker/)。

## 仓库自检

改完插件必跑两步：`node bin/check-wiring.mjs`（接线通电）→ `node bin/check-dsh-compat.mjs`（dsh 兼容）。其余自检（tool schema / 记忆层 / LOCAL-STATE 回写）用法见 `bin/` 下脚本。

## 文档地图

| 想看什么 | 去哪 |
|---|---|
| 运行现状（真实数字，权威） | [`AGENTS.md`](./AGENTS.md) 文末 LOCAL-STATE 块 |
| 架构 / 插件详细 | [`docs/architecture.md`](./docs/architecture.md) · [`docs/plugins/`](./docs/plugins/) |
| dsh 集成 / 安装排障 | [`docs/dsh-integration.md`](./docs/dsh-integration.md) |
| 安全边界 / kill-switch 清单 | [`docs/security-boundary.md`](./docs/security-boundary.md) |
| **已知盲区（先看这个再下结论）** | [`docs/known-limitations/`](./docs/known-limitations/) |
| 运维 SOP / 踩坑记录 / 评估场景 | [`docs/operations/`](./docs/operations/) · [`docs/lessons/`](./docs/lessons/) · [`eval/scenarios/`](./eval/scenarios/) |
| 路线图 / 变更日志 / PHILOSOPHY | [GitHub Wiki](https://github.com/Anmulzhao/DSH-AGINT/wiki) |

环境变量两个：`DSH_HOME`（dsh 数据根，默认 `$HOME/.dsh`）；`AGINT_HOME` **双语义**——`install.sh` 当源码根、插件侧当数据根，设错会把数据写进仓库目录（设计说明见 `docker/entrypoint.sh`）。

## 许可

MIT
