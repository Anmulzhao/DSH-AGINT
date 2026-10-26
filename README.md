<div align="center">
  <img src="docs/assets/brand/png/agint-logo-512.png" width="300" alt="AGINT">
</div>

# AGINT

[English](README.en.md) | 中文

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

**v0.14.0** · 40 个 Cordis 插件（36 个挂载声明）· 1 套 preset · 25 个工具行 · 27 个 cron job。实时运行数字见 [`AGENTS.md`](./AGENTS.md) 文末 LOCAL-STATE 块。

- **哲学**：美 = 简洁 + 真实 + 靠谱 + 主动 + 安全；冲突时取前者。论述见 Wiki [PHILOSOPHY](https://github.com/Anmulzhao/DSH-AGINT/wiki/PHILOSOPHY)。
- **定位**：dsh 是上游 runtime，AGINT 是其上的规范 + 组件，不是 fork；不是 AGI 实现，是通往 AGI 的工程化骨架（记忆 / 反思 / 约束 / 度量 / 评估）；新增功能必须经 D-QAF 评估。
- **宪法**：D-QAF 四阶段流水线 + HARM 四维指标 + 进化记忆层，见 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。默认自动化，人工审批只作兜底；新机制一律带 kill-switch，出厂即开、配齐降级回落与审计出口。

## 四层结构

| 层 | 内容 | 位置 |
|---|---|---|
| **bundle** | 整体 = dsh bundle 包 `@agint/host`（全部插件 + 挂载 patch） | `package.json` + `cordis.patch.yml` |
| **preset** | 智进人格 + 工具集 + skills，1 套：`agint`（主线） | `presets/agint/` |
| **plugin** | 40 个 Cordis 插件（36 条挂载声明），8 组（记忆 / 调度 / 反思 / 质量 / 闭环 / 执行 / 观测 / 感知），清单见 [`docs/plugins/`](./docs/plugins/) | `plugins/agint-*/` |
| **data** | 记忆 / 规则 / 指标 / 梦境 / 复盘 | runtime 数据，不进仓库 |

> **子 preset 不在本仓**：`agint-blockchain` / `agint-investor` / `agint-ops` 三套
> 是个人定制（差别只有人格、路由、技能库），2026-10-26 起拆到私有仓
> `agint-presets`，以独立 bundle `@agint/presets` 交付。它们复用本仓的
> `agint-*` 插件，所以要先装本仓再装那个。

## 安装

前置：Node.js ≥ 20 · python3 · dsh ≥ 0.1.7-rc.1（矩阵见 [`VERSION`](./VERSION)）· 目标 profile 已初始化（web 跑过一次 `dsh web`，desktop 启动过一次桌面版）。

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh --profile=web      # 默认 web；装进桌面 profile 写 --profile=desktop
```

装完**必须重启目标 profile**（web 重开 `dsh web`；desktop 退出并重开桌面版）——bundle 与 profile 层不热更新。卸载 `./install/uninstall.sh`。

> **一份 preset 服务所有 profile**：`$DSH_HOME/.agent-presets/agint/` 只有一份，
> web 与 desktop 共用。它的 25 行工具声明因此锚定 `.agint-bundle/plugins/`
> （bundle 主挂载源），**不随 `--profile` 变化** —— 装完 web 再装 desktop
> 不会把先装的那端指空。安装器逐条核验这 25 个目标存在，缺一个即报。

四条红线：

1. 升级 dsh 必须带精确版本号——`npm i -g @deepseek-ai/dsh@latest` 会静默降级。
2. 包内 `node_modules` junction 是指向 dsh 官方包的软链；`rm -rf` 会跟进删包，卸载时必须保留。
3. 装完像没装、零报错，十有八九是没注册进 `dsh.profile.bundles`（安装步骤 3.5）。
4. `cordis.patch.yml` 的 `!!js` 只能写成标量。写成块集合或模板会让整份 bundle patch 解析失败，dsh 静默跳过 `@agint/host`，界面无报错——改完跑 `node bin/check-patch-yaml.mjs`。

更多排障见 [`docs/dsh-integration.md`](./docs/dsh-integration.md)；容器部署走 [`docker/`](./docker/)。

## 仓库自检

改完插件必跑四步：`node bin/check-patch-yaml.mjs`（patch YAML 可解析）→ `node bin/check-wiring.mjs`（接线通电）→ `node bin/check-dsh-compat.mjs`（dsh 兼容）→ `node bin/check-boundary.mjs`（能力边界未越界）。其余自检（manifest / tool schema / 记忆层 / LOCAL-STATE 回写）用法见 `bin/` 下脚本。

## 文档地图

| 想看什么 | 去哪 |
|---|---|
| 运行现状（真实数字，权威） | [`AGENTS.md`](./AGENTS.md) 文末 LOCAL-STATE 块 |
| 架构 / 插件详细 | [`docs/architecture.md`](./docs/architecture.md) · [`docs/plugins/`](./docs/plugins/) |
| dsh 集成 / 安装排障 | [`docs/dsh-integration.md`](./docs/dsh-integration.md) |
| 安全边界 / kill-switch 清单 | [`docs/security-boundary.md`](./docs/security-boundary.md) |
| 能力归属 / 越界判据 | [`docs/capability-boundary.md`](./docs/capability-boundary.md) |
| **已知盲区（先看这个再下结论）** | [`docs/known-limitations/`](./docs/known-limitations/) |
| 运维 SOP / 踩坑记录 / 评估场景 | [`docs/operations/`](./docs/operations/) · [`docs/lessons/`](./docs/lessons/) · [`eval/scenarios/`](./eval/scenarios/) |
| 路线图 / 变更日志 / PHILOSOPHY | [GitHub Wiki](https://github.com/Anmulzhao/DSH-AGINT/wiki) |

环境变量三个：`DSH_HOME`（dsh 数据根，默认 `$HOME/.dsh`）；`AGINT_PROFILE`（`install.sh` 的目标 profile 默认值，缺省 `web`）；`AGINT_HOME` **双语义**——`install.sh` 当源码根、插件侧当数据根，设错会把数据写进仓库目录（设计说明见 `docker/entrypoint.sh`）。

## 许可

MIT
