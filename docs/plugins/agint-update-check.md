# agint-update-check

检测 AGINT 仓库（DSH-AGINT）远端的最新状态，并**询问用户**是否更新与部署。

## 职责

| 工具 | 性质 | 作用 |
|---|---|---|
| `agint_update_check` | 只读 | 本地 HEAD vs 远端 main：落后/领先多少提交、变了哪些文件、要不要重新部署与重启宿主。返回里的 `question` 就是要问用户的那句话 |
| `agint_update_apply` | 写（ASK-gated） | 快进到远端最新 + `install/install.sh` 装到部署位。必须 `confirm: true` |
| `agint_update_status` | 只读 | 上次检测结果（不联网） |

外加一个**自持周期检查**（默认 6 小时）：发现远端有更新就往用户会话投递一条「要不要更新」，
同一个远端版本只投一次。

## 数据格式

检测报告（`agint_update_check` 的返回值核心字段）：

```json
{
  "ok": true,
  "upToDate": false,
  "behind": 16,
  "ahead": 1,
  "question": "检测到 agint 远端有 16 个新提交（本地 v0.15.0 → 远端 v0.17.0）。是否现在更新并部署？",
  "blockers": [
    "工作区有 34 处未提交改动（快进合并会失败，需先提交或 stash）",
    "本地与远端已分叉（ahead 1 / behind 16），快进合并不成立，需人工决定 merge 还是 rebase"
  ],
  "impact": {
    "needsDeploy": true,
    "needsRestart": true,
    "reasons": ["插件代码变更 9 处（部署后必须重启宿主才生效）"]
  },
  "commits": [{ "sha": "ac60ec6", "date": "2026-10-28", "subject": "fix(family-panel): …" }]
}
```

状态文件：`$DSH_HOME/storages/agint_update_check.json`（上次检测结果 + 已通知过的远端 sha）。

## 与其他插件的关系

- **`agint-restart`**：本插件**不重启宿主**。dsh 插件不热重载，部署后要重启才生效，
  但重启是宿主级动作（自带 60s 冷却 / 600s 内 3 次熔断），归 `restart_request`。
- **`agint-rules`**：`agint_update_apply` 是写工具，工具描述里标了 `ASK-gated`；
  要真正生效可在 `agint_rules` 里加一条 `tool=agint_update_apply` / `action=ask` 的规则。
- **`agint-tool-stats`**：同样是 host 平面注册全局工具（任何 preset 都能看到），机制一致。
- **`agint-mount`**：本插件做的是「仓库 ↔ 部署位」这条粗粒度通路；细粒度变更编排仍归 agint-mount。

## 文件

- `plugins/agint-update-check/lib/index.js` —— 插件入口：注册 3 个工具 + 周期检查 + 消息投递
- `plugins/agint-update-check/lib/repo.js` —— 仓库探测（ls-remote / fetch / rev-list / diff）
- `plugins/agint-update-check/lib/detect.js` —— 纯函数层（版本号 / 提交表 / 变更分类 / 影响面 / 提问语）
- `plugins/agint-update-check/lib/apply.js` —— 执行层（快进合并 + install.sh 部署）
- `plugins/agint-update-check/lib/git.js` —— git 命令执行器
- `plugins/agint-update-check/test/smoke.mjs` —— 冒烟测试
- `cordis.patch.yml` —— 挂载行（host 段）

## 设计文档

- 插件 README：`plugins/agint-update-check/README.md`（配置项与使用示例）
- 变更记录：`plugins/agint-update-check/CHANGELOG.md`
- 归属裁决：`docs/capability-boundary.md` §2（C 载体层 · 宿主运维外壳）