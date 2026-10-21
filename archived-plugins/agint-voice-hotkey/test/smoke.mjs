// agint-voice-hotkey smoke test: syntax + wiring assertions + daemon-timeout
// regression (no browser here).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [
  ['lib/index.js', ['agint.voiceHotkey', '19400', '/api/agint-voice/events', '/api/agint-voice/status', '/api/agint-voice/ping', 'loopback-only', 'ctx.effect(() => () =>']],
  ['lib/client.js', ['__ModuleLoader__', 'conversation.input.left', "id: 'agint-voice-hotkey'", "beacon('mount')", 'inputActions.submit()', "new EventSource(EVENTS_URL)", "const EVENTS_URL = 'api/agint-voice/events'", 'SilenceWatcher', 'ctx.effect(() => () =>']],
];

let failed = 0;
for (const [file, needles] of checks) {
  const abs = resolve(root, file);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  } catch (err) {
    console.error(`FAIL syntax ${file}:`, String(err.stderr || err.message).slice(0, 300));
    failed += 1;
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) {
      console.error(`FAIL wiring ${file}: missing "${needle}"`);
      failed += 1;
    }
  }
}

// lib/index.js reads DSH_VOICE_HOTKEY_PORT at import, so the fake daemon must
// listen before the import below.
const daemonSockets = new Set();
const daemon = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    daemonSockets.add(req.socket);
    return; // silent afterwards: idle daemon, no heartbeat
  }
  res.writeHead(404).end();
});
await new Promise((done) => daemon.listen(0, '127.0.0.1', done));
process.env.DSH_VOICE_HOTKEY_PORT = String(daemon.address().port);

// Regression guard: cordis throws when a plugin reads ctx.config without
// declaring it in inject (family-panel v0.1.0 incident; this plugin's own
// 2026-10-14 boot failure). The host half must apply with such a ctx.
const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href);
const hostileCtx = {
  provide: () => void 0,
  effect: () => void 0,
  webServer: {
    register: () => () => void 0,
  },
};
Object.defineProperty(hostileCtx, 'config', {
  get() {
    throw new Error('cannot get property config without inject');
  },
});
try {
  host.apply(hostileCtx);
  console.log('smoke: ok host apply survives config-less ctx');
} catch (err) {
  console.error('FAIL host apply:', err.message);
  failed += 1;
}

// Regression (2026-10-15, five desktop-host crashes): the 5s daemon timeout
// must not fire on a live SSE stream, and a daemon-side reset must end the
// browser stream instead of raising an uncaught exception.
const routes = new Map();
const server = http.createServer((req, res) => {
  const handler = routes.get(req.url);
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  handler(req, res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const ctx = {
  provide: () => void 0,
  effect: (fn) => fn(),
  webServer: {
    register: ({ path, handler }) => {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  },
};
host.apply(ctx);

const uncaught = [];
const onUncaught = (err) => uncaught.push(err);
process.on('uncaughtException', onUncaught);
const hung = setTimeout(() => {
  console.error('FAIL daemon-timeout regression: test hung');
  process.exit(1);
}, 20000);

const browserRes = await new Promise((done, fail) => {
  const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/agint-voice/events' }, done);
  req.on('error', fail);
});
let browserEnded = false;
browserRes.on('end', () => {
  browserEnded = true;
});
browserRes.resume();

await new Promise((done) => setTimeout(done, 6500));
if (browserEnded) {
  console.error('FAIL daemon-timeout regression: browser SSE ended while daemon idle');
  failed += 1;
}

for (const socket of daemonSockets) socket.destroy();
await new Promise((done) => setTimeout(done, 1000));
if (!browserEnded) {
  console.error('FAIL daemon-reset regression: browser SSE still open after daemon reset');
  failed += 1;
}
if (uncaught.length) {
  console.error('FAIL daemon-timeout regression: uncaught exception:', uncaught[0].code || uncaught[0].message);
  failed += 1;
}

clearTimeout(hung);
process.removeListener('uncaughtException', onUncaught);
server.close();
daemon.close();

if (failed) {
  console.error(`smoke: ${failed} FAIL`);
  process.exit(1);
}
console.log('smoke: ok (2 files, syntax + wiring + daemon-timeout regression)');
