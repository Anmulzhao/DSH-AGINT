/**
 * C4 对抗挑战 Channel — 订阅已有模块事件，只转发失败/边界/异常结果。
 *
 * 不新建采集逻辑，只做事件转发和过滤：
 *   diagnosis.completed → 有诊断结果时转发；v0.3.0 起 clusterCount=0 的空壳
 *                         事件也转发（forwardEmptyDiagnosis，默认开）——
 *                         让"诊断链空转"对下游可见，而不是静默过滤
 *   curriculum.challenge-verdicted → 只转发 fail
 *   curriculum.boundary-probed → 有不可验证边界时转发
 *
 * v0.1.4（H1 方案②）：事件到达时直接喂 gateway.ingestImmediate，
 * 不再放入模块级内存队列。旧「入队 → 定期 drain」的丢失窗口 = drain 周期 × 重启
 * （实测 2 个主题的信号因重启永不可见）；即投把窗口缩到毫秒级，
 * 且重启后 dedup 照常防重放。fetch() 保留为空 drain —— 通道在
 * channel_status / fetchCount 里继续有心跳。
 */

import { C4_CRON } from '../schema.js';

const CHANNEL_ID = 'adversarial';
const CHANNEL_TYPE = 'adversarial';

let _subscribed = false;
let _initError = null;
// v0.3.0：diagnosis.completed 空壳事件（clusterCount=0）是否转发（默认开）
let _forwardEmptyDiagnosis = true;
// 即投统计（health 可见）：本 boot 收到/投出的事件条数
let _ingested = 0;
let _ingestFailed = 0;

/**
 * 初始化事件订阅。在 Gateway 注册后由 index.js 调用。
 * @param {object} ctx — 最小 ctx（含 get/effect）
 * @param {object} config — 插件配置
 * @param {object} gateway — InputGateway 实例（即投走 ingestImmediate）
 */
function initSubscriptions(ctx, config = {}, gateway = null) {
  if (_subscribed) return;
  _forwardEmptyDiagnosis = config?.forwardEmptyDiagnosis !== false;

  try {
    let subscribe = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe !== 'function') {
      const ns = ctx.get('agint.eventBus');
      if (ns && typeof ns.subscribe === 'function') subscribe = ns.subscribe;
    }
    if (typeof subscribe !== 'function') {
      _initError = 'eventBus subscribe unavailable: ctx.get(agint.eventBus.subscribe) returned null';
      console.warn('[agint-input-gateway] adversarial: ' + _initError);
      return;
    }
    if (!gateway || typeof gateway.ingestImmediate !== 'function') {
      _initError = 'gateway instance unavailable: initSubscriptions requires gateway (v0.1.4)';
      console.warn('[agint-input-gateway] adversarial: ' + _initError);
      return;
    }

    /** 即投一条；失败只计数不抛（订阅回调必须不阻塞总线）。 */
    const emit = (sig) => {
      _ingested += 1;
      try {
        void Promise.resolve(gateway.ingestImmediate(CHANNEL_ID, [sig])).catch((e) => {
          _ingestFailed += 1;
          console.warn('[agint-input-gateway] adversarial ingest failed:', e?.message ?? e);
        });
      } catch {
        _ingestFailed += 1;
      }
    };

    let disposer;
    disposer = subscribe({
        subscriber: 'agint-input-gateway/adversarial',
        topics: [
          'diagnosis.completed',
          'curriculum.challenge-verdicted',
          'curriculum.boundary-probed',
        ],
        mode: 'async',
      },
      (envelope) => {
        const topic = envelope?.topic || '';
        const p = envelope?.payload ?? {};
        const now = new Date().toISOString();

        try {
          // diagnosis.completed: 有诊断结果转发；无结果（空壳）默认也转发——
          // 让"诊断链空转"成为可见信号（2026-09-29 激活上游事件源）。
          if (topic === 'diagnosis.completed') {
            if ((p.clusterCount ?? 0) === 0) {
              if (!_forwardEmptyDiagnosis) return; // 显式关闭空壳转发时静默
              emit({
                signalId: `counterfactual-empty-${p.reportId || Date.now()}`,
                channelId: CHANNEL_ID,
                channelType: CHANNEL_TYPE,
                source: 'diagnosis',
                signalType: 'counterfactual-result',
                payload: {
                  reportId: p.reportId,
                  clusterCount: 0,
                  rootCauses: null,
                  empty: true,
                  note: '诊断链空转：report 无聚类结果（annotations/clusters 为空），非 Gateway bug',
                },
                confidence: 0.5,
                relevance: 0.5,
                occurredAt: p.evaluatedAt || now,
                rawRef: `diagnosis:${p.reportId}`,
              });
            } else {
              emit({
                signalId: `counterfactual-${p.reportId || Date.now()}`,
                channelId: CHANNEL_ID,
                channelType: CHANNEL_TYPE,
                source: 'diagnosis',
                signalType: 'counterfactual-result',
                payload: {
                  reportId: p.reportId,
                  clusterCount: p.clusterCount,
                  rootCauses: p.rootCauseDistribution,
                },
                confidence: 0.8,
                relevance: 0.7,
                occurredAt: p.evaluatedAt || now,
                rawRef: `diagnosis:${p.reportId}`,
              });
            }
          }

          // curriculum.challenge-verdicted: 只转发 fail
          else if (topic === 'curriculum.challenge-verdicted') {
            if (p.result !== 'fail' && p.result !== 'failed') return; // pass 不转发
            emit({
              signalId: `curriculum-${p.challengeId || Date.now()}`,
              channelId: CHANNEL_ID,
              channelType: CHANNEL_TYPE,
              source: 'curriculum',
              signalType: 'curriculum-result',
              payload: {
                challengeId: p.challengeId,
                domain: p.domain,
                result: p.result,
                reason: p.reason,
              },
              confidence: 0.7,
              relevance: 0.8,
              occurredAt: now,
              rawRef: `curriculum:${p.challengeId}`,
            });
          }

          // curriculum.boundary-probed: 有不可验证边界才转发
          else if (topic === 'curriculum.boundary-probed') {
            const unverifiable = p.unverifiable || [];
            if (unverifiable.length === 0) return; // 全部可验证，静默
            emit({
              signalId: `boundary-${Date.now()}`,
              channelId: CHANNEL_ID,
              channelType: CHANNEL_TYPE,
              source: 'curriculum',
              signalType: 'boundary-divergence',
              payload: {
                domains: p.domains,
                unverifiable,
              },
              confidence: 0.6,
              relevance: 0.7,
              occurredAt: now,
              rawRef: 'curriculum:boundary-probe',
            });
          }
        } catch { /* 单事件失败不阻塞 */ }
      },
    );

    // 注册成功后才置位：取到 subscribe 函数不足以说明订阅成立，
    // subscribe() 自身抛错（schema 校验失败 / sync 配额超限）同样会让 health() 假绿。
    _subscribed = true;

    if (typeof ctx.effect === 'function') {
      // ⛔ 这里**必须返回** disposer，不能直接调用它。
      //   ctx.effect(fn) 会**立即执行** fn，且只有 fn **返回函数**时该函数才被收集
      //   为 disposer（cordis src/fiber.ts:363-372：execute 立即调用，
      //   `typeof effect === 'function'` 才 collect）。原写法
      //   `ctx.effect(() => { disposer(); })` 在注册当场就把订阅撤掉，且不留任何清理
      //   —— 订阅从未生效，而 health() 因 `_subscribed=true`（上行已置位）仍报
      //   status:ok / detectors 全 active ⇒ **假绿**。
      //   2026-10-09 实测：eventBus_deliveryByTopic 的 orphanSubscriptions 里有 4 个
      //   diagnosis.completed 订阅者（mutator / ov-strategy / self-model / trajectory），
      //   唯独没有本通道。改前后的正确写法对照见 test/adversarial.test.mjs。
      ctx.effect(() => () => { try { disposer(); } catch {} });
    }
  } catch (e) {
    _initError = e?.message ?? String(e);
    console.warn('[agint-input-gateway] adversarial init error:', _initError);
  }
}

export const adversarialChannel = {
  id: CHANNEL_ID,
  type: CHANNEL_TYPE,
  // v0.1.4 口径统一：通道声明与调度入参同用 schema 的 C4_CRON（每日 03:30）。
  // 旧值 `0 3 * * 0`（每周）与调度器实跑的每日不同 ⇒ _tick 用本字段算下一次，
  // 首轮后即漂成周频（「第二套时间口径」同类病）。
  cron: C4_CRON,

  /**
   * fetch: 空 drain（心跳保留）。信号已在事件到达时即投，见文件头注释。
   */
  async fetch(_ctx) {
    return [];
  },

  /**
   * health: 报告订阅状态和即投统计。
   */
  async health() {
    return {
      channelId: CHANNEL_ID,
      status: _subscribed ? 'ok' : 'degraded',
      initError: _initError,
      mode: 'immediate-emit',
      ingestedSignals: _ingested,
      ingestFailed: _ingestFailed,
      detectors: {
        counterfactual: { active: _subscribed, source: 'diagnosis.completed' },
        curriculumResult: { active: _subscribed, source: 'curriculum.challenge-verdicted' },
        boundaryDivergence: { active: _subscribed, source: 'curriculum.boundary-probed' },
      },
    };
  },
};

export { initSubscriptions };






