/**
 * agint-ov-strategy — AGINT × OpenViking 策略层（v0.2.0）。
 *
 * 定位（设计稿 proposals/agint-ov-strategy.md，2026-09-27 老板拍板）：
 *   官方 @openviking/dsh-memory-plugin bundle 已做「传输 + 生命周期」层；
 *   本插件是 AGINT 侧【唯一】消费缝（单缝原则 R1），职责有四件：
 *     1. 经验沉淀写入（dream/diagnosis 等产物 → OV，write-through 投影）
 *     2. 按域过滤（scope 白名单 + 长度过滤，噪声不入库）
 *     3. 策略侧召回（不经过 pre-step 的显式查询入口）
 *     4. 观测镜像（v0.2.0）：把 bundle/工具层的 OV 活动镜像进 agint 总线
 *        —— 背景：bus 存量 source 全 agint-*、0 条 ov.*，OV 的
 *        remember/find/search 与 <openviking-context> 注入在 AGINT 侧不可见。
 *        镜像 ≠ 重建：只读观测（R4），失败域与主路径隔离（R3）。
 *        通路 A  ctx.on('tools/post-execute')  → ov.tool.called     （OV MCP 工具调用）
 *        通路 B  wrap runtime.recallMessage    → ov.recall.checked  （pre-step 自动召回）
 *                wrap runtime.profileMessage   → ov.profile.delivered
 *        通路 C  wrap runtime.flush            → ov.session.flushed （提交观测，K112 出口）
 *
 * 四条硬规则：
 *   R1 单缝原则    —— 全仓只有本插件 ctx.get('openvikingMemory')，其他插件只消费 agint.ovStrategy
 *   R2 正本与投影  —— 本插件不持有 storageDomain；数据先由生产者落自己的域，本插件只投影
 *   R3 召回是增益不是依赖 —— recall/remember 全软失败，消费方必须可脱 OV 运转
 *   R4 不重建传输  —— 不直连 OV REST、不自建队列；一切经 runtime.client + enqueueWrite/enqueuePending
 *
 * 明确不消费（红线，见设计稿 §2）：
 *   ⛔ runtime.capture()          —— 官方已在真人会话捕获，策略层再走 = 双写
 *   ⛔ mcp__openviking__remember   —— 官方自述不 session-scoped
 *   ⛔ ExternalProvider 插槽       —— 评估稿 §10.7 已拍板不接
 *
 * 全软依赖（inject = []）：bundle 的 apply 顺序不保证，runtime 必须调用时取，不许缓存。
 * kill-switch：config enabled:false 或 env AGINT_OV_STRATEGY=off；出厂即开（K51）。
 *
 * Loader row（cordis.patch.yml 模板，本文件不挂载，由老板走 safe-update）：
 *   - insert:
 *       - id: agint-ov-strategy
 *         name: ./plugins/agint-ov-strategy/lib/index.js
 *         config: {}
 */

const name = 'agint-ov-strategy';
// 全软依赖：openvikingMemory（官方 bundle）与 agint.eventBus.* 都不进 inject ——
// 二者缺席时本插件必须照常 apply（设计稿 §5 失败域隔离）。
const inject = [];

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // scope 白名单：按域过滤（设计稿 §3.1 守卫 4）
  scopes: ['dream', 'diagnosis', 'evolution', 'manual'],
  // 自动沉淀订阅的 topic（总线精确匹配，无 wildcard；新 topic 显式加）
  autoTopics: ['dream.completed', 'diagnosis.completed'],
  // 文本长度过滤（§3.1 守卫 5）
  minTextLength: 20,
  maxTextLength: 4000,
  // 伪会话 cwd；null = process.cwd()。dsh 须从 D:/DSH 启动（peer.id=agint 已写入
  // D:/DSH/.openviking/config.json）；cwd 漂移时钉死本项（设计稿 §6.4）
  peerCwd: null,
  // 观测镜像（v0.2.0）：工具名过滤（大小写不敏感的 RegExp 来源串）
  observe: true,
  toolNamePattern: 'viking|openviking',
});

// ── retryable 判定（对齐 bundle shared/retryable.mjs 的保守口径）───────────
// bundle 内部实现未导出，不能 import；此处按同一语义本地实现：
// 网络/网关/限流类失败可重试（入 pending 队列等 drainer），4xx 语义错误不重试。
function isRetryableFailure(response) {
  if (!response) return true;                       // 无响应 ≈ 网络层失败
  if (response.ok === true) return false;
  const status = Number(response.status || 0);
  return status === 0 || status === 408 || status === 429
    || (status >= 500 && status <= 599);
}

// ── 计数器（内存级，status() 出口；重启清零，够用）────────────────────────
function makeCounters() {
  return {
    attempted: 0, succeeded: 0, failed: 0, recalled: 0,
    observedTool: 0, observedRecall: 0, observedProfile: 0, observedFlush: 0,
  };
}

// ── topic payload → 记忆文本（自动沉淀策略，设计稿 §4）────────────────────
// 返回 { scope, text, traceId } 或 null（不记）。
function dreamSummary(payload) {
  const p = payload || {};
  const promoted = Number(p.countPromoted || 0);
  if (promoted <= 0) return null;                   // 空转 sweep 不记（§4 触发条件）
  const dedupe = p.dedupeStats && typeof p.dedupeStats === 'object'
    ? `；去重 dropped=${p.dedupeStats.dropped ?? '?'}`
    : '';
  const text = `dream sweep 完成：sweepId=${p.sweepId ?? '?'}；`
    + `候选=${p.countCandidates ?? 0} 门禁=${p.countGated ?? 0} 晋升=${promoted}`
    + `${p.diaryPath ? `；diary=${p.diaryPath}` : ''}${dedupe}`;
  return { scope: 'dream', text, traceId: p.sweepId ? String(p.sweepId) : undefined };
}

function diagnosisSummary(payload) {
  const p = payload || {};
  let roots = '';
  if (p.rootCauseDistribution && typeof p.rootCauseDistribution === 'object') {
    try { roots = JSON.stringify(p.rootCauseDistribution); } catch { roots = '{}'; }
  }
  const text = `诊断报告完成：reportId=${p.reportId ?? '?'}；`
    + `clusterCount=${p.clusterCount ?? 0}；rootCauseDistribution=${roots}`;
  return { scope: 'diagnosis', text, traceId: p.reportId ? String(p.reportId) : undefined };
}

const TOPIC_SUMMARIZERS = {
  'dream.completed': dreamSummary,
  'diagnosis.completed': diagnosisSummary,
};

function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  // kill-switch（K51：kill-switch ≠ 默认关；env 只做总闸，不做配置面）
  if (String(process.env.AGINT_OV_STRATEGY || '').toLowerCase() === 'off') {
    cfg.enabled = false;
  }

  let disposed = false;
  const counters = makeCounters();
  const unsubscribers = [];

  ctx.effect(() => () => {
    disposed = true;
    for (const u of unsubscribers) {
      try { u(); } catch { /* 卸载互不连坐 */ }
    }
    unsubscribers.length = 0;
  });

  // ── runtime 探测：调用时取，绝不缓存（bundle apply 顺序不保证）─────────
  const runtimeRaw = () => (
    typeof ctx.get === 'function' ? ctx.get('openvikingMemory') : null
  );
  // 带「观测补挂」的取用口：每次取 runtime 顺带尝试挂镜像（WeakSet 幂等；
  // ensureObserver 是函数声明，提升可用）。bundle 晚于本插件 apply 时由此补挂。
  const runtimeNow = () => {
    const rt = runtimeRaw();
    if (rt) ensureObserver();
    return rt;
  };

  // ── 观测出口（软依赖 event-bus，降级不抛；与全仓消费方同策略）──────────
  async function publishEvent(topic, payload) {
    const p = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
    if (typeof p !== 'function') return false;
    try {
      await p({ topic, version: 1, source: name, payload });
      return true;
    } catch {
      return false;                                 // 观测失败不反噬主路径（R3）
    }
  }

  const scopeAllowed = (scope) => Array.isArray(cfg.scopes) && cfg.scopes.includes(scope);

  // ══ 观测镜像（v0.2.0，设计稿 §3.4）═══════════════════════════════════════
  // 只读观测：不改传输（R4）、不改执行（next 恒放行）、失败不反噬（R3）。
  // runtime 包装走「对象方法替换」：bundle 内部在事件时刻按属性查找调用
  // （index.mjs: runtime.recallMessage(...)），同一对象引用 ⇒ 包装生效；
  // 若 provider 被冻结则赋值抛 TypeError，被捕获降级（观测缺席但主路径无损）。
  const wrappedRuntimes = new WeakSet();
  const wrapState = { recallMessage: false, profileMessage: false, flush: false };

  const jsonSize = (v) => {
    try { return v ? JSON.stringify(v).length : 0; } catch { return 0; }
  };
  // 查询规模代理：只取最后一条消息的文本长度（每步一次，不做全量 stringify）
  const lastMessageSize = (messages) => {
    try {
      if (!Array.isArray(messages) || messages.length === 0) return 0;
      const c = messages[messages.length - 1]?.content;
      return typeof c === 'string' ? c.length : jsonSize(c);
    } catch { return 0; }
  };
  // 工具参数只记键名（内容可能携带记忆正文，不入总线）
  const argKeys = (args) => {
    if (!args || typeof args !== 'object') return [];
    try { return Object.keys(args).slice(0, 8); } catch { return []; }
  };

  function wrapMethod(obj, key, after) {
    const orig = obj?.[key];
    if (typeof orig !== 'function') return false;
    const wrapped = function (...args) {
      const p = orig.apply(this, args);          // 永远先委托，结果原样返回
      Promise.resolve(p).then(
        (result) => { try { after(args, result, null); } catch { /* 观测互不连坐 */ } },
        (err) => { try { after(args, null, err); } catch { /* 同上 */ } },
      );
      return p;
    };
    try {
      obj[key] = wrapped;
      return true;
    } catch {
      return false;                              // frozen/readonly → 观测降级
    }
  }

  // 挂载时机不敏感：apply 时试一次；之后每次 runtimeNow / 工具调用都会再试
  //（WeakSet 保证幂等）。bundle apply 晚于本插件时由此补挂。
  function ensureObserver() {
    if (disposed || !cfg.enabled || !cfg.observe) return;
    const rt = runtimeRaw();
    if (!rt || wrappedRuntimes.has(rt)) return;
    wrappedRuntimes.add(rt);
    wrapState.recallMessage = wrapMethod(rt, 'recallMessage', (args, result, err) => {
      counters.observedRecall += 1;
      publishEvent('ov.recall.checked', {
        injected: !err && Boolean(result),
        querySize: lastMessageSize(args[1]),
        blockSize: err ? 0 : jsonSize(result),
        error: err ? String(err?.message || err) : null,
      });
    });
    wrapState.profileMessage = wrapMethod(rt, 'profileMessage', (args, result, err) => {
      if (err || !result) return;                // profile 每会话至多注入一次，只记成功
      counters.observedProfile += 1;
      publishEvent('ov.profile.delivered', { blockSize: jsonSize(result) });
    });
    wrapState.flush = wrapMethod(rt, 'flush', (args, result, err) => {
      counters.observedFlush += 1;
      publishEvent('ov.session.flushed', {
        sessionId: args?.[0]?.id ?? null,
        ok: !err,
        error: err ? String(err?.message || err) : null,
      });
    });
  }

  // 通路 A：镜像 dsh 里的 OV MCP 工具调用（remember/find/search 走的通道）。
  // 签名对齐 bundle uri-guard.mjs 的 noticeVikingUri：(exec, result, next)，
  // 恒 next() 放行——镜像绝不拦截执行。
  function wireToolObserver() {
    if (!cfg.enabled || !cfg.observe) return;
    if (typeof ctx.on !== 'function') return;    // 宿主无钩子面 → 观测缺席
    try {
      const re = new RegExp(cfg.toolNamePattern, 'i');
      const unsub = ctx.on('tools/post-execute', async (exec, result, next) => {
        ensureObserver();                        // 每次工具调用都是一次补挂机会
        const toolName = String(exec?.name || '');
        if (re.test(toolName)) {
          counters.observedTool += 1;
          const errText = result?.error?.message || (result?.isError ? 'tool-error' : null);
          publishEvent('ov.tool.called', {
            tool: toolName,
            argKeys: argKeys(exec?.arguments),
            ok: !errText,
            error: errText,
          });
        }
        return next();
      });
      if (typeof unsub === 'function') unsubscribers.push(unsub);
    } catch {
      // 注册失败不抛（§5 失败域隔离）
    }
  }

  // ── 核心：经验沉淀写入（§3.1）───────────────────────────────────────────
  async function remember(input) {
    counters.attempted += 1;
    const fail = async (reason) => {
      counters.failed += 1;
      await publishEvent('ov.strategy.write-failed', { scope: input?.scope, reason });
      return { ok: false, reason };
    };

    if (disposed) return fail('disposed');
    if (!cfg.enabled) return fail('disabled');
    if (!input || typeof input !== 'object') return fail('bad-input');
    const { scope, text, traceId } = input;
    if (typeof scope !== 'string' || !scope) return fail('bad-scope');
    if (!scopeAllowed(scope)) return fail('scope-not-allowed');
    if (typeof text !== 'string' || text.trim().length < cfg.minTextLength) return fail('too-short');
    if (text.length > cfg.maxTextLength) return fail('too-long');

    const rt = runtimeNow();
    if (!rt || typeof rt.stateFor !== 'function' || !rt.client) return fail('bundle-unavailable');

    // 伪会话：OV 侧落成 dsh-agint-<scope>-<trace|ts>，与真人会话天然区分（§2）
    const pseudoId = `agint-${scope}-${traceId || Date.now()}`;
    const pseudo = { id: pseudoId, header: { cwd: cfg.peerCwd || process.cwd() } };
    const state = rt.stateFor(pseudo);
    await rt.ensureState(state);
    if (!state.ready) {
      // retryable（网络类）→ 理论上该走 capture 路径，但 capture 是红线；
      // 这里直接软失败，等下次投影时 ensureState 会重试（官方 ensureState 幂等）。
      return fail(state.initializationRetryable ? 'ov-unreachable' : 'ov-not-ready');
    }

    // payload 形状对齐 bundle capture.mjs:92（role + content；peer_id 随行）
    const payload = {
      role: 'user',
      content: `[${scope}] ${text.trim()}`,
      peer_id: state.config.peerId,
    };

    let result = null;
    rt.enqueueWrite(state, async () => {
      const r = await rt.client.addMessage(state.ovSessionId, payload, state.config.peerId);
      if (!r?.ok && isRetryableFailure(r)) {
        // 失败入 pending 队列，drainer（60s tick）自动重放（R4：不重建传输）
        await rt.enqueuePending(state, 'addMessage', payload);
      }
      result = r;
    });
    await state.writes;                             // enqueueWrite 不回抛，等队列落定

    const ok = Boolean(result?.ok);
    // dispose：官方 teardown commit（受全局 syncTurns 门控）+ 清 states Map（§6.1）
    if (typeof rt.dispose === 'function') {
      try { await rt.dispose(pseudo); } catch { /* 清理失败不反噬返回值 */ }
    }

    if (ok) {
      counters.succeeded += 1;
      await publishEvent('ov.strategy.remembered', {
        scope, ovSessionId: state.ovSessionId, traceId: traceId || null,
      });
      return { ok: true, ovSessionId: state.ovSessionId };
    }
    return fail(`add-message-failed:${result?.status || result?.error?.code || 'unknown'}`);
  }

  // ── 策略侧召回（§3.2）：软失败是契约（R3）────────────────────────────────
  async function recall(query) {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    if (typeof query !== 'string' || !query.trim()) return { ok: false, reason: 'bad-query' };
    const rt = runtimeNow();
    if (!rt || !rt.client || typeof rt.client.fetchJSON !== 'function') {
      return { ok: false, reason: 'bundle-unavailable' };
    }
    try {
      const res = await rt.client.fetchJSON('/api/v1/search/search', {
        method: 'POST',
        body: JSON.stringify({ query: query.trim(), mode: 'context' }),
      });
      if (!res?.ok) return { ok: false, reason: `search-failed:${res?.status || 0}` };
      const result = res.result || {};
      counters.recalled += 1;
      return {
        ok: true,
        entries: Array.isArray(result.entries) ? result.entries : [],
        digest: result.digest ?? null,
      };
    } catch (e) {
      return { ok: false, reason: `search-error:${e?.message || e}` };
    }
  }

  // ── 状态出口（§3.3）──────────────────────────────────────────────────────
  function status() {
    return {
      name,
      enabled: cfg.enabled,
      runtimeAvailable: Boolean(runtimeNow()),
      scopes: (cfg.scopes || []).slice(),
      autoTopics: (cfg.autoTopics || []).slice(),
      observer: {
        enabled: cfg.enabled && cfg.observe,
        wraps: { ...wrapState },
      },
      counters: { ...counters },
      disposed,
    };
  }

  // ── 总线自动沉淀（§4）：async 订阅（sync 配额 ≤3 属门禁边，本插件不占）──
  function wireBusSubscriptions() {
    if (!cfg.enabled) return;
    const topics = (cfg.autoTopics || []).filter(t => typeof TOPIC_SUMMARIZERS[t] === 'function');
    if (topics.length === 0) return;
    const subscribe = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe !== 'function') return;    // bus 不可用：静默降级（§5）
    try {
      const unsub = subscribe(
        { subscriber: name, topics, mode: 'async' },
        async (envelope) => {
          const summarize = TOPIC_SUMMARIZERS[envelope?.topic];
          if (!summarize || disposed) return;
          const summary = summarize(envelope?.payload);
          if (!summary) return;                     // 不满足触发条件（如空转 sweep）
          await remember({ ...summary, meta: { via: 'bus', topic: envelope.topic } });
        },
      );
      if (typeof unsub === 'function') unsubscribers.push(unsub);
    } catch {
      // 订阅失败不抛（§5 失败域隔离表第 4 行）
    }
  }
  wireBusSubscriptions();
  wireToolObserver();
  ensureObserver();   // 初始补挂一次（对齐注释契约「apply 时试一次」；bundle 晚 apply 时由 runtimeNow/工具 hook 再补）

  ctx.provide('agint.ovStrategy', { remember, recall, status });
}

export { name, inject, apply, DEFAULT_CONFIG, isRetryableFailure, TOPIC_SUMMARIZERS };
