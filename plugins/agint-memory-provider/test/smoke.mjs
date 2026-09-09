#!/usr/bin/env node
// agint-memory-provider smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证（设计稿 §11.4）：
//   - 导出契约（name / inject / apply / ConfigSchema）
//   - FROZEN schema + LIMITS 与设计稿 §4 一致
//   - storage spec shape（域名 / 5 表 / 版本）
//   - pack 函数元数据注入
//   - ExternalProvider 契约 + validateProvider 完整性校验
//   - BuiltinProvider 始终可用 + 默认只读（不写 recalls）
//   - 琐碎输入过滤（中英文正例 / 反例）
//   - MemoryManager 默认激活 builtin + 琐碎输入跳过 prefetch

import test from 'node:test';
import assert from 'node:assert/strict';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import { ExternalProvider, validateProvider } from '../lib/provider.js';
import { BuiltinProvider, formatMemories } from '../lib/builtin-provider.js';
import { MockProvider } from '../lib/mock-provider.js';
import { ProviderRegistry } from '../lib/registry.js';
import { MemoryManager, classifyErrorType, withTimeout, PrefetchTimeoutError, MAX_CHECKPOINT_FAILURES } from '../lib/manager.js';
import { isTrivialPrompt } from '../lib/trivial.js';

// ── 导出契约 ─────────────────────────────────────────────────────────────

test('导出契约：name / inject / apply / ConfigSchema', () => {
  assert.equal(plugin.name, 'agint-memory-provider');
  // 硬依赖：自己的存储域 + agint.memory（封装为 builtin）+ tools（阶段 2 工具注册）；
  // event-bus 是软依赖不进 inject
  assert.deepEqual(plugin.inject, ['storageDomain', 'agint.memory', 'tools']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);

  // 默认配置 = 设计稿 §8.1
  const c = plugin.ConfigSchema.parse({});
  assert.equal(c.active_provider, 'builtin');
  assert.equal(c.fallback_enabled, true);
  assert.equal(c.max_consecutive_failures, 3);
  assert.equal(c.prefetch_enabled, true);
  assert.equal(c.prefetch_timeout_ms, 3000);
  assert.equal(c.trivial_prompt_filter_enabled, true);
  assert.equal(c.recall_indicator_enabled, true);
  assert.equal(c.pre_compress_checkpoint_enabled, true);
  assert.equal(c.pre_compress_fail_closed, true);
  assert.equal(c.sync_turn_enabled, true);
  assert.equal(c.require_human_approval_switch, true);
  assert.equal(c.log_sensitive_data, false);
  assert.equal(c.debug_mode, false);
});

test('§8.2 运行时可配置子集与设计稿一致', () => {
  assert.deepEqual([...schema.RUNTIME_CONFIG_KEYS], [
    'active_provider', 'prefetch_enabled', 'trivial_prompt_filter_enabled',
    'fallback_enabled', 'max_consecutive_failures', 'debug_mode',
  ]);
});

// ── FROZEN schema / LIMITS（设计稿 §4）───────────────────────────────────

test('LIMITS：provider_config 20 / activation 1000 / fallback 5000 / checkpoint 500 / audit 1000', () => {
  assert.equal(storage.LIMITS.PROVIDER_CONFIG, 20);
  assert.equal(storage.LIMITS.ACTIVATION_LOG, 1000);
  assert.equal(storage.LIMITS.FALLBACK_EVENTS, 5000);
  assert.equal(storage.PRE_COMPRESS_CHECKPOINTS ?? storage.LIMITS.PRE_COMPRESS_CHECKPOINTS, 500);
  assert.equal(storage.LIMITS.AUDIT_LOG, 1000);
});

test('滚动清理表：activation_log / fallback_events / audit_log（§4.3 §4.4 §4.6）', () => {
  assert.deepEqual([...schema.ROLLING_TABLES], ['activation_log', 'fallback_events', 'audit_log']);
  assert.equal(storage.isRolling('activation_log'), true);
  assert.equal(storage.isRolling('audit_log'), true);
  assert.equal(storage.isRolling('fallback_events'), true);
  // provider_config / pre_compress_checkpoints 只 warn 不 prune
  assert.equal(storage.isRolling('provider_config'), false);
  assert.equal(storage.isRolling('pre_compress_checkpoints'), false);
});

test('FROZEN 枚举与设计稿 §4.3/§4.4/§4.5 一致', () => {
  assert.deepEqual([...schema.ACTIVATION_ACTIONS], ['activate', 'deactivate', 'fallback', 'recover']);
  assert.deepEqual([...schema.VALIDATION_RESULTS], ['available', 'unavailable', 'error']);
  assert.deepEqual([...schema.FALLBACK_OPERATIONS],
    ['prefetch', 'sync_turn', 'handle_tool_call', 'on_pre_compress']);
  assert.deepEqual([...schema.FALLBACK_ERROR_TYPES],
    ['network', 'timeout', 'rate_limit', 'auth', 'unknown']);
  assert.deepEqual([...schema.RECOVERY_ACTIONS], ['fallback_to_builtin', 'retry', 'switch_provider']);
  assert.deepEqual([...schema.CHECKPOINT_STATUSES], ['success', 'failed', 'skipped', 'best_effort']);
  assert.equal(schema.BUILTIN_PROVIDER, 'builtin');
});

test('storage spec：agint_memory_provider 域 + 5 表 + version 1', () => {
  assert.equal(storage.spec.name, 'agint_memory_provider');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  if (tables.length) {
    for (const t of ['provider_config', 'activation_log', 'fallback_events',
      'pre_compress_checkpoints', 'audit_log']) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
  }
});

test('checkLimit：超限返回 warn 形态，未超返回 null', () => {
  assert.equal(storage.checkLimit('provider_config', 20), null);
  const w = storage.checkLimit('provider_config', 21);
  assert.ok(w && w._warn && w.limit === 20);
  assert.equal(storage.checkLimit('audit_log', 1000), null);
  assert.ok(storage.checkLimit('audit_log', 1001)?._warn);
  assert.equal(storage.checkLimit('nonexistent', 99999), null);
});

test('pack 函数：注入 id/kind/timestamp 且过 entry schema', () => {
  const pc = storage.packProviderConfig({ providerName: 'honcho', config: { apiBaseUrl: 'x' } });
  assert.equal(pc.id, 'pc_honcho');
  assert.equal(pc.kind, 'provider_config');
  assert.equal(pc.providerName, 'honcho');
  assert.equal(pc.isConfigured, false);

  const al = storage.packActivationLog({
    action: 'activate', providerName: 'builtin', reason: '启动激活',
  });
  assert.match(al.id, /^al_\d{8}_/);
  assert.equal(al.kind, 'activation_log');
  assert.equal(al.targetProvider, null);

  const fe = storage.packFallbackEvent({
    providerName: 'honcho', operation: 'prefetch', errorType: 'timeout',
  });
  assert.match(fe.id, /^fe_\d{8}_/);
  assert.equal(fe.kind, 'fallback_event');
  assert.equal(fe.recovered, false);

  const pcc = storage.packCheckpoint({ providerName: 'honcho', apiVersion: 2 });
  assert.match(pcc.id, /^pcc_\d{8}_/);
  assert.equal(pcc.kind, 'pre_compress_checkpoint');
  assert.equal(pcc.checkpointStatus, 'best_effort');

  const audit = storage.packAudit({
    actor: 'system', action: 'provider_activated', targetType: 'provider', targetId: 'builtin',
  });
  assert.match(audit.id, /^audit_\d{8}_/);
  assert.equal(audit.kind, 'audit_log');
});

test('provider_config id 派生：非法字符替换为下划线且稳定', () => {
  assert.equal(storage.providerConfigId('honcho'), 'pc_honcho');
  assert.equal(storage.providerConfigId('mock-external'), 'pc_mock-external');
  assert.equal(storage.providerConfigId('a.b/c'), 'pc_a_b_c');
  // 幂等
  assert.equal(storage.providerConfigId('honcho'), storage.providerConfigId('honcho'));
});

test('pack 拒绝非法枚举（FROZEN 生效）', () => {
  assert.throws(() => storage.packActivationLog({ action: 'explode', providerName: 'x' }));
  assert.throws(() => storage.packFallbackEvent({ providerName: 'x', operation: 'bogus' }));
  assert.throws(() => storage.packCheckpoint({ providerName: 'x', checkpointStatus: 'bogus' }));
  assert.throws(() => storage.packAudit({ actor: '', action: 'a', targetType: 't', targetId: 'i' }));
});

// ── ExternalProvider 契约（设计稿 §5.1）──────────────────────────────────

test('ExternalProvider：未 override 的必须方法抛 not implemented', async () => {
  const bare = new ExternalProvider();
  assert.throws(() => bare.name, /not implemented/);
  assert.throws(() => bare.isAvailable(), /not implemented/);
  await assert.rejects(() => bare.initialize('s', {}), /not implemented/);
  // getToolSchemas 是同步方法（§5.1 返回 Array，非 Promise）→ 用 throws
  assert.throws(() => bare.getToolSchemas(), /not implemented/);
  // 默认实现不抛
  assert.equal(bare.preCompressCheckpointApiVersion, 1);
  assert.equal(bare.unavailableReason(), '');
  assert.equal(bare.systemPromptBlock(), '');
  assert.equal(await bare.prefetch('q', {}), '');
  assert.equal(bare.recallStatus(), null);
  assert.deepEqual(bare.getConfigSchema(), []);
  assert.deepEqual(bare.backupPaths(), []);
  await bare.syncTurn('u', 'a', {});
  await bare.shutdown();
  await bare.onTurnStart(1, 'm', {});
  await bare.onSessionEnd([]);
  await bare.onSessionSwitch('s2', {});
  assert.equal(await bare.onPreCompress([]), '');
  await bare.onDelegation({}, {}, {});
  await bare.onMemoryWrite('write', 'memory', 'c', {});
  await bare.queuePrefetch('q', {});
  await bare.saveConfig({}, '/tmp');
});

test('ExternalProvider.handleToolCall 默认拒绝未声明的工具（不静默吞）', async () => {
  const bare = new ExternalProvider();
  await assert.rejects(() => bare.handleToolCall('whatever', {}, {}), /does not handle tool/);
});

test('validateProvider：完整实现通过，缺方法/坏 name/坏 apiVersion 被拦', () => {
  // 完整
  const good = validateProvider(new MockProvider());
  assert.equal(good.valid, true, JSON.stringify(good));
  assert.equal(good.name, 'mock');
  assert.deepEqual(good.missing, []);
  assert.deepEqual(good.errors, []);

  // 裸基类：三个必须方法全缺
  const bad = validateProvider(new ExternalProvider());
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length > 0, 'name getter 抛错应进 errors');

  // 只缺 getToolSchemas
  class Partial extends ExternalProvider {
    get name() { return 'partial'; }
    isAvailable() { return true; }
    async initialize() {}
  }
  const p = validateProvider(new Partial());
  assert.equal(p.valid, false);
  assert.deepEqual(p.missing, ['getToolSchemas']);

  // apiVersion 非法
  class BadVersion extends MockProvider {
    get preCompressCheckpointApiVersion() { return 3; }
  }
  const bv = validateProvider(new BadVersion());
  assert.equal(bv.valid, false);
  assert.ok(bv.errors.some((e) => /preCompressCheckpointApiVersion/.test(e)));

  // 非对象
  assert.equal(validateProvider(null).valid, false);
  assert.equal(validateProvider(42).valid, false);

  // getToolSchemas 返回非数组
  class BadSchemas extends ExternalProvider {
    get name() { return 'badschemas'; }
    isAvailable() { return true; }
    async initialize() {}
    getToolSchemas() { return { not: 'an array' }; }
  }
  const bs = validateProvider(new BadSchemas());
  assert.equal(bs.valid, false);
  assert.ok(bs.errors.some((e) => /必须返回数组/.test(e)));
});

test('validateProvider：同一性比较能识破「继承 stub 却声称已实现」', () => {
  class Fake extends ExternalProvider {
    get name() { return 'fake'; }
    // 故意不 override isAvailable —— typeof 仍是 function，但 === 基类 stub
  }
  const r = validateProvider(new Fake());
  assert.equal(r.valid, false);
  assert.ok(r.missing.includes('isAvailable'));
  assert.ok(r.missing.includes('initialize'));
  assert.ok(r.missing.includes('getToolSchemas'));
});

// ── ProviderRegistry（设计稿 §3.1 [2]）───────────────────────────────────

test('ProviderRegistry：注册 / 查询 / 列出，builtin 排首位', () => {
  const reg = new ProviderRegistry();
  const mock = new MockProvider();
  const builtin = new BuiltinProvider({ memory: fakeMemory(), config: () => schema.DEFAULT_CONFIG });

  // 先注册外部，再注册 builtin —— list() 仍应把 builtin 排首位
  assert.equal(reg.register(mock).registered, true);
  assert.equal(reg.register(builtin).registered, true);
  assert.deepEqual(reg.list(), ['builtin', 'mock']);
  assert.deepEqual(reg.listExternal(), ['mock']);
  assert.equal(reg.get('mock'), mock);
  assert.equal(reg.has('builtin'), true);
  assert.equal(reg.has('nope'), false);
});

test('ProviderRegistry：拒绝不合格实现，且不放进表里（§3.1 [2]）', () => {
  const reg = new ProviderRegistry();
  const r = reg.register(new ExternalProvider());
  assert.equal(r.registered, false);
  assert.ok(r.reason);
  assert.equal(reg.list().length, 0, '被拒的 provider 不得进表');
});

test('ProviderRegistry：builtin 是保留名，外部 provider 不得占用（§9.1 L0）', () => {
  const reg = new ProviderRegistry();
  const builtin = new BuiltinProvider({ memory: fakeMemory(), config: () => schema.DEFAULT_CONFIG });
  assert.equal(reg.register(builtin).registered, true);

  const squatter = new MockProvider({ name: 'builtin' });
  const r = reg.register(squatter);
  assert.equal(r.registered, false);
  assert.match(r.reason, /保留|占用/);
  // 原 builtin 未被顶替
  assert.equal(reg.get('builtin'), builtin);
});

test('ProviderRegistry.describe：isAvailable 抛错不污染整个列表（§9.2 约束 6）', () => {
  const reg = new ProviderRegistry();
  class Throwy extends ExternalProvider {
    get name() { return 'throwy'; }
    isAvailable() { throw new Error('boom'); }
    async initialize() {}
    getToolSchemas() { return []; }
  }
  reg.register(new Throwy());
  reg.register(new MockProvider());
  const d = reg.describe();
  assert.equal(d.length, 2);
  const t = d.find((x) => x.name === 'throwy');
  assert.equal(t.available, false);
  assert.match(t.error, /boom/);
  // 另一个 provider 正常
  assert.equal(d.find((x) => x.name === 'mock').available, true);
});

// ── 琐碎输入过滤（设计稿 §7 + §14.2 中文待验证项）────────────────────────

test('isTrivialPrompt：正例（中英文确认/问候/推进/致谢 + 斜杠命令 + 空）', () => {
  const positives = [
    // 设计稿 §7.2 原英文集合
    'yes', 'no', 'ok', 'okay', 'sure', 'thanks', 'thank you', 'y', 'n', 'yep',
    'nope', 'yeah', 'nah', 'hi', 'hey', 'hello', 'yo', 'sup', 'continue',
    'go ahead', 'do it', 'proceed', 'got it', 'cool', 'nice', 'great', 'done',
    'next', 'lgtm', 'k',
    // 带标点/空白/大小写
    'OK!!', 'thanks.', '  yes  ', 'Got it?', 'LGTM~',
    // 斜杠命令（§7.2）
    '/reset', '/new', '/branch', '/help',
    // 空输入（§7.2）
    '', '   ', '\n\t',
    // §14.2 中文场景
    '好的', '继续', '谢谢', '嗯', '嗯嗯', '可以', '行', '是的', '对', '收到',
    '知道了', '明白了', '懂了', '了解', '你好', '您好', '辛苦了', '多谢',
    '不用', '算了', '好的，', '谢谢！', '继续。', '收到~',
  ];
  for (const t of positives) {
    assert.equal(isTrivialPrompt(t), true, `应判为琐碎: ${JSON.stringify(t)}`);
  }
});

test('isTrivialPrompt：反例（携带实质内容，绝不可误判）', () => {
  const negatives = [
    // §7.2 明确要求的前缀陷阱
    'k8s', 'yolo', 'note', 'knowledge', 'kernel',
    // 英文实义句
    'ok, now refactor the prefetch timeout logic',
    'continue writing chapter three',
    'thanks, but I have another question about providers',
    'yes please add the fallback events table',
    // 中文实义句
    '好的，我们开始写第三章',
    '继续优化 prefetch 超时逻辑',
    '谢谢你，不过我还想问一个问题',
    '帮我看下这个降级为什么没触发',
    '收到，请把 fallback_events 表加上索引',
    '可以的，那就按方案 B 实施',
    // 混合
    'ok 但是有个问题',
    '好的呀',
  ];
  for (const t of negatives) {
    assert.equal(isTrivialPrompt(t), false, `不应判为琐碎: ${JSON.stringify(t)}`);
  }
});

test('isTrivialPrompt：非字符串输入不抛错', () => {
  assert.equal(isTrivialPrompt(null), true);
  assert.equal(isTrivialPrompt(undefined), true);
  assert.equal(isTrivialPrompt(123), false);
  assert.equal(isTrivialPrompt({}), false);
});

// ── BuiltinProvider（设计稿 §5.2 + 三处纠正）─────────────────────────────

/** 最小 agint.memory 替身：只实现被 BuiltinProvider 用到的方法 */
function fakeMemory(rows = []) {
  return {
    _rows: rows,
    _searchCalls: [],
    _recallCalls: [],
    async search(q, opts = {}) {
      this._searchCalls.push({ q, opts });
      const s = String(q).toLowerCase();
      return this._rows
        .filter((r) => r.content.toLowerCase().includes(s))
        .slice(0, opts.limit ?? 20);
    },
    async recall(id) {
      this._recallCalls.push(id);
      return { id, recalls: 1 };
    },
    async stats() {
      return { total: this._rows.length, byType: {}, byLevel: {}, avgConfidence: 0.5 };
    },
  };
}

const sampleRows = () => ([
  { id: 'm1', type: 'preference', level: 'L1', content: '用户偏好简洁回答' },
  { id: 'm2', type: 'lesson', level: 'L2', content: '存储域名称进程内独占' },
  { id: 'm3', type: 'decision', level: 'L1', content: '简洁优先于冗余' },
]);

test('BuiltinProvider：始终可用（§9.1 L0）+ name=builtin + apiVersion=1', () => {
  const b = new BuiltinProvider({ memory: fakeMemory(), config: () => schema.DEFAULT_CONFIG });
  assert.equal(b.name, 'builtin');
  assert.equal(b.isAvailable(), true);
  assert.equal(b.unavailableReason(), '');
  assert.equal(b.preCompressCheckpointApiVersion, 1);
  assert.equal(validateProvider(b).valid, true, JSON.stringify(validateProvider(b)));
});

test('BuiltinProvider 纠正 1：不 open 存储域，构造只需 memory 服务', () => {
  // 构造不接 storageDomain —— 证明不依赖 ctx.storageDomain.open(agintMemorySpec)
  const b = new BuiltinProvider({ memory: fakeMemory(), config: () => schema.DEFAULT_CONFIG });
  assert.ok(b);
  assert.throws(() => new BuiltinProvider({ config: () => ({}) }), /agint\.memory/);
  assert.throws(() => new BuiltinProvider({ memory: {} }), /config 必须/);
});

test('BuiltinProvider 纠正 2：shutdown 只复位自身状态，不关别人的域', async () => {
  const mem = fakeMemory(sampleRows());
  const b = new BuiltinProvider({ memory: mem, config: () => schema.DEFAULT_CONFIG });
  await b.initialize('s1', {});
  assert.equal(b.initialized, true);
  await b.prefetch('偏好', {});
  assert.equal(b.lastRecallCount, 1);

  // memory 服务没有 close —— 若 builtin 试图关 agint 域就会 TypeError
  assert.equal(typeof mem.close, 'undefined');
  await b.shutdown();
  assert.equal(b.initialized, false);
  assert.equal(b.sessionId, null);
  assert.equal(b.lastRecallCount, 0);
});

test('BuiltinProvider 纠正 3：prefetch 默认只读，不写 recalls/lastRecall（零行为变化）', async () => {
  const mem = fakeMemory(sampleRows());
  const b = new BuiltinProvider({ memory: mem, config: () => schema.DEFAULT_CONFIG });
  await b.initialize('s1', {});

  const ctx = await b.prefetch('简洁', { sessionId: 's1' });
  assert.ok(ctx.includes('用户偏好简洁回答'));
  assert.equal(mem._searchCalls.length, 1, '应走 search');
  assert.deepEqual(mem._recallCalls, [], '默认不得调 recall（会改 decay 输入）');
});

test('BuiltinProvider：builtin_recall_touch=true 时才写回 recalls（人工开关）', async () => {
  const mem = fakeMemory(sampleRows());
  const cfg = { ...schema.DEFAULT_CONFIG, builtin_recall_touch: true };
  const b = new BuiltinProvider({ memory: mem, config: () => cfg });
  await b.initialize('s1', {});
  await b.prefetch('偏好', { sessionId: 's1' });
  assert.deepEqual(mem._recallCalls, ['m1'], '开关打开后应写回');
});

test('BuiltinProvider：空查询返回空串，不把全表旧记忆注入 prompt', async () => {
  const mem = fakeMemory(sampleRows());
  const b = new BuiltinProvider({ memory: mem, config: () => schema.DEFAULT_CONFIG });
  await b.initialize('s1', {});
  assert.equal(await b.prefetch('', {}), '');
  assert.equal(await b.prefetch('   ', {}), '');
  assert.equal(b.lastRecallCount, 0);
  assert.deepEqual(mem._searchCalls, [], '空查询不应发起检索');
});

test('BuiltinProvider：recallStatus 是确定性指示器（§3.1 [5]）', async () => {
  const mem = fakeMemory(sampleRows());
  const b = new BuiltinProvider({ memory: mem, config: () => schema.DEFAULT_CONFIG });
  await b.initialize('s1', {});
  assert.deepEqual(b.recallStatus(), { providerLabel: 'builtin', count: 0, glyph: '🧠' });
  await b.prefetch('偏好', {});
  assert.deepEqual(b.recallStatus(), { providerLabel: 'builtin', count: 1, glyph: '🧠' });
  await b.prefetch('不存在的关键词zzz', {});
  assert.deepEqual(b.recallStatus(), { providerLabel: 'builtin', count: 0, glyph: '🧠' });
});

test('BuiltinProvider：召回条数受 builtin_recall_limit 约束', async () => {
  const mem = fakeMemory(sampleRows());
  const cfg = { ...schema.DEFAULT_CONFIG, builtin_recall_limit: 2 };
  const b = new BuiltinProvider({ memory: mem, config: () => cfg });
  await b.initialize('s1', {});
  // 「的」在三条里都出现（偏好/独占/冗余均含「的」或匹配）——用宽匹配词
  await b.prefetch('用', {});
  assert.equal(mem._searchCalls[0].opts.limit, 2);
});

test('BuiltinProvider 纠正 4：getToolSchemas 返回 []（§14.1 决策 B，避免与 memory_* 重名）', () => {
  const b = new BuiltinProvider({ memory: fakeMemory(), config: () => schema.DEFAULT_CONFIG });
  assert.deepEqual(b.getToolSchemas(), []);
});

test('BuiltinProvider：handleToolCall 显式失败（内置工具由 agint-memory 提供）', async () => {
  const b = new BuiltinProvider({ memory: fakeMemory(), config: () => schema.DEFAULT_CONFIG });
  await assert.rejects(() => b.handleToolCall('memory_write', {}, {}), /does not handle tool/);
});

test('BuiltinProvider：syncTurn / onPreCompress 为 no-op（不新造自动提取，§1.3 非目标）', async () => {
  const mem = fakeMemory(sampleRows());
  const b = new BuiltinProvider({ memory: mem, config: () => schema.DEFAULT_CONFIG });
  const writesBefore = mem._recallCalls.length;
  await b.syncTurn('用户输入', '助手回复', { sessionId: 's1' });
  assert.equal(await b.onPreCompress([{ role: 'user', content: 'x' }]), '');
  assert.equal(mem._recallCalls.length, writesBefore, 'syncTurn 不得写记忆');
});

test('formatMemories：`• [type/level] content` 形态（与 memory_search render 一致）', () => {
  assert.equal(formatMemories([]), '');
  assert.equal(formatMemories(null), '');
  assert.equal(
    formatMemories([{ type: 'lesson', level: 'L2', content: 'x' }]),
    '• [lesson/L2] x',
  );
  assert.equal(
    formatMemories([
      { type: 'lesson', level: 'L2', content: 'a' },
      { type: 'decision', level: 'L1', content: 'b' },
    ]),
    '• [lesson/L2] a\n• [decision/L1] b',
  );
});

// ── MemoryManager（设计稿 §3.1）──────────────────────────────────────────

function harness(opts = {}) {
  const reg = new ProviderRegistry();
  const mem = fakeMemory(sampleRows());
  const cfg = { ...schema.DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const builtin = new BuiltinProvider({ memory: mem, config: () => cfg });
  reg.register(builtin);

  const records = [];
  const events = [];
  const mock = new MockProvider(opts.mockConfig ?? {});
  reg.register(mock);

  // 阶段 2：fake dsh 工具系统 + defineTool mock（opts.tools=false 表示不注入）
  const toolDefs = {};
  const fakeTools = opts.tools === false ? null : {
    register: (def) => {
      toolDefs[def.name] = def;
      return () => { delete toolDefs[def.name]; };
    },
    get: (n) => toolDefs[n] ?? null,
  };
  const fakeDefineTool = opts.tools === false ? null : ((d) => d);

  const manager = new MemoryManager({
    registry: reg,
    builtin,
    config: () => cfg,
    record: async (table, business) => { records.push({ table, business }); return { id: 'x' }; },
    publish: async (topic, payload) => { events.push({ topic, payload }); return true; },
    debug: () => {},
    tools: fakeTools,
    defineTool: fakeDefineTool,
  });
  return { manager, reg, mem, builtin, mock, records, events, cfg, toolDefs, fakeTools };
}

test('MemoryManager：构造校验（registry / builtin / config 缺一不可）', () => {
  const mem = fakeMemory();
  const cfg = () => schema.DEFAULT_CONFIG;
  const builtin = new BuiltinProvider({ memory: mem, config: cfg });
  assert.throws(() => new MemoryManager({}), /ProviderRegistry/);
  assert.throws(() => new MemoryManager({ registry: new ProviderRegistry() }), /BuiltinProvider/);
  assert.throws(
    () => new MemoryManager({ registry: new ProviderRegistry(), builtin }),
    /config 必须是返回生效配置的函数/,
  );
  // 拿 mock 冒充 builtin 也不行（§9.1 L0）
  assert.throws(
    () => new MemoryManager({ registry: new ProviderRegistry(), builtin: new MockProvider(), config: cfg }),
    /BuiltinProvider/,
  );
});

test('MemoryManager：默认激活 builtin（§10.3 迁移路径，行为与现有一致）', () => {
  const h = harness();
  assert.equal(h.manager.getActiveProviderName(), 'builtin');
  assert.equal(h.manager.isBuiltinActive(), true);
  assert.equal(h.manager.paused, false);
  assert.equal(h.manager.turnNumber, 0);
});

test('MemoryManager.start：启动激活 builtin + 发 provider-activated 事件（§5.4）', async () => {
  const h = harness();
  const r = await h.manager.start('session-1', {});
  assert.equal(r.ok, true);
  assert.equal(r.activeProvider, 'builtin');
  assert.equal(h.manager.sessionId, 'session-1');
  assert.equal(h.manager.initialized, true);
  assert.ok(h.events.some((e) => e.topic === 'memory.provider-activated'));
  // 记 activation_log + audit_log
  assert.ok(h.records.some((x) => x.table === 'activation_log'));
  assert.ok(h.records.some((x) => x.table === 'audit_log'));
});

test('MemoryManager.activate：外部 provider 激活成功路径（§3.1 [4]）', async () => {
  const h = harness();
  const r = await h.manager.activate('mock', { sessionId: 's1', actor: 'human', reason: '测试' });
  assert.equal(r.ok, true);
  assert.equal(r.activeProvider, 'mock');
  assert.equal(r.fellBack, false);
  assert.equal(h.manager.getActiveProviderName(), 'mock');
  assert.equal(h.mock.initialized, true);
  assert.ok(h.mock.callsTo('initialize').length === 1);
  assert.ok(h.events.some((e) => e.topic === 'memory.provider-activated'
    && e.payload.providerName === 'mock'));
});

test('MemoryManager.activate：未注册的 provider → 降级 builtin + 发 activation-failed（§5.4）', async () => {
  const h = harness();
  const r = await h.manager.activate('honcho', { sessionId: 's1' });
  assert.equal(r.ok, false);
  assert.equal(r.fellBack, true);
  assert.equal(r.activeProvider, 'builtin');
  assert.match(r.reason, /未注册/);
  assert.equal(h.manager.getActiveProviderName(), 'builtin');
  assert.ok(h.events.some((e) => e.topic === 'memory.provider-activation-failed'
    && e.payload.fallbackTo === 'builtin'));
  // activation_log 记 fallback + targetProvider
  const al = h.records.find((x) => x.table === 'activation_log');
  assert.equal(al.business.action, 'fallback');
  assert.equal(al.business.targetProvider, 'builtin');
});

test('MemoryManager.activate：isAvailable=false → 降级且带上 unavailableReason', async () => {
  const h = harness({ mockConfig: { available: false } });
  const r = await h.manager.activate('mock', {});
  assert.equal(r.ok, false);
  assert.equal(r.fellBack, true);
  assert.match(r.reason, /MOCK_API_KEY/);
});

test('MemoryManager.activate：initialize 抛错 → 降级 builtin（§9.1 L1 不中断对话）', async () => {
  const h = harness({ mockConfig: { failInitialize: true } });
  const r = await h.manager.activate('mock', {});
  assert.equal(r.ok, false);
  assert.equal(r.fellBack, true);
  assert.equal(r.activeProvider, 'builtin');
  assert.match(r.reason, /initialize\(\) 失败/);
  // 降级后 builtin 可用
  assert.equal(h.manager.isBuiltinActive(), true);
});

test('MemoryManager.activate：isAvailable 抛错也被捕获降级（劣质 provider 不炸宿主）', async () => {
  const h = harness();
  class Throwy extends ExternalProvider {
    get name() { return 'throwy'; }
    isAvailable() { throw new Error('bad impl'); }
    async initialize() {}
    getToolSchemas() { return []; }
  }
  h.reg.register(new Throwy());
  const r = await h.manager.activate('throwy', {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /isAvailable\(\) 抛错/);
  assert.equal(h.manager.getActiveProviderName(), 'builtin');
});

test('MemoryManager.deactivate：外部 → builtin，且调旧 provider 的 shutdown（§9.2 约束 5）', async () => {
  const h = harness();
  await h.manager.activate('mock', {});
  assert.equal(h.manager.getActiveProviderName(), 'mock');

  const r = await h.manager.deactivate({ actor: 'human', reason: '回滚' });
  assert.equal(r.previousProvider, 'mock');
  assert.equal(r.activeProvider, 'builtin');
  assert.equal(r.ok, true);
  assert.equal(h.mock.shutdownCount, 1, 'shutdown 必须被调用');
  assert.equal(h.manager.isBuiltinActive(), true);
});

test('MemoryManager.deactivate：builtin 激活时调用是幂等的', async () => {
  const h = harness();
  const r = await h.manager.deactivate({});
  assert.equal(r.ok, true);
  assert.equal(r.previousProvider, 'builtin');
  assert.equal(r.activeProvider, 'builtin');
});

// ── 召回阶段（§3.1 [5] / §7.3）───────────────────────────────────────────

test('beginTurn：正常输入触发 prefetch 并返回召回指示器', async () => {
  const h = harness();
  await h.manager.start('s1', {});
  const r = await h.manager.beginTurn('偏好', { sessionId: 's1' });
  assert.equal(r.skipped, false);
  assert.equal(r.providerName, 'builtin');
  assert.ok(r.context.length > 0);
  assert.equal(r.status.providerLabel, 'builtin');
  assert.equal(r.status.count, 1);
  assert.equal(r.status.glyph, '🧠');
  assert.equal(h.manager.turnNumber, 1);
  // recall-injected 事件（§5.4）
  const ev = h.events.find((e) => e.topic === 'memory.recall-injected');
  assert.ok(ev, '应发 recall-injected');
  assert.equal(ev.payload.count, 1);
  assert.equal(ev.payload.turnNumber, 1);
});

test('beginTurn：琐碎输入跳过 prefetch（§7.3）——中英文都要跳', async () => {
  const h = harness();
  await h.manager.start('s1', {});
  for (const trivial of ['好的', '继续', '谢谢', 'ok', 'thanks', '/reset', '']) {
    const r = await h.manager.beginTurn(trivial, {});
    assert.equal(r.skipped, true, `${JSON.stringify(trivial)} 应跳过`);
    assert.equal(r.skipReason, 'trivial_prompt');
    assert.equal(r.context, '');
    assert.equal(r.status, null);
  }
  // 关键：一次 prefetch 都没发生
  assert.deepEqual(h.mem._searchCalls, [], '琐碎输入不得触发检索');
});

test('beginTurn：琐碎输入仍调 onTurnStart（§7.3）', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.resetCalls();
  const r = await h.manager.beginTurn('好的', {});
  assert.equal(r.skipped, true);
  assert.equal(h.mock.callsTo('onTurnStart').length, 1, 'onTurnStart 仍应调用');
  assert.equal(h.mock.callsTo('prefetch').length, 0, 'prefetch 不得调用');
});

test('beginTurn：琐碎过滤可关（trivial_prompt_filter_enabled=false）', async () => {
  const h = harness({ config: { trivial_prompt_filter_enabled: false } });
  await h.manager.start('s1', {});
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.resetCalls();
  const r = await h.manager.beginTurn('好的', {});
  assert.equal(r.skipped, false);
  assert.equal(h.mock.callsTo('prefetch').length, 1, '关闭过滤后应检索');
});

test('beginTurn：prefetch_enabled=false 时跳过召回', async () => {
  const h = harness({ config: { prefetch_enabled: false } });
  await h.manager.start('s1', {});
  const r = await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'prefetch_disabled');
  assert.deepEqual(h.mem._searchCalls, []);
});

test('beginTurn：paused 时跳过召回与同步（§5.3 pause/resume）', async () => {
  const h = harness();
  await h.manager.start('s1', {});
  await h.manager.pause();
  assert.equal(h.manager.paused, true);
  const r = await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'paused');
  const s = await h.manager.endTurn('u', 'a', {});
  assert.equal(s.synced, false);

  await h.manager.resume();
  assert.equal(h.manager.paused, false);
  const r2 = await h.manager.beginTurn('简洁', {});
  assert.equal(r2.skipped, false);
});

test('beginTurn：外部 provider prefetch 失败 → 本轮空上下文，不抛错（§9.2 约束 3）', async () => {
  const h = harness({ mockConfig: { failPrefetch: true } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.records.length = 0;
  const r = await h.manager.beginTurn('实义问题关于架构', {});
  // 不抛错、不中断对话
  assert.equal(r.skipped, false);
  assert.equal(r.context, '');
  assert.equal(r.status, null);
  assert.equal(r.skipReason, 'prefetch_error');
  // 阶段 2：写 fallback_events（operation=prefetch；错误文本含 timeout → 归类 timeout）
  const fe = h.records.find((x) => x.table === 'fallback_events');
  assert.ok(fe, '应写 fallback_events');
  assert.equal(fe.business.operation, 'prefetch');
  assert.equal(fe.business.errorType, 'timeout');
  assert.equal(fe.business.providerName, 'mock');
  assert.equal(fe.business.recovered, false, '单次失败不切换');
  // 发 memory.provider-fallback 事件（§5.4）
  assert.ok(h.events.some((e) => e.topic === 'memory.provider-fallback'
    && e.payload.operation === 'prefetch' && e.payload.providerName === 'mock'));
  // 降级但不切换：active 仍是 mock（连续失败才切，§3.1 [6]）
  assert.equal(h.manager.getActiveProviderName(), 'mock');
  assert.equal(h.manager.getDegradationState().consecutiveFailures, 1);
});

test('beginTurn：recall_indicator_enabled=false 时不发 recall-injected 事件', async () => {
  const h = harness({ config: { recall_indicator_enabled: false } });
  await h.manager.start('s1', {});
  const r = await h.manager.beginTurn('简洁', {});
  assert.equal(r.skipped, false);
  assert.ok(r.status, 'status 仍返回（内部用）');
  assert.equal(h.events.filter((e) => e.topic === 'memory.recall-injected').length, 0);
});

test('beginTurn：无召回结果时不发 recall-injected（count=0）', async () => {
  const h = harness();
  await h.manager.start('s1', {});
  const r = await h.manager.beginTurn('完全不匹配的关键词zzz', {});
  assert.equal(r.status.count, 0);
  assert.equal(h.events.filter((e) => e.topic === 'memory.recall-injected').length, 0);
});

test('beginTurn：轮次自增 + 显式 turnNumber 覆盖', async () => {
  const h = harness();
  await h.manager.start('s1', {});
  await h.manager.beginTurn('简洁', {});
  assert.equal(h.manager.turnNumber, 1);
  await h.manager.beginTurn('简洁', {});
  assert.equal(h.manager.turnNumber, 2);
  await h.manager.beginTurn('简洁', { turnNumber: 42 });
  assert.equal(h.manager.turnNumber, 42);
});

test('getRecallStatus：返回最近一次召回状态（确定性指示器）', async () => {
  const h = harness();
  await h.manager.start('s1', {});
  assert.equal(h.manager.getRecallStatus(), null);
  await h.manager.beginTurn('偏好', {});
  const s = h.manager.getRecallStatus();
  assert.deepEqual(s, { providerLabel: 'builtin', count: 1, glyph: '🧠' });
  // 返回拷贝，调用方改不动内部状态
  s.count = 999;
  assert.equal(h.manager.getRecallStatus().count, 1);
});

// ── 同步阶段（§3.1 [5]）──────────────────────────────────────────────────

test('endTurn：调用 provider.syncTurn 并传 messages', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.resetCalls();
  const msgs = [{ role: 'user', content: 'u' }];
  const r = await h.manager.endTurn('u', 'a', { messages: msgs });
  assert.equal(r.synced, true);
  assert.equal(r.providerName, 'mock');
  const c = h.mock.callsTo('syncTurn');
  assert.equal(c.length, 1);
  assert.equal(c[0][1], 'u');
  assert.equal(c[0][2], 'a');
});

test('endTurn：syncTurn 失败不抛（不影响对话响应）', async () => {
  const h = harness({ mockConfig: { failSyncTurn: true } });
  await h.manager.activate('mock', { sessionId: 's1' });
  const r = await h.manager.endTurn('u', 'a', {});
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'provider_error');
});

test('endTurn：sync_turn_enabled=false 时跳过', async () => {
  const h = harness({ config: { sync_turn_enabled: false } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.resetCalls();
  const r = await h.manager.endTurn('u', 'a', {});
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'sync_disabled');
  assert.equal(h.mock.callsTo('syncTurn').length, 0);
});

// ── 会话边界（§3.1 [7] / §5.1）───────────────────────────────────────────

test('onSessionSwitch / onSessionEnd：转发到 provider 且轮次归零', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  await h.manager.beginTurn('实义问题', { turnNumber: 5 });
  assert.equal(h.manager.turnNumber, 5);

  const sw = await h.manager.onSessionSwitch('s2', {});
  assert.equal(sw.ok, true);
  assert.equal(sw.previousSessionId, 's1');
  assert.equal(h.manager.sessionId, 's2');
  assert.equal(h.manager.turnNumber, 0, '切会话后轮次归零');
  assert.equal(h.mock.callsTo('onSessionSwitch').length, 1);

  const end = await h.manager.onSessionEnd([{ role: 'user', content: 'x' }]);
  assert.equal(end.ok, true);
  assert.equal(h.mock.callsTo('onSessionEnd').length, 1);
});

test('onSessionSwitch：provider hook 抛错不影响管理器状态', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.onSessionSwitch = async () => { throw new Error('hook boom'); };
  const r = await h.manager.onSessionSwitch('s2', {});
  assert.equal(r.ok, true);
  assert.equal(h.manager.sessionId, 's2');
});

test('shutdown：关闭激活的 provider 并复位到 builtin（§3.1 [7]）', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  const r = await h.manager.shutdown();
  assert.equal(r.ok, true);
  assert.equal(r.shutdownProvider, 'mock');
  assert.equal(h.mock.shutdownCount, 1);
  assert.equal(h.manager.initialized, false);
  assert.equal(h.manager.getActiveProviderName(), 'builtin');
});

test('shutdown：provider.shutdown 抛错不阻断关闭流程', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.shutdown = async () => { throw new Error('shutdown boom'); };
  const r = await h.manager.shutdown();
  assert.equal(r.ok, true);
  assert.equal(h.manager.getActiveProviderName(), 'builtin');
});

// ── 阶段 2：运行时降级（§3.1 [6] / §12.2）────────────────────────────────

test('阶段 2 编排：activate 外部 provider 成功后自动注册其工具（§3.3 [2]）', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  assert.deepEqual(Object.keys(h.toolDefs), ['mock_add_user_memory'],
    'mock 前缀已自带（mock_），不得重复加前缀');
  const audit = h.records.find((x) => x.table === 'audit_log'
    && x.business.action === 'provider_tools_registered');
  assert.ok(audit, '注册成功应写 audit_log');
});

test('阶段 2 编排：切回 builtin 时卸载外部 provider 的工具（§9.2 约束 5）', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  assert.equal(Object.keys(h.toolDefs).length, 1);
  await h.manager.deactivate({ reason: '测试回滚' });
  assert.deepEqual(Object.keys(h.toolDefs), [], 'builtin 接管后工具应全部卸载');
});

test('阶段 2 降级：连续失败达阈值 → 自动切 builtin + shutdown + 卸工具 + 安排恢复', async () => {
  const h = harness({
    mockConfig: { failPrefetch: true },
    config: { max_consecutive_failures: 3, auto_recover_after_minutes: 30 },
  });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.resetCalls();
  h.records.length = 0;
  h.events.length = 0;

  for (let i = 0; i < 3; i++) await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(h.manager.getActiveProviderName(), 'builtin', '达阈值应自动切换');
  assert.equal(h.mock.shutdownCount, 1, '失败 provider 应被 shutdown');
  assert.deepEqual(Object.keys(h.toolDefs), [], '切换时应卸载其工具');

  const st = h.manager.getDegradationState();
  assert.equal(st.recoveryTarget, 'mock', '恢复目标 = 用户配置的 provider');
  assert.ok(st.recoverAt, '应安排自动恢复时刻');
  assert.equal(st.consecutiveFailures, 0, '切换后计数清零');

  const al = h.records.find((x) => x.table === 'activation_log');
  assert.equal(al.business.action, 'fallback');
  assert.equal(al.business.targetProvider, 'builtin');
  assert.ok(h.events.some((e) => e.topic === 'memory.provider-fallback'));
  // §9.3：自动切换只改运行时激活态，从不写配置
  assert.equal(h.cfg.active_provider, 'builtin', '配置不得被自动修改');
});

test('阶段 2 降级：fallback_enabled=false 时只记录不切换', async () => {
  const h = harness({
    mockConfig: { failPrefetch: true },
    config: { max_consecutive_failures: 2, fallback_enabled: false },
  });
  await h.manager.activate('mock', { sessionId: 's1' });
  for (let i = 0; i < 5; i++) await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(h.manager.getActiveProviderName(), 'mock', '降级关闭时不得切换');
  assert.ok(h.records.some((x) => x.table === 'fallback_events'), '但仍应记录失败');
});

test('阶段 2 降级：builtin 自身失败不切换（L0 已是最后一层）', async () => {
  const h = harness();
  await h.manager.start('s1', {});
  // builtin 激活时失败：handleRuntimeFailure 的 shouldSwitch 有 !isBuiltinActive() 门
  const fb = await h.manager.handleRuntimeFailure('prefetch', new Error('boom'), {});
  assert.equal(fb.switched, false);
  assert.equal(h.manager.isBuiltinActive(), true);
});

test('阶段 2 自动恢复：到点后 beginTurn 触发恢复 + 重注册工具 + 发 recovered 事件', async () => {
  const h = harness({ config: { max_consecutive_failures: 2, auto_recover_after_minutes: 30 } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.setFailPrefetch(true);
  for (let i = 0; i < 2; i++) await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(h.manager.getActiveProviderName(), 'builtin');

  // 到点：把 recoverAt 拨到过去
  h.manager.recoverAt = Date.now() - 1;
  h.mock.setFailPrefetch(false);
  h.mock.resetCalls();
  h.events.length = 0;

  const r = await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(r.providerName, 'mock', '恢复后本轮直接用恢复的 provider');
  assert.ok(h.mock.callsTo('initialize').length >= 1, '恢复应重新 initialize');
  assert.deepEqual(Object.keys(h.toolDefs), ['mock_add_user_memory'], '恢复后重注册工具');
  assert.ok(h.events.some((e) => e.topic === 'memory.provider-recovered'));
  const st = h.manager.getDegradationState();
  assert.equal(st.recoveryTarget, null);
  assert.equal(st.recoverAt, null);
});

test('阶段 2 自动恢复：未到点不尝试；恢复目标 isAvailable=false 则继续等', async () => {
  const h = harness({ config: { max_consecutive_failures: 2 } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.setFailPrefetch(true);
  for (let i = 0; i < 2; i++) await h.manager.beginTurn('实义问题关于架构', {});
  // 未到点
  const nr = await h.manager.maybeRecover();
  assert.equal(nr.attempted, false);
  assert.equal(h.manager.getActiveProviderName(), 'builtin');
  // 到点但不可用
  h.manager.recoverAt = Date.now() - 1;
  h.mock.setAvailability(false);
  const r = await h.manager.maybeRecover();
  assert.equal(r.attempted, true);
  assert.equal(r.recovered, false);
  assert.equal(h.manager.getActiveProviderName(), 'builtin', '不可用不恢复');
});

test('阶段 2 noteSuccess：成功清零连续失败计数并清除单次降级标记', async () => {
  const h = harness({ config: { max_consecutive_failures: 5 } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.setFailPrefetch(true);
  await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(h.manager.getDegradationState().consecutiveFailures, 1);
  assert.equal(h.manager.getDegradationState().degradedProvider, 'mock');

  h.mock.setFailPrefetch(false);
  await h.manager.beginTurn('实义问题关于架构', {});
  const st = h.manager.getDegradationState();
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(st.degradedProvider, null, '成功清除降级标记');
});

test('阶段 2 召回超时：prefetch 超时不阻塞对话，归类 timeout（§9.1 L1）', async () => {
  const h = harness({ config: { prefetch_timeout_ms: 100 } });
  const slow = new MockProvider({ prefetchDelayMs: 300, name: 'slow' });
  h.reg.register(slow);
  await h.manager.activate('slow', { sessionId: 's1' });
  h.records.length = 0;
  const t0 = Date.now();
  const r = await h.manager.beginTurn('实义问题关于架构', {});
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 250, `超时应快速返回（实际 ${elapsed}ms）`);
  assert.equal(r.context, '');
  assert.equal(r.errorType, 'timeout');
  const fe = h.records.find((x) => x.table === 'fallback_events');
  assert.equal(fe.business.errorType, 'timeout');
});

test('阶段 2 classifyErrorType：错误归类与 §4.4 枚举一致', () => {
  assert.equal(classifyErrorType(new PrefetchTimeoutError(1000)), 'timeout');
  assert.equal(classifyErrorType(new Error('ETIMEDOUT')), 'timeout');
  assert.equal(classifyErrorType(new Error('HTTP 429 too many requests')), 'rate_limit');
  assert.equal(classifyErrorType(new Error('401 Unauthorized')), 'auth');
  assert.equal(classifyErrorType(new Error('getaddrinfo ENOTFOUND api.example.com')), 'network');
  assert.equal(classifyErrorType(new Error('ECONNREFUSED 127.0.0.1')), 'network');
  assert.equal(classifyErrorType(new Error('mystery')), 'unknown');
  assert.ok(['network', 'timeout', 'rate_limit', 'auth', 'unknown']
    .includes(classifyErrorType(null)));
});

test('阶段 2 withTimeout：正常完成不受影响；超时拒绝并带 PrefetchTimeoutError', async () => {
  const fast = withTimeout(Promise.resolve('ok'), 100, (ms) => new PrefetchTimeoutError(ms));
  assert.equal(await fast, 'ok');

  const slow = withTimeout(
    new Promise((r) => setTimeout(r, 200, 'late')),
    30,
    (ms) => new PrefetchTimeoutError(ms),
  );
  await assert.rejects(() => slow, (e) => e instanceof PrefetchTimeoutError && e.timeoutMs === 30);
  // ms 非法 → 不套超时
  const noTimeout = withTimeout(Promise.resolve('raw'), 0, () => new Error('x'));
  assert.equal(await noTimeout, 'raw');
});

// ── 阶段 2：pre_compress 检查点（§3.2 / §9.1 L5 fail-closed）─────────────

test('阶段 2 检查点：apiVersion=2 失败 → fail-closed 中止压缩 + 记 failed 检查点', async () => {
  const h = harness({ mockConfig: { failPreCompress: true, apiVersion: 2 } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.records.length = 0;
  const r = await h.manager.runPreCompressCheckpoint([{ role: 'user', content: 'a' }]);
  assert.equal(r.ok, false);
  assert.equal(r.abortCompress, true, 'fail-closed：调用方必须中止压缩');
  assert.equal(r.status, 'failed');
  assert.equal(r.apiVersion, 2);
  const pcc = h.records.find((x) => x.table === 'pre_compress_checkpoints');
  assert.ok(pcc);
  assert.equal(pcc.business.checkpointStatus, 'failed');
  // 非 builtin 失败也写 fallback_events（operation=on_pre_compress）
  assert.ok(h.records.some((x) => x.table === 'fallback_events'
    && x.business.operation === 'on_pre_compress'));
  assert.ok(h.events.some((e) => e.topic === 'memory.pre-compress-checkpoint'
    && e.payload.abortCompress === true));
});

test('阶段 2 检查点：apiVersion=1 失败 → best-effort 放行不中止', async () => {
  const h = harness({ mockConfig: { failPreCompress: true, apiVersion: 1 } });
  await h.manager.activate('mock', { sessionId: 's1' });
  const r = await h.manager.runPreCompressCheckpoint([]);
  assert.equal(r.ok, false);
  assert.equal(r.abortCompress, false, 'v1 是 best-effort，失败也放行');
  assert.equal(r.status, 'best_effort');
});

test('阶段 2 检查点：成功 → 返回洞察 + status=success + 计数清零', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  h.manager.checkpointFailures = 2; // 先造点失败计数
  const r = await h.manager.runPreCompressCheckpoint([{ role: 'user', content: 'x' }]);
  assert.equal(r.ok, true);
  assert.equal(r.abortCompress, false);
  assert.equal(r.status, 'success');
  assert.ok(r.insight.includes('MOCK 洞察'));
  assert.equal(h.manager.checkpointFailures, 0, '成功清零连续失败计数');
});

test('阶段 2 检查点：开关关闭 → skipped 且不调用 provider', async () => {
  const h = harness({ config: { pre_compress_checkpoint_enabled: false } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.resetCalls();
  const r = await h.manager.runPreCompressCheckpoint([]);
  assert.equal(r.status, 'skipped');
  assert.equal(r.abortCompress, false);
  assert.equal(h.mock.callsTo('onPreCompress').length, 0);
});

test('阶段 2 检查点：防死锁（§13.2）——连续失败达上限后回退 best-effort 放行', async () => {
  const h = harness({ mockConfig: { failPreCompress: true, apiVersion: 2 } });
  await h.manager.activate('mock', { sessionId: 's1' });
  h.manager.checkpointFailures = MAX_CHECKPOINT_FAILURES; // 已达防死锁上限
  const r = await h.manager.runPreCompressCheckpoint([]);
  assert.equal(r.abortCompress, false, '防死锁：不再中止压缩，避免 token 溢出');
  assert.equal(r.status, 'best_effort');
  assert.equal(r.deadlockGuard, true);
});

// ── 阶段 2：provider 工具暴露（§3.3）────────────────────────────────────

test('阶段 2 工具暴露：注册 + 前缀 + 路由 + JSON 解析（§3.3 全链路）', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  // 注册（activate 自动触发过，这里显式再调验证幂等跳过）
  const r = await h.manager.registerProviderTools();
  assert.equal(r.ok, true);
  assert.deepEqual(r.registered, [], '已注册的同名工具走冲突跳过');
  assert.equal(r.skipped.length, 1);

  // 路由：JSON 字符串结果解析成对象
  const out = await h.manager.routeToolCall('mock_add_user_memory', { content: 'hello' }, {});
  assert.equal(out.ok, true);
  assert.equal(out.source, 'mock');
  assert.equal(out.tool, 'mock_add_user_memory');
  assert.deepEqual(out.args, { content: 'hello' });
  assert.ok(h.events.some((e) => e.topic === 'memory.tool-called' && e.payload.success === true));
});

test('阶段 2 工具暴露：自定义前缀 + OpenAI JSON Schema → dsh 参数映射', async () => {
  const h = harness({ config: { external_tool_prefix: 'mem_' } });
  await h.manager.activate('mock', { sessionId: 's1' });
  // mock 工具名 mock_add_user_memory 不以 mem_ 开头 → 加前缀
  assert.ok(h.toolDefs['mem_mock_add_user_memory'], '自定义前缀应生效');
  const def = h.toolDefs['mem_mock_add_user_memory'];
  assert.match(def.description, /^\[mock\]/, '描述标注来源 provider');
  // OpenAI parameters { properties.content: string, required } → dsh 属性映射
  assert.deepEqual(def.parameters.content, {
    type: 'string', description: '记忆内容', required: true,
  });

  // 未注册工具显式抛错（不静默）
  await assert.rejects(
    () => h.manager.routeToolCall('nonexistent_tool', {}, {}),
    /未注册/,
  );
});

test('阶段 2 工具暴露：与保留名冲突 → 跳过并记录原因（§14.1 决策 B）', async () => {
  // 保留名分支只在自定义前缀下可达：prefix='memory_' + 工具名 'write'
  // → finalName='memory_write' 撞保留名 → 跳过
  const h = harness({ config: { external_tool_prefix: 'memory_' } });
  class Writer extends MockProvider {
    getToolSchemas() {
      return [
        { name: 'write', description: '撞内置保留名', parameters: { type: 'object', properties: {} } },
        { name: 'custom', description: '普通工具', parameters: { type: 'object', properties: {} } },
      ];
    }
  }
  const w = new Writer({ name: 'writer' });
  h.reg.register(w);
  await h.manager.activate('writer', { sessionId: 's1' });
  const names = Object.keys(h.toolDefs);
  assert.ok(!names.includes('memory_write'), '撞保留名的工具必须跳过');
  assert.ok(names.includes('memory_custom'), '普通工具正常注册');
});

test('阶段 2 工具暴露：宿主工具系统未注入 → 显式 unavailable（不假成功）', async () => {
  const h = harness({ tools: false });
  await h.manager.activate('mock', { sessionId: 's1' });
  const r = await h.manager.registerProviderTools();
  assert.equal(r.ok, false);
  assert.match(r.reason, /tools_unavailable/);
});

test('阶段 2 工具暴露：provider.handleToolCall 失败 → 记 fallback + 抛回调用方', async () => {
  const h = harness();
  await h.manager.activate('mock', { sessionId: 's1' });
  h.records.length = 0;
  h.mock.setFailToolCall(true);
  await assert.rejects(
    () => h.manager.routeToolCall('mock_add_user_memory', {}, {}),
    /调用失败/,
  );
  assert.ok(h.events.some((e) => e.topic === 'memory.tool-called' && e.payload.success === false));
  assert.ok(h.records.some((x) => x.table === 'fallback_events'
    && x.business.operation === 'handle_tool_call'));
});

// ── 阶段 2：testConnection（§5.3，配置/凭证级，无网络探活）───────────────

test('阶段 2 testConnection：未注册 / 不可用 / 可用三分支', async () => {
  const h = harness();
  // 未注册
  let r = await h.manager.testConnection('honcho');
  assert.equal(r.ok, false);
  assert.equal(r.registered, false);
  assert.equal(r.networkProbed, false);

  // 不可用
  h.mock.setAvailability(false);
  r = await h.manager.testConnection('mock');
  assert.equal(r.ok, false);
  assert.equal(r.available, false);
  assert.match(r.reason, /MOCK_API_KEY/);

  // 可用
  h.mock.setAvailability(true);
  r = await h.manager.testConnection('mock');
  assert.equal(r.ok, true);
  assert.equal(r.initializeOk, true);
  assert.match(r.reason, /未做网络探活/);
});

// ── MockProvider 自身（设计稿 §11.3）─────────────────────────────────────

test('MockProvider：调用记录 + 故障开关 + apiVersion=2（fail-closed）', async () => {
  const m = new MockProvider();
  assert.equal(m.name, 'mock');
  assert.equal(m.preCompressCheckpointApiVersion, 2);
  assert.equal(m.isAvailable(), true);
  await m.initialize('s1', {});
  assert.equal(m.initialized, true);

  const ctx = await m.prefetch('架构', {});
  assert.ok(ctx.includes('mock'));
  assert.equal(m.lastRecallCount, 2);
  assert.deepEqual(m.recallStatus(), { providerLabel: 'mock', count: 2, glyph: '🧪' });

  // 工具
  const schemas = m.getToolSchemas();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].name, 'mock_add_user_memory');
  const res = JSON.parse(await m.handleToolCall('mock_add_user_memory', { content: 'x' }, {}));
  assert.equal(res.ok, true);
  await assert.rejects(() => m.handleToolCall('unknown_tool', {}, {}), /does not handle tool/);

  // 调用顺序断言（被拒绝的 unknown_tool 调用也会先记录、再抛错）
  assert.deepEqual(m.calls.map((c) => c[0]), [
    'isAvailable', 'initialize', 'prefetch', 'handleToolCall', 'handleToolCall',
  ]);
  assert.equal(m.callsTo('prefetch').length, 1);

  m.resetCalls();
  assert.deepEqual(m.calls, []);
});

test('MockProvider：故障开关彼此独立（可定位到具体路径）', async () => {
  const m = new MockProvider({ failPreCompress: true });
  await m.initialize('s1', {});
  // preCompress 失败但 prefetch 正常
  assert.ok(await m.prefetch('架构', {}));
  await assert.rejects(() => m.onPreCompress([]), /checkpoint persistence failed/);

  const m2 = new MockProvider({ failPrefetch: true });
  await m2.initialize('s1', {});
  await assert.rejects(() => m2.prefetch('q', {}), /network timeout/);
  await m2.syncTurn('u', 'a', {}); // syncTurn 不受 prefetch 开关影响

  const m3 = new MockProvider({ failSyncTurn: true });
  await m3.initialize('s1', {});
  assert.ok(await m3.prefetch('q', {}));
  await assert.rejects(() => m3.syncTurn('u', 'a', {}), /syncTurn failed/);
});

test('MockProvider：unavailableReason 给出真实原因（§5.1）', () => {
  const m = new MockProvider({ available: false });
  assert.equal(m.isAvailable(), false);
  assert.match(m.unavailableReason(), /MOCK_API_KEY/);
  assert.equal(new MockProvider().unavailableReason(), '');
});

test('MockProvider：延迟注入 + apiVersion=1（best-effort）可配', async () => {
  const m = new MockProvider({ prefetchDelayMs: 30, apiVersion: 1 });
  assert.equal(m.preCompressCheckpointApiVersion, 1);
  await m.initialize('s1', {});
  const t0 = Date.now();
  await m.prefetch('q', {});
  assert.ok(Date.now() - t0 >= 25, '延迟应生效');
});

// ── §9.3 自我评估禁止 ────────────────────────────────────────────────────

test('§9.3 自我评估禁止：自动降级/恢复只改运行时激活态，从不改配置', async () => {
  const h = harness({ config: { max_consecutive_failures: 3 } });
  await h.manager.start('s1', {});
  const cfgBefore = JSON.stringify(h.cfg);

  // 单轮失败：provider 不换
  await h.manager.activate('mock', { sessionId: 's1' });
  h.mock.setFailPrefetch(true);
  await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(h.manager.getActiveProviderName(), 'mock', '单次失败不切换');

  // 连续失败达阈值 → 自动切 builtin（§9.1 L1 护栏），但配置一个字都不动
  for (let i = 0; i < 2; i++) await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(h.manager.getActiveProviderName(), 'builtin', '达阈值切 builtin');
  assert.equal(JSON.stringify(h.cfg), cfgBefore, '配置不得被自动修改');
  assert.equal(h.manager.recoveryTarget, 'mock', '恢复目标是用户原先配置的 provider');

  // 自动恢复同样只恢复原 provider，不改配置
  h.manager.recoverAt = Date.now() - 1;
  h.mock.setFailPrefetch(false);
  await h.manager.beginTurn('实义问题关于架构', {});
  assert.equal(h.manager.getActiveProviderName(), 'mock');
  assert.equal(JSON.stringify(h.cfg), cfgBefore, '恢复后配置仍不得被修改');
});
