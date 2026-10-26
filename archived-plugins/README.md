# 已归档插件

本目录存放**已退役但未删除**的 AGINT 插件。放在 `plugins/` **之外**是有意的：
`plugins/` 下每一个 `agint-*` 目录都会被门禁扫到（`check-wiring` 的类型源/产物漂移检查、
`check-boundary` 的归属表覆盖检查、`plugin-check.sh` 的 manifest 校验），
归档件不该再被当成"在役插件"要求。

## 归档 ≠ 删除

代码保留在这里，可用于追溯与翻案。要复活一个插件：
`git mv archived-plugins/<name> plugins/<name>`，然后在
`docs/capability-boundary.md` §2 归属表里补上裁决，再跑 `bin/plugin-check.sh`。

## 清单

| 插件 | 归档日 | 最后版本 | 理由 |
|---|---|---|---|
| `agint-voice-hotkey` | 2026-10-21 | v0.2.5 | 见下 |

### `agint-voice-hotkey`（v0.2.5 → 归档）

**三条理由（任一成立即应归档）**

1. **与宿主重复**：dsh 0.2.1-rc.2 已有语音输入，且**运行时实测 active**：
   `dsh-experimental-speech-to-text` + `dsh-experimental-speech-to-text-sensevoice`
   + `dsh-experimental-client-ui-voice-input` + 第三方 `dsh-voice-mode`。
   AGINT 再持一套热键/录音/SSE 代理，等于两个真相源。
2. **从未挂载**：`cordis.patch.yml` 中 `voice-hotkey` 命中 **0 行**
   （`agint-mascot` / `agint-search-tools` 同属"仓库有代码但没挂"）。
   也就是说它长期没有在生产里跑过，归档不减少任何现有能力。
3. **带机器私有事实**：部署位副本在 2026-10-15 被手工改过，文案指向
   `D:/DSH/bin/voice-hotkey.mjs`（本机绝对路径）。这违反本仓 AGENTS.md
   「机器私有事实不入库」红线；仓库版保留可移植写法，于是两边长期漂移 ——
   `bin/check-wiring.test.mjs` 曾为此专门开了一条 `KNOWN_DEPLOY_DRIFT` 豁免。

**若仍需要热键能力**：优先用 dsh 的语音输入（设置里可配）；若确实要 AGINT 侧的热键语义，
应写成薄封装消费 `ctx.speechToText`，而不是再自建录音与 SSE 通道。

**取证**：`plugin_manager list_plugins` 运行时清单（263 条）里
`dsh-experimental-client-ui-voice-input` 与 `dsh-voice-mode` 均 `fiberPhase=active`；
`cordis.patch.yml` grep `voice-hotkey` 命中 0。
