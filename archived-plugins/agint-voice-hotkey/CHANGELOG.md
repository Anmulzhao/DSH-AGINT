# Changelog — agint-voice-hotkey

## v0.2.5 (2026-10-18) — 热键改 Alt+. + 浏览器半改走同源代理 + 静音自动收尾

**三处都是行为变更，不是修 typo，故发 minor。**

### ① 热键从 Ctrl+Alt+Space 改为 Alt+.（2026-10-15 老板定）

`bin/voice-hotkey.mjs` 的 `VK` 加 `period: 0xBE`，`comboDown()` 改为
`isDown(VK.alt) && isDown(VK.period)`；不查 ctrl —— Alt+. 本身无系统冲突，
带上 ctrl 反而会与其他 Alt 组合误触。`/events` 的 `combo` 字段与启动日志同步改为 `alt+.`。

原组合键弃用的理由未在本仓记录（老板口头定），此处只记结论。

### ② 浏览器半不再直连 `:19400`

`lib/client.js` 的 SSE 地址从 `http://127.0.0.1:19400/events` 改为同源
`api/agint-voice/events`，由 host 半代理到守护进程。直连跨源 SSE 触发了
desktop 的 CSP 审查与端口卫生问题。

同时新增诊断信标 `beacon(phase, detail)` → `POST api/agint-voice/ping`，
host 半在 `/api/agint-voice/status.browserPing` 可见。诊断必须永不打断插件，
故整段包在 try/catch 里且 `.catch(() => void 0)`。

### ③ 静音自动收尾（2026-10-15）

在**麦克风原始流**上挂 `AnalyserNode` 做 RMS 电平监视（不是挂在 recorder 上，
停止两者互相独立）。连续静音 `SILENCE_END_MS` 后收尾，但需同时满足：
总录音时长 ≥ `SILENCE_ARM_MS`（防开头停顿误判）+ 至少检出过一次语音。

### ④ 机器私有路径回退（本次提交的收口项）

`bin/voice-hotkey.mjs` 里 koffi 的兜底路径曾被写成硬编码
`D:/DSH/AGINT-date/.agint-deps/...`，`lib/client.js` 的断连提示里也写了
`D:/DSH/bin/...`。两者都是 Windows 本机私有值，本仓两台机器（Linux / Windows）
共用，写死会让另一台读到 outright 错误的路径（AGENTS.md 红线）。
已改回：koffi 从 `$DSH_HOME` 推导，提示文案去掉绝对路径。

## v0.2.4 (2026-10-17) — 止 host 崩循环

清 SSE 流建立后的 5s idle timeout（http timeout 是 idle 上限，SSE 必超）、
`onResponse` 加 once-guard、piped 流补 error 监听；smoke 加行为回归用例。
