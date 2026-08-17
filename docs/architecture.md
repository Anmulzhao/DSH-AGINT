# 架构

> AGINT 的运行时结构、数据流、与 dsh 的边界。

## 整体关系

```
┌─────────────────────────────────────────────────────────────────┐
│  dsh (upstream runtime)                                          │
│  ├── default presets: code / cordis / minimal / standard        │
│  └── user-patch layer  ← cordis.patch.yml ← 这里注入 agint-*     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AGINT user-patch 层 (profile-patches/web/cordis.patch.yml)      │
│  把 8 个 Cordis 插件作为 host Service 挂入 dsh web profile        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AGINT host Services (plugins/)                                  │
│  memory │ wiki │ cron │ dream │ rules │ metrics │ evolve │ stats  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AGINT preset (presets/agint/agent.cordis.yml)                  │
│  把 host Services 暴露成 model 工具：memory_* / wiki_* / ...      │
│  + 4 个 skills + 智进人格                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Runtime 数据 (gitignore)                                        │
│  $DSH_HOME/storages/agint*.json          KV 状态                  │
│  $AGINT_HOME/dreams/                    梦境日记                 │
│  $AGINT_HOME/wiki/                      知识库                   │
│  $AGINT_HOME/reviews/                   复盘报告                 │
└─────────────────────────────────────────────────────────────────┘
```

## 8 个 host Services 一览

| Service | 启动 | 调度 | 落点 | 触发 |
|---|---|---|---|---|
| `agint.memory` | 启动时 | 即时 | `~/.dsh/storages/agint.json` | model 调 memory_* |
| `agint.wiki` | 启动时 | 即时 | `$AGINT_HOME/wiki/` | model 调 wiki_* |
| `agint.cron` | 启动时 | tick | KV + 触发器 | tick + 手动 |
| `agint.dream` | 启动时 | cron night-dream | `$AGINT_HOME/dreams/` | 每日 03:00 |
| `agint.rules` | 启动时 | waterfall | `~/.dsh/storages/agint_rules.json` | 每个工具调用 |
| `agint.metrics` | 启动时 | cron metrics-collect | `~/.dsh/storages/agint_metrics.json` | 每日 |
| `agint.evolve` | 启动时 | cron evolve-review | `$AGINT_HOME/reviews/` + KV | 每周日 |
| `agint.toolStats` | 启动时 | tools/result 监听 | `~/.dsh/storages/agint_tool_stats.jsonl` | 每个工具调用 |

## 数据流：复盘闭环

```
会话产生
   │
   ▼
agint.toolStats  ── append ──▶ agint_tool_stats.jsonl
   │
   ▼ (每日)
agint.metrics  ── 懒解析 ──▶ agint_metrics.json (kv 时序)
   │
   ▼ (周日)
agint.evolve.writeReview()
   │
   ├─▶ $AGINT_HOME/reviews/YYYY-MM-DD.md
   └─▶ model 看报告 → evolve_propose → 落地改进
                                            │
                                            ▼
                                memory_write / wiki_write / rule_add
                                            │
                                            ▼ (夜间)
                                agint.dream sweep
                                            │
                                            ▼
                                候选 → 评分 → 提升进 agint.memory
                                            │
                                            ▼
                                metrics 再观察改进是否生效
```

## 与 dsh 的边界

| 我们做 | dsh 做 |
|---|---|
| 注入 8 个 host Services | preset 协议 / loader / patch 模型 |
| 暴露 model 工具 | tool registry / 工具 schema |
| 写我们自己的 KV | 持久化 / 域管理 / 进程单例 |
| 写我们自己的 cron jobs | tick 调度 / job 注册 |
| 写我们自己的 rules | tools/pre + tools/post waterfall |
| 编排 5 个内置 job | cron 时间源 |

**dsh 升级时**：load 顺序、waterfall hook 名、preset schema 可能变——CI 会暴露断点。

## 关键不变量

1. **`agint` storage domain 唯一**：memory 一个进程只有一个实例（service 域独占）
2. **host ↔ preset 工具配对**：plugin 负责 Service，preset 负责 Tool；任何工具都没有 Service 是悬空的
3. **patch 不破坏**：install.sh 用 `backup + merge`；用户 patch 里非 agint 段原样保留
4. **路径可移植**：`$AGINT_HOME` / `$DSH_HOME` 都在 .patch.yml 里走环境变量，默认值不带硬编码家目录