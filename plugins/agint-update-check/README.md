# agint-update-check

检测 AGINT 仓库（DSH-AGINT）远端的最新状态，并询问用户是否更新与部署。

## 职责

- **agint_update_check**（只读）：对比本地 HEAD 与远端 main，报告落后 / 领先多少提交、
  变了哪些文件、是否需要重新部署与重启宿主；返回的 `question` 字段就是**要问用户的那句话**。
- **agint_update_apply**（写，ASK-gated）：把仓库快进到远端最新，并按需装到部署位。
  必须 `confirm: true`；本地有未推送提交（分叉）或工作区脏 ⇒ 拒绝并说明原因。
- **agint_update_status**：读上次检测结果（不联网、不动仓库）。
- **周期检查**：默认每 6 小时自持检测一次，发现远端有更新就往用户会话投递一条「要不要更新」
  （同一个远端版本只投一次，避免刷屏）。

## Service

本插件**不提供 service**（`provides: []`）：三个工具都直接注册在 host 平面，
任何 preset 的会话都能看到（与 `agint-tool-stats` 的 `tool_stats_summary` 同一机制）。

## 使用示例

```
用户：agint 有更新吗？
助手：调用 agint_update_check → 返回
  本地：v0.15.0 (8a85419)　远端：v0.17.0 (ac60ec6)
  状态：落后 16 个提交（本地另有 1 个未推送提交）
  影响面：插件代码变更 9 处；新增插件 agint-executor；挂载行 / preset 变更
  question: 检测到 agint 远端有 16 个新提交（本地 v0.15.0 → 远端 v0.17.0）。是否现在更新并部署？
助手：据此向用户确认 → 用户同意 → 调用 agint_update_apply({ confirm: true, mode: 'deploy' })
```

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| repoRoot | env `AGINT_REPO_ROOT` → `AGINT_HOME` | 仓库根（必须同时含 `.git` 与 `plugins/`） |
| remote | `origin` | 远端名 |
| branch | `main` | 远端分支 |
| checkIntervalMs | `21600000`（6h） | 周期检测间隔 |
| dshHome | env `DSH_HOME` | 部署位根（读 profile.json / 写状态文件） |
| profile | 读 `$DSH_HOME/.agint-bundle/profile.json` | 部署 profile |
| bashPath | 自动探测 | 跑 install.sh 用的 bash |
| notify | `true` | 发现更新时是否主动投递消息 |
| autoCheck | `true` | 是否自持周期检查 |

## 边界与红线

- **不重启宿主**：dsh 插件不热重载，但重启是宿主级动作 —— 归 `agint-restart` 的
  `restart_request`（自带 60s 冷却 / 600s 内 3 次熔断）。本进程自杀式重启会让工具调用无返回。
- **不代劳 merge / rebase / stash**：分叉与脏工作区一律拒绝，把决定权交回人。
- **不猜**：找不到仓库根 / 读不到 profile / 找不到 bash ⇒ 报错，不猜一个默认值去执行。
- **部署额度**：每周自动部署 ≤ 3 次（AGENTS.md 红线）由调用方（agent）把关。

## 文件

- `lib/index.js` —— 插件入口：注册 3 个工具 + 周期检查 + 消息投递
- `lib/repo.js` —— 仓库探测（ls-remote / fetch / rev-list / diff）
- `lib/detect.js` —— 纯函数层（版本号 / 提交表 / 变更分类 / 影响面 / 提问语）
- `lib/apply.js` —— 执行层（快进合并 + install.sh 部署）
- `lib/git.js` —— git 命令执行器（execFile + 参数数组，不过 shell）
- `test/smoke.mjs` —— 冒烟测试（`node test/smoke.mjs` → exit 0）