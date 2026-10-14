// voice-hotkey：OS 全局热键守护进程。
// 组合键 Ctrl+Alt+Space：按住=说话开始，松开=说话结束。
// 事件通过本机 SSE（默认 http://127.0.0.1:19400/events）推给浏览器插件 agint-voice-hotkey。
// 依赖 koffi（已在 DSH 运行态依赖中），不装第三方软件。

import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const PORT = Number(process.env.DSH_VOICE_HOTKEY_PORT ?? 19400);
const HOST = '127.0.0.1';
const POLL_MS = 25;
const HEARTBEAT_MS = 10000;

const require = createRequire(import.meta.url);
// koffi 取值顺序：裸包名 → $DSH_HOME 运行态依赖 → 旧硬编码兜底。
// 路径从 $DSH_HOME 推导，不写死机器私有绝对路径（AGENTS.md 红线）。
const runtimeKoffi = process.env.DSH_HOME
  ? `${process.env.DSH_HOME.replace(/[\\/]+$/, '')}/.agint-deps/dsh-runtime/node_modules/koffi`
  : null;
const candidates = ['koffi', runtimeKoffi].filter(Boolean);
let koffi;
for (const id of candidates) {
  try { koffi = require(id); break; } catch { /* try next */ }
}
if (!koffi) {
  console.error('[voice-hotkey] koffi 不可用：找不到模块（koffi 或 DSH 运行态副本）');
  process.exit(1);
}

const user32 = koffi.load('user32.dll');
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vKey)');
const VK = { ctrl: 0x11, alt: 0x12, space: 0x20 };
const isDown = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;
const comboDown = () => isDown(VK.ctrl) && isDown(VK.alt) && isDown(VK.space);

const clients = new Set();
let pressed = false;
let lastPressAt = null;
let eventCount = 0;

function broadcast(type) {
  const payload = `data: ${JSON.stringify({ type, t: Date.now() })}\n\n`;
  eventCount += 1;
  if (type === 'down') {
    lastPressAt = new Date().toISOString();
    console.log(`[voice-hotkey] ${type} (${eventCount})`);
  }
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (req.url === '/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      ok: true,
      port: PORT,
      combo: 'ctrl+alt+space',
      pressed,
      lastPressAt,
      eventCount,
      listeners: clients.size,
      pid: process.pid,
    }));
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', port: PORT, t: Date.now() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end();
});

server.listen(PORT, HOST, () => {
  console.log(`[voice-hotkey] listening http://${HOST}:${PORT}/events combo=Ctrl+Alt+Space poll=${POLL_MS}ms`);
});
server.on('error', (err) => {
  console.error('[voice-hotkey] 端口占用或监听失败：', err.message);
  process.exit(1);
});

setInterval(() => {
  const now = comboDown();
  if (now && !pressed) { pressed = true; broadcast('down'); }
  else if (!now && pressed) { pressed = false; broadcast('up'); }
}, POLL_MS);

setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, HEARTBEAT_MS);
