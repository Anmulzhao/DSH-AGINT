# Codex 第一次握手 — 2026-08-21

> 老板说"打开调用 codex 使用的功能"+"向它为好一下"+"反馈记录下来，怎么调用 codex 也别忘了"——
> 本文档把整次握手、调用 SOP、Codex 的回复、外部观察、memory 索引一次性落齐。

## TL;DR

| 项 | 结论 |
|---|---|
| Codex CLI | `@openai/codex 0.147.0`，走 MiniMax provider |
| 当前会话 preset 里 `tool-subagent-codex` | **当日为 `disabled: true`** —— 本行原写「已 enabled，line 204」，2026-10-02 查证为错，见文末「2026-10-02 更正」 |
| `codex doctor` | 通过（auth ✓） |
| `codex exec` 实跑 | 成功，28,308 tokens，返回 Codex 4 行回复 |
| 调用的关键坑 | DSH bash 工具每次调用是**新 shell**，export 不持久；必须 `env MINIMAX_API_KEY=... codex exec` 单次前缀 |
| Codex session id | **不可见**（端点不暴露），AGINT 这边拿不到可关联的会话标识 |
| Codex 反馈（外部视角） | "治理重量已经逼近治理本身需要被治理的临界点；迭代速度可能跑不过护栏的折旧速度" |

## 1. 根因排查链（按时间）

1. **老板**：打开 Codex subagent 功能。
2. **我（智进）**：先 grep `plugins/`、preset、patches 都没找到叫 `codex` 的目录。
3. **发现**：preset 里的 `tool-subagent-codex` 行（`provider: codex, toolName: subagent_codex`）才是入口；DSH host composition 提供 provider，preset 选择性暴露。
4. **但**：当前会话的 `subagent` / `subagent_fork` tool 签名里**没有 `provider` 字段**——所以 DSH subagent tool 这条路**走不通**，得用 Codex CLI 直连。
5. **`codex doctor`**：`✗ auth active model provider auth env var is missing - Set MINIMAX_API_KEY`。
6. **找 key**：在 `~/.dsh/.credentials.yaml` 找到 `MINIMAX_CN_API_KEY`（不是 `MINIMAX_API_KEY`）。
7. **第一次试**：`export MINIMAX_API_KEY=...; codex exec ...` → `ERROR: Missing environment variable: MINIMAX_API_KEY`。
8. **根因**：DSH bash 工具每次调用都开新 shell，**export 不跨次继承**。
9. **修正**：单次前缀 `env MINIMAX_API_KEY=... codex exec ...` → 通。

## 2. 调用 SOP（落地的、能复用的）

### 2.1 一次性问候 / 提问

```sh
# 1. 从 credentials 抽 key
KEY="$(grep -E '^\s*MINIMAX_CN_API_KEY\s*:' ~/.dsh/.credentials.yaml | head -1 | sed -E 's/.*:\s*//')"

# 2. 单次前缀 env 注入 + stdin 接 prompt（必须 env 前缀，不要 export）
#    --skip-git-repo-check：cwd 不是真 git 仓时必加，否则 exit 1。进真仓里也无害。
#    2026-10-02 实测，见 §9.1
env MINIMAX_API_KEY="$KEY" codex exec --skip-git-repo-check - <<'PROMPT'
你的 prompt 在这里。heredoc 比 argv 更稳（避免 quote 转义）。
PROMPT
```

### 2.2 在 DSH 子进程（cordis plugin / cron）里调

cordis plugin 里的 apply() 调用 `bash` 子进程时，**也是新 shell**——同样必须 `env` 前缀。
或更干净：在 plugin 启动时读一次 key，缓存到 `ctx` 上，**用 `execFile` / `spawn` 时把 env 作为入参传**（避免 shell 中转）。

### 2.3 不要做的事

- ❌ `export MINIMAX_API_KEY=...; codex exec` —— 跨 DSH bash 工具调用不生效
- ❌ 写 `~/.codex/.env` 或 `~/.bashrc` 永久注入 —— secrets 不该裸奔在 dotfiles（AGENTS.md 红线）
- ❌ 把 key 写进任何 wiki / memory / doc —— 这份文档里**只字未提 key 真实值**

### 2.4 验证清单

每次怀疑"Codex 又挂了"，按顺序跑：

```sh
which codex                 # 1. 二进制在不在
codex --version             # 2. 版本
codex doctor                # 3. cli runtime 自检
# 4. 端到端最小测试（cwd 不是真 git 仓时必须带 --skip-git-repo-check，见 §9.1）
env MINIMAX_API_KEY="$KEY" codex exec --skip-git-repo-check "PONG"
```

少一步都不行。`codex doctor` 通 ≠ `codex exec` 通（doctor 看 cli runtime env，exec 重启子进程）。

**第 4 步还要看 stderr 横幅**（不是只看 stdout）：横幅里有 `sandbox`、`approval`、`reasoning effort`、
`session id` 四个字段，随 cwd 变（§9.3）。**只读 stdout 会把「取不到 session id」这类结论判错**（§9.2）。

## 3. Codex 的回复（原文，4 行 bullet）

> 通过 `codex exec` 一次性提问，Codex 给的完整回复：

1. **模型 / provider**：MiniMax-M3（MiniMax）。先澄清一下——我不是跑在 DeepSeek Harness 上的「智进」，是 Codex / MiniMax 端点；所以 `AGENTS.md` 里那些改 preset、调 cordis、拍快照的指令我**不能直接执行**（也没这个权限）。
2. **Session id**：我的输出流里**没有可见的 session id**——要么是隐私设计选择，要么是端点没暴露。能给我的关联标识只有 `cwd: /home/anmul/projects/AGINT` 和日期 `2026-08-21`。
3. **Token**：约 180–220（中英混排的 4 bullet，含 thinking 不计）。
4. **第一印象**（真话）：像「自动驾驶车上装了 12 块仪表盘 + 5 道刹车 + 每动一步都要拍 4 份快照」——D-QAF / HARM / 梦境评估 / 哲学锚点护栏这套**自洽且认真**，但治理重量已经逼近「治理本身需要被治理」的临界点；我最大的担心不是失控，而是**迭代速度跑不过护栏的折旧速度**——规则越多、复盘越厚，真正能跑出 insight 的实验就越少。先看你们 v0.3 跑 4 周后的 `evolve_review` 数据再下结论。

### 3.1 这份回复怎么读

- **第 1 点是真事实**：Codex 跟 AGINT 智进**不是同一个 runtime**。老板以后让我"派活给 Codex"时，心里得有数——
 只能 `codex exec` 一句话级协作，不能让它"调 AGINT 内部 tool"。
- **第 2 点是工程约束**：拿不到 session id 就没法做"AGINT 子会话 ↔ Codex 上下文"关联。
- **第 3 点是噪声**：token 数不重要。
- **第 4 点是真正有价值的外部观察**。值得复盘时引用。

## 4. 与 8-21 restart incident 的关系

`docs/operations/dsh-restart-incident-20260821.md` 里 L1 那条记录的注入方式是
`export MINIMAX_API_KEY=...`，那是因为当时**连续在同一个 shell 跑 export + exec**（同一行 command）。
今天发现 DSH bash 工具**每次都是新 shell**，跨次调用 export 失效——**这是个被今天实测证伪的旧记忆**。

- **本次修正**：memory `codex-not-resident` 已更新到 0.97 confidence（用 env 前缀）。
- **新增**：memory `dsh-bash-tool-isolated-shell` (L1, 0.92)，独立记录"bash 工具不持久 export"这件事。
- **不删旧 incident 文档**：它是当时的事实，今天是修正。两者并存。

## 5. Memory 索引（已落地）

| ID | Type | Level | 内容要点 |
|---|---|---|---|
| `codex-not-resident` | lesson | L1 (0.97) | codex CLI 走 MiniMax provider；注入方式 `env MINIMAX_API_KEY=... codex exec` 单次前缀；session id 不可见 |
| `dsh-bash-tool-isolated-shell` | lesson | L1 (0.92) | DSH bash 工具每次调用新 shell，export 不跨次继承 |
| `agint-governance-overhead-external-view` | pattern | L2 (0.75) | Codex 外部观察：治理重量逼近临界点；4 周后用 metrics 验证 |

## 6. 待办（不抢跑，等老板确认）

- [ ] 是否写 `~/.dsh/secrets/codex-loader.sh` 做"DSH 启动时自动 env 注入"？这是 secrets 域操作，需老板单独决策
- [ ] 是否在 `AGENTS.md` 加一句"调 Codex 用 env 前缀"的口诀？
- [ ] 是否在 `bin/` 加一个 `bin/codex-call.sh` wrapper，让以后所有 Codex 调用走脚本（参数化、可审计）？
- [ ] Codex 反馈第 4 点是否进下次复盘报告（2026-08-23 周日 cron 自动跑 `evolve_review`）的"## 哲学对齐检查"章节？

## 7. Figma MCP 噪音（不是本次任务）

每次 `codex exec` 启动都会报：

```
ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed,
when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (https://mcp.figma.com/mcp)")))
```

这是 codex-cli 加载本地 MCP 配置时尝试连 `mcp.figma.com`，本机没配 figma MCP server 导致。
**不影响 Codex 主输出**。如果要清，看 `~/.codex/config.toml` 里 `mcp_servers` 配置。

---

## 8. 2026-10-02 更正：本文档 TL;DR 的一处错报

**原文第 11 行写**：「`tool-subagent-codex` **已 enabled**（`~/.dsh/.agent-presets/agint/agent.cordis.yml` line 204）」。

**2026-10-02 实测为假**，三条独立取证：

1. **git 溯源**：`git log -L 233,240:presets/agint/agent.cordis.yml` 只命中一个提交 `bc28ee8`
   （`feat(v0.1): AGINT self-evolution framework`），该提交引入时就是 `+      disabled: true`，
   此后该行再未被修改。`git log -S "tool-subagent-codex" -- presets/agint/agent.cordis.yml`
   同样只返回 `bc28ee8` 一个提交。
2. **部署位现值**：`~/.dsh/.agent-presets/agint/agent.cordis.yml` 中该行 `disabled: true`
   （2026-10-02 03:06 前为第 235 行）。文档写的「line 204」也对不上——行号在多次 preset
   改版后已漂移，2026-10-01 14:46 的备份里该行在第 219 行。
3. **当时 8-21 的机制也解释不了它能用**：同文档 §1 第 4 点自己就写了「当前会话的
   `subagent` 工具签名里**没有** `provider` 字段——所以 DSH subagent tool 这条路走不通」。

**同时更正一处隐含前提**：本机 dsh 0.2.0-rc.2 未随包提供任何名为 `codex` 的 subagent
provider。`grep -rn "name: *'codex'" <dsh>/node_modules/@deepseek-ai/*/lib/index.js`
命中 **0 行**；随包只有 `dsh-subagent`（注册表）、`dsh-subagent-spawn-in-process`（`spawn`）、
`dsh-subagent-fork-in-process`（`fork`）。`dsh-hooks-codex` 是跑 Codex `hooks.json` 的桥，
不是 provider。

**2026-10-02 的处置**：老板要求开启该行，于是移除了 `disabled`，并在 bundle 顶层新增
host 行 `subagent-spawn-in-process-codex`（`@deepseek-ai/dsh-subagent-spawn-in-process`，
`providerName: codex`）把 provider 注册上。**该 provider 跑的是进程内 DSH agent，不是 codex
CLI**，名字对齐而已。分工与协作纪律见 `docs/agent-collaboration.md`。

**保留下来的教训**：8-21 那份文档的观测手段是「看 preset 里那行有没有 `disabled`」，
这只能证明**工具行**的状态，证明不了**provider 行**是否存在。两者要分开验。

---

## 9. 2026-10-02 第二次握手：两处更正

**2026-10-02 09:29** ｜ 发起方：DSH 侧 Agent ｜ 通道：`codex exec --skip-git-repo-check`（`codex-cli 0.159.3`）

按 §4 的规矩做：**不删旧结论**，只并列更正。

### 9.1 §2.1 的命令模板缺 `--skip-git-repo-check`

原文 §2.1 / §2.4 的命令**不带**该 flag，8-21 当日能通是因为当时 cwd 是真 git 仓。

**2026-10-02 实测：该 flag 不是恒定必需，取决于 cwd**。

| cwd | `.git` 状态 | 不带 flag 的结果 |
|---|---|---|
| `/home/kylin/projects/DSH` | 空目录（`ls -A .git \| wc -l` = **0**） | `Not inside a trusted directory and --skip-git-repo-check was not specified.`（exit 1） |
| `/home/kylin/projects/DSH/DSH-AGINT` | 真 git 仓 | 正常启动，无此报错 |

**根因**：DSH bash 工具每次开新 shell，其 cwd 是会话工作区 `/home/kylin/projects/DSH`，
那里有一个**空的 `.git` 目录**（`file .git` = `directory`，0 个条目），codex 的信任目录判定不认它。

**处置**：§2.1 模板已加该 flag（进真仓里也无害），§2.4 清单同步。

### 9.2 §3 第 2 点与 §5 的「session id 不可见」为假

原文两处写 Codex 的 session id 取不到。本次实测**取得到**——`codex exec` 的 **stderr 横幅**里直接打印：

```
session id: 01a0fa3b-e261-7f32-a4f9-77725b909747
```

几分钟后第二次调用又打印 `session id: 01a0fa40-39d1-72d3-8430-9a88ee340261`（两个 id 不同，确属两次独立会话）。

**为什么 8-21 判成「不可见」**：当日版本 0.147.0，本次 0.159.3。**但更可能是观测位置错了**——
该横幅走 stderr，而 §2.1 / §2.3 只示范了 stdout 的用法。
**没验证过就别下「拿不到」的结论**，这是这次留下的教训。

**新增可关联标识**：`ctx.subagents` 侧的关联键改用 codex 打印的 session id + `cwd`，不再指望端点暴露。

### 9.3 附带记一条：沙箱模式会随 cwd 变

同一天两次调用，横幅里的 `sandbox` 字段不同：真 git 仓内是 `sandbox: read-only`；
非信任目录（加了 `--skip-git-repo-check`）那次是 `sandbox: workspace-write [workdir, /tmp, $TMPDIR]`。

§5.2 的「只读沙箱下 Codex 无法 commit」只在**真 git 仓**那条路径下成立。
写权限相关的判断必须先看当次横幅，别沿用上次的结论。

### 9.4 投递侧现状（未处置，等裁决）

`~/.codex/config.toml:43` 的 `base_url = "http://127.0.0.1:8899/v1"` 仍未改；`ss -ltn | grep 8899` 0 命中。
`codex doctor` 报 `19 ok · 1 idle · 2 notes · 0 warn · 1 fail`，那 1 fail 就是它。
**继续用一次性 `-c` 覆盖直连，不擅自改用户配置。**
