# agint-voice-hotkey

语音交互助手 3a：OS 全局热键触发录音，松手自动发送。

## 组成

1. **SSE 守护进程**（OS 层，独立进程）：源码 `bin/voice-hotkey.mjs`，运行副本由本机部署位决定（路径因机器而异，见本机 `AGENTS.local.md`，不入库）。轮询 `GetAsyncKeyState`（koffi），Ctrl+Alt+Space 按住/松开 → `http://127.0.0.1:19400/events` 推 `down`/`up`。`/status` 可探活。
2. **浏览器半**（`lib/client.js`）：`EventSource` 接事件 → 录音（MediaRecorder → 16 kHz 单声道 PCM16 WAV）→ `ctx.remote.speech.transcribe`（SenseVoice）→ `inputActions.insertText` + `inputActions.submit()`。席位 `conversation.input.left`，空闲且守护进程在线时不可见；离线显示「热键离线」。
3. **host 半**（`lib/index.js`）：零注入，只 `provide('agint.voiceHotkey')` 状态服务。

## 依赖

- 守护进程必须在跑：`node <本机部署位>/bin/voice-hotkey.mjs`（路径见本机 `AGENTS.local.md`）。
- `@deepseek-ai/dsh-experimental-voice-input-bundle` 必须激活（speech Remote 由它挂载）。
- koffi 复用 DSH 运行态依赖（`.agint-deps/dsh-runtime/node_modules/koffi`），无新装。

## 用法

按住 Ctrl+Alt+Space 说话，松开：转写结果插入当前会话输入框并自动发送。Esc 取消录音。

## 已知边界

- 同页多会话视图并发时，第一个认领热键的实例独占本轮听写（模块级 `activeRun`）。
- 转写期间热键不可用（一次只有一个 run）。
- 提交走 queue 模式：Agent 忙时消息进队列，不打断当前轮。

设计与验收：见工作区 `docs/语音交互助手-热键触发与自动发送方案-20261014.md`（机器私有路径，不入库）。
