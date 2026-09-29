#!/usr/bin/env node
/**
 * dsh-direct —— workbuddy 侧的 dsh 原生直连客户端（不经过浏览器 GUI）
 *
 * 通道原理（逆向自宿主源码，2026-09-29）：
 *   1) 认证：GET /?token=<launchToken> → 303 + Set-Cookie: dsh-auth-<sha256(host)>=v1.<payload>.<hmac>
 *      launchToken 每次重启必变，从 dsh-web.log 尾部提取。cookie 之后一路带上。
 *   2) 一元调用：POST http://<host>/api/<namespace>/<method>
 *      信封 { type:'client-request', rpcId, method, payload:{ args:{...} } }
 *      响应 { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }
 *   3) 流订阅：WS ws://<host>/api/remote.mux（带同一个 cookie），帧 open/item/end/cancel
 *      —— 一元方法不能走 WS（会报 unary Remote methods cannot be opened through the stream carrier）
 *
 * 用法：
 *   node bin/dsh-direct.mjs list
 *   node bin/dsh-direct.mjs prompt "你的消息" [--session <sessionId>] [--wait]
 *   node bin/dsh-direct.mjs page [--session <sessionId>] [--max 40]
 *   node bin/dsh-direct.mjs call session/list '{}'
 *   node bin/dsh-direct.mjs call session/page '{"address":{"kind":"session","sessionId":"session-xxx"},"throughSeq":999999}'
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const HOST = process.env.DSH_HOST ?? '127.0.0.1:3080';
const LOG = process.env.DSH_LOG ?? 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-web.log';

/** 从宿主日志尾部取最新 launch token（每次重启必变，不能复用旧的）。 */
function latestToken() {
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN;
  const text = readFileSync(LOG, 'utf8');
  const hits = [...text.matchAll(/dsh web:\s*http:\/\/[^\s?]*\?token=([A-Za-z0-9_-]+)/g)];
  if (hits.length === 0) throw new Error(`未从日志提取到 token: ${LOG}`);
  return hits[hits.length - 1][1];
}

let cookiePromise;
async function cookie() {
  cookiePromise ??= (async () => {
    const r = await fetch(`http://${HOST}/?token=${encodeURIComponent(latestToken())}`, { redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (!sc) throw new Error('token 换 cookie 失败：token 已失效或不是最新（重启后必变）');
    return sc.split(';')[0];
  })();
  return cookiePromise;
}

/** 一元 RPC。args 会被包成 { args } 载荷。 */
export async function call(endpoint, args = {}) {
  const rpcId = randomUUID();
  const r = await fetch(`http://${HOST}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await cookie() },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  });
  if (r.status === 404) throw new Error(`endpoint 未被认领: ${endpoint}（名字写错会 404，正确名字报的是 descriptor 错误）`);
  const body = await r.json();
  if (body.rpcId !== rpcId) throw new Error(`rpcId 不匹配: 发出 ${rpcId} 收到 ${body.rpcId}`);
  if (!body.result?.ok) throw new Error(`${endpoint} 失败: ${body.result?.error?.code ?? '?'} ${body.result?.error?.message ?? ''}`);
  return body.result.value;
}

async function pickSession() {
  const { items } = await call('session/list', { _request: {} });
  const live = items.filter(i => !i.origin);
  if (live.length === 0) throw new Error('没有可用会话');
  live.sort((a, b) => b.updatedAt - a.updatedAt);
  return live[0];
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? def : rest[i + 1];
};

if (cmd === 'list') {
  const { items } = await call('session/list', { _request: {} });
  console.log(`共 ${items.length} 个会话\n`);
  for (const it of items) {
    const t = it.projections?.values?.title;
    console.log(`${it.sessionId}  running=${it.running} blank=${it.blank} ${it.origin ?? ''}`);
    console.log(`    cwd=${it.cwd ?? '-'}  updated=${new Date(it.updatedAt).toISOString()}  title=${typeof t === 'string' ? t.slice(0, 60) : '-'}`);
  }
} else if (cmd === 'prompt') {
  const text = rest.find(a => !a.startsWith('--'));
  if (!text) throw new Error('缺少消息文本');
  const s = flag('session') ?? (await pickSession()).sessionId;
  const v = await call('session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId: s,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    },
  });
  console.log(JSON.stringify(v));
  console.log(`已投递到 ${s}。用 \`page --session ${s}\` 读回复。`);
} else if (cmd === 'page') {
  const s = flag('session') ?? (await pickSession()).sessionId;
  // throughSeq 不能超过宿主当前 cursor，否则报 past cursor —— 从 list 投影里取真实值
  let through = Number(flag('through', 0));
  if (!through) {
    const { items } = await call('session/list', { _request: {} });
    const hit = items.find(i => i.sessionId === s);
    through = hit?.projections?.asOfSeq ?? 0;
    if (!through) throw new Error(`拿不到 ${s} 的 asOfSeq`);
  }
  const v = await call('session/page', {
    request: {
      address: { kind: 'session', sessionId: s },
      throughSeq: through,
      maxMessages: Number(flag('max', 40)),
    },
  });
  for (const rec of v.records ?? []) {
    const e = rec.event ?? {};
    const role = e.role ?? e.type;
    const txt = typeof e.text === 'string' ? e.text : JSON.stringify(e.content ?? e).slice(0, 300);
    console.log(`#${e.seq ?? '?'} [${role}] ${txt.slice(0, 500)}`);
  }
} else if (cmd === 'call') {
  const [ep, argJson] = rest;
  console.log(JSON.stringify(await call(ep, argJson ? JSON.parse(argJson) : {}), null, 2));
} else {
  console.log('用法: list | prompt <文本> | page | call <endpoint> [json]');
}
