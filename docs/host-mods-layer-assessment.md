# 宿主 mods 层评估：`claudeCodeMods` 在本机没有实现

> **结论先行**：`claudeCodeMods`（及其 `ModsApi.ui` / `watchBand` / `TurnUsage`）在
> **npm 分发的 dsh 0.2.1-rc.5 里没有任何包提供** —— 它在宿主的能力面目录里存在，
> 但实现不在这个包里。所以 B2（调用级 token）与 B5（面板 band/pane）**在本机做不了**，
> 不是「没装够包」。
>
> 日期：2026-11-02 · 对应提案 B2 / B5

---

## 1. 能力面说它存在

`api-catalog.js`（宿主自生成的权威目录）给了完整契约：

| 类型/服务 | 契约要点 |
|---|---|
| 服务 `claudeCodeMods` | "The bridge service: loaded mods, their hooks, and the harness listeners that raise their events" |
| `ModsApi.ui` | `log` / `toast` / `status` / `invalidate` / `open(pane)` / `close` / `ask` / `resolve(UiRenderInput)` |
| `claudeCodeMods.watchBand(agent, signal)` | 观察输入框上方那条 band 的每次重绘 |
| `claudeCodeMods.pressBand(agent, generation, actionId)` | 按 band 上的按钮 |
| `TurnCompleteInput.usage?: TurnUsage` | `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `model` |

⇒ 提案 B2 的动机（`TurnUsage` 补「非 billing 级」）与 B5 的动机（band 只承载一行状态）都成立**前提是拿到这个服务**。

## 2. 事实：没有 provider

```
grep -rl "claudeCodeMods" <dsh 安装树>/node_modules/@deepseek-ai
→ 只有 dsh-tool-cordis/lib/types/api-catalog.js（文档）
```

**零个实现包**。对比一下：`sessionProjections` / `worktrees` 都是能 grep 到实现包的（见
`docs/session-projections-assessment.md` §1 与 `cordis.patch.yml` 的 worktree 行）。

## 3. 试过的路：装 `dsh-hooks-claude-code` —— 不解决

`@deepseek-ai/dsh-hooks-claude-code` 在 npm 上有 `0.2.1-rc.5`，装得上：

```
dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.5
+ @deepseek-ai/dsh-hooks-claude-code 0.2.1-rc.5
dsh: warning: @deepseek-ai/dsh-hooks-claude-code declares no dsh.bundle
     — installed as a plain dependency, not a profile layer
```

装完不是 END，是**证伪**：

| 检查 | 结果 | 含义 |
|---|---|---|
| `package.json` 的 `dsh` 字段 | `null` | 不声明 bundle ⇒ 不会成为 profile layer，不会自动挂载 |
| `--dump-config` 里有没有对应行 | **没有** | 配置层根本没把它的 entry 加进树 |
| 它的实现是什么 | `CLAUDE_EVENTS = [SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop]` + `runHook()` | 它读 **Claude Code 的 hooks 配置**并执行**外部命令** |
| 它涉及的服务 | `ctx.sessionProjections` / `ctx.shell` / `ctx.workingDirectory` | 与 `claudeCodeMods` 无关 |

⇒ `dsh-hooks-claude-code` 是「Claude Code 外部 hooks 桥」，**不是 mod 宿主**。
名字像，职责完全不同 —— 这是本次最容易踩的坑（提案 B2 初版就把它当成前置了）。

## 4. 那两个能力在本机的替代路径

### B2（调用级 token）

| 路径 | 可用性 | 说明 |
|---|---|---|
| `TurnUsage`（mod 钩子） | ❌ | 需要 `claudeCodeMods`，本机无 provider |
| `ctx.tokenMeter.measure(session)` | ✅ **已接** | `agint-tool-stats` 落 `deltaTokens`/`tokenSource`，生产 412/4746 行有值 |
| 剩余差距 | — | 压力差 vs 调用级。**这是宿主侧缺的字段，不是 AGINT 能自补的**（自补就得自己解析 provider 的 usage 帧，那就是再造一个 tokenMeter） |

⇒ 维持现状，`docs/known-limitations/token-cost-not-billing-grade.md` 的表述不再改。
**等上游把 mod 宿主打进 npm 包再来收这条。**

### B5（面板 band/pane）

同理不可做。且即使可用，提案原本也只要求「写评估」——现在评估的结论更靠前：
**装置都没有，谈不上形态取舍。**

## 5. 附带发现：`dsh-hooks-claude-code` 对 AGINT 有价值吗？

有一定相关性，但不是现在该做的：

- 它能把 **Claude Code 的 hooks 配置**（`PreToolUse` / `PostToolUse` / `Stop` …）接进 dsh 事件。
- AGINT 的 `agint-rules` 现在是**自建的工具流水线门禁**（订阅 `tools/pre-execute`）。
  如果哪天 AGINT 要接"外部团队已有的 Claude Code hooks"，这个桥是入口。
- ⛔ 但它**不改变** `agint-rules` 的形态：hooks 是「执行外部命令」，rules 是「进程内判定」，
  两者不是同一层。把它当成 `agint-rules` 的上游替代会丢掉 fail-closed 语义。

⇒ 记在这里备查，不作为待办。

## 6. 重新评估的触发条件

1. 宿主换成 **Electron 桌面版**（`app.asar` 内可能含 mod 宿主实现）—— 本机是 npm 版；
2. 上游把 `claudeCodeMods` 的 provider 打进任一 npm 包（届时 `grep -rl claudeCodeMods`
   会命中除 api-catalog 之外的包）；
3. AGINT 真要支持 Claude Code hooks 生态（那时该评估的是 `dsh-hooks-claude-code`，
   与本文 §5 同题）。

---

**一句话总结**：能力面有、实现没有。装包试过、证伪了，不是名字对不上就是职责对不上。
B2/B5 挂起，触发条件已写死。
