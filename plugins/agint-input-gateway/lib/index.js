/**
 * agint-input-gateway — host service 入口。
 *
 * 注册 agint.inputGateway service，挂载 C2 Channel，启动定时调度。
 *
 * Service 方法：
 *   - registerChannel(channel)
 *   - fetchAll()
 *   - forceFetch(channelId)
 *   - getStatus()
 *   - getChannelStatus(channelId)
 *   - setQuota(channelId, quota)
 *   - setChannelEnabled(channelId, enabled)
 */

import { InputGateway } from './gateway.js';
import { selfObservationChannel } from './channels/self-observation.js';
import { externalGitChannel } from './channels/external-git.js';
import { adversarialChannel, initSubscriptions } from './channels/adversarial.js';
import { PLUGIN_NAME, C2_CRON, C3_CRON, C4_CRON } from './schema.js';
import { spec, emptyConfig, packConfig, emptyCounters } from './storage.js';

const name = PLUGIN_NAME;
const inject = ['storageDomain', 'agint.compressGuard'];
const optionalInject = ['agint.eventBus.subscribe', 'agint.eventBus.publish'];

function apply(ctx, config) {
  const cfg = {
    enabled: config?.enabled !== false,
    confidenceThreshold: config?.confidenceThreshold ?? 0.3,
    relevanceLowQueue: config?.relevanceLowQueue ?? 0.2,
    noiseMaxPerSource: config?.noiseMaxPerSource ?? 5,
  };

  let domain = null;
  let disposed = false;
  const disposers = [];
  let gateway = null;
  let schedulerDisposer = null;

  ctx.effect(() => () => {
    disposed = true;
    if (schedulerDisposer) { try { schedulerDisposer(); } catch {} }
    for (const d of disposers) { try { d(); } catch {} }
    if (domain) { void domain.close().catch(() => {}); }
  });

  // 打开存储域
  const ready = ctx.storageDomain.open(spec).then(
    (d) => { domain = d; return d; },
    (e) => { console.error(`[${name}] storageDomain open failed:`, e?.message ?? e); return null; },
  );

  const table = async (tableName) => {
    if (disposed) throw new Error(`${name}: disposed`);
    const d = await ready;
    if (!d) throw new Error(`${name}: domain unavailable`);
    return d.table(tableName);
  };

  // eventBus 软依赖
  const getPublish = () => {
    if (typeof ctx.get !== 'function') return null;
    try { return ctx.get('agint.eventBus.publish') || null; } catch { return null; }
  };

  const debug = (msg) => {
    if (cfg.debug_mode) console.log(`[${name}] ${msg}`);
  };

  // 异步初始化（不阻塞 cordis fiber）
  void ready.then(async (d) => {
    if (disposed || !d) return;

    // 加载持久化配置
    let persistedConfig = cfg;
    try {
      const configTable = d.table('config');
      const rec = configTable.get('config');
      if (rec) persistedConfig = { ...cfg, ...rec };
    } catch {}

    // 创建 Gateway
    gateway = new InputGateway({
      table: (n) => d.table(n),
      getPublish,
      config: persistedConfig,
      debug,
    });

    // 加载持久化的 channel_state 和 counters
    try {
      const stateTable = d.table('channel_state');
      for (const [id, rec] of stateTable.entries()) {
        gateway._channelState.set(id, { ...gateway._channelState.get(id), ...rec });
      }
    } catch {}
    try {
      const countersTable = d.table('counters');
      for (const [id, rec] of countersTable.entries()) {
        gateway._counters.set(id, rec);
      }
    } catch {}

    // 注册 C2 Channel（compressGuard 已通过 inject 注入）
    gateway.registerChannel({
      ...selfObservationChannel,
      fetch: (ctx2) => selfObservationChannel.fetch({
        ...ctx2,
        services: { compressGuard: ctx['agint.compressGuard'] || null },
      }),
    });

    // 注册 C3 Channel（外部世界 git 子源）
    gateway.registerChannel(externalGitChannel);

    // 注册 C4 Channel（对抗挑战：订阅已有事件，只转发失败/边界）
    gateway.registerChannel(adversarialChannel);
    initSubscriptions(ctx);

    // 启动调度
    schedulerDisposer = gateway.startScheduler({
      'self-observation': C2_CRON,
      'external-git': C3_CRON,
      'adversarial': C4_CRON,
    });

    debug(`initialized: 3 channels (self-observation=${C2_CRON}, external-git=${C3_CRON}, adversarial=${C4_CRON})`);
  }).catch((e) => {
    console.error(`[${name}] init failed:`, e?.message ?? e);
  });

  // 提供 Service
  ctx.provide('agint.inputGateway', {
    registerChannel: (ch) => gateway?.registerChannel(ch),
    fetchAll: () => gateway?.fetchAll(),
    forceFetch: (channelId) => gateway?.forceFetch(channelId),
    getStatus: () => gateway?.getStatus() || { gateway: name, channelCount: 0, channels: [], config: cfg },
    getChannelStatus: (channelId) => gateway?.getChannelStatus(channelId),
    setQuota: (channelId, quota) => gateway?.setQuota(channelId, quota),
    setChannelEnabled: (channelId, enabled) => gateway?.setChannelEnabled(channelId, enabled),
  });
}

export { name, inject, optionalInject, apply };



