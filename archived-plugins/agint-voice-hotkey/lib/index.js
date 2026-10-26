/**
 * agint-voice-hotkey: HOST half.
 *
 * Same-origin SSE proxy in front of the standalone hotkey daemon
 * (`D:/DSH/bin/voice-hotkey.mjs`, loopback :19400). The browser half consumes
 * `api/agint-voice/events` through this route, so the page never opens a
 * cross-origin connection: CSP, port hygiene and daemon lifecycle stay a
 * host-plane concern (family-panel route pattern).
 *
 * Routes (loopback-only):
 *   GET /api/agint-voice/events  → streamed passthrough of daemon /events
 *   GET /api/agint-voice/status  → daemon /status JSON + browserPing, or {ok:false} when down
 *   POST /api/agint-voice/ping   → browser-half mount beacon {phase}
 *
 * Row (bundle cordis.patch.yml):
 *   - insert:
 *       - id: agint-voice-hotkey
 *         name: ./plugins/agint-voice-hotkey/lib/index.js
 */

import http from 'node:http';

const name = 'agint-voice-hotkey';
const inject = ['webServer'];

const VERSION = '0.2.4';
const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = Number(process.env.DSH_VOICE_HOTKEY_PORT ?? 19400);

const EVENTS_PATH = '/api/agint-voice/events';
const STATUS_PATH = '/api/agint-voice/status';
const PING_PATH = '/api/agint-voice/ping';

// browser 半 beacon 计数（诊断用）：factory 执行 / apply 跑过 / 组件挂载。
// 判读：phases 无 'factory' → bundle 没送达或没物化；有 factory 无 apply →
// import 未走插件导出；有 apply(ok) 无 mount → 席位没渲染；有 mount 而
// daemon listeners=0 → EventSource 连接本身失败。
const browserPing = { phases: {}, last: null, lastAt: null };

function isLoopback(req) {
  const addr = req.socket?.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function daemonGet(path, onResponse) {
  let settled = false;
  const settle = (upstream) => {
    if (settled) return;
    settled = true;
    onResponse(upstream);
  };
  const req = http.get({ host: DAEMON_HOST, port: DAEMON_PORT, path, timeout: 5000 }, (upstream) => {
    // 5s 只约束连接阶段；流建立后不清 idle timer，守护进程 10s 心跳间隔会把活着的 SSE 误判超时（2026-10-15 host 五连崩根因）
    req.setTimeout(0);
    settle(upstream);
  });
  req.on('error', () => settle(null));
  req.on('timeout', () => {
    req.destroy();
    settle(null);
  });
  return req;
}

/**
 * Mount the plugin's host half.
 *
 * ⛔ cordis 契约：config 走 apply 第二参数，不读 ctx.config（那要 inject
 * 声明 config，宿主不给，fiber 直接 fail——本插件 0.1.0 踩过，2026-10-14）。
 * @param {object} ctx - host context (services: webServer).
 * @param {object} [config] - cordis.patch.yml 的 config 段。
 */
function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (!enabled) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"disabled"}');
          return;
        }
        if (!isLoopback(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"loopback-only"}');
          return;
        }
        daemonGet('/status', (upstream) => {
          if (!upstream) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'daemon-unreachable', daemonPort: DAEMON_PORT, browserPing }));
            return;
          }
          const chunks = [];
          upstream.on('data', (c) => chunks.push(c));
          upstream.on('end', () => {
            let payload;
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              payload = { ok: false, error: 'daemon-bad-json' };
            }
            payload.browserPing = browserPing;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
          });
          upstream.on('error', () => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'daemon-read-failed', browserPing }));
          });
        });
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: PING_PATH,
      handler: (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(browserPing));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        if (!isLoopback(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"loopback-only"}');
          return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let phase = 'unknown';
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof body.phase === 'string') phase = body.phase.slice(0, 40);
          } catch { /* keep 'unknown' */ }
          browserPing.phases[phase] = (browserPing.phases[phase] ?? 0) + 1;
          browserPing.last = phase;
          browserPing.lastAt = new Date().toISOString();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_PATH,
      handler: (req, res) => {
        if (!enabled || !isLoopback(req)) {
          res.writeHead(enabled ? 403 : 200, { 'Content-Type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ type: enabled ? 'forbidden' : 'disabled' })}\n\n`);
          return;
        }
        const upstreamReq = daemonGet('/events', (upstream) => {
          if (!upstream) {
            res.writeHead(502, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            res.end(`data: ${JSON.stringify({ type: 'upstream-error', error: 'daemon-unreachable', daemonPort: DAEMON_PORT })}\n\n`);
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          upstream.on('close', () => res.end());
          // piped 流无 error 监听时，daemon 侧断连会 uncaught 杀 host
          upstream.on('error', () => res.end());
          upstream.pipe(res);
        });
        req.on('close', () => upstreamReq.destroy());
      },
    }),
  ];

  // ⛔ cordis 语义：effect 的 body 立即执行，返回值才是清理函数。
  // 单层箭头会让 dispose 在注册的同一毫秒跑掉——路由刚挂上就被自己拆掉
  // （2026-10-15 实测：fiber active 但 /api/agint-voice/* 404）。
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch { /* teardown must not throw */ }
    }
  }, 'agint-voice-hotkey: routes');

  ctx.provide('agint.voiceHotkey', {
    version: VERSION,
    enabled,
    daemon: { host: DAEMON_HOST, port: DAEMON_PORT },
    routes: { events: EVENTS_PATH, status: STATUS_PATH, ping: PING_PATH },
  });
}

export { name, inject, apply };
