/**
 * C4 对抗挑战 Channel — 订阅已有模块事件，只转发失败/边界/异常结果。
 *
 * 不新建采集逻辑，只做事件转发和过滤：
 *   diagnosis.completed → 有诊断结果时转发
 *   curriculum.challenge-verdicted → 只转发 fail
 *   curriculum.boundary-probed → 有不可验证边界时转发
 *
 * 事件在到达时放入队列，fetch() 由 Gateway 调度器定期 drain。
 */

const CHANNEL_ID = 'adversarial';
const CHANNEL_TYPE = 'adversarial';

// 事件队列（内存态，fetch 时清空）
let _queue = [];
let _subscribed = false;

/**
 * 初始化事件订阅。在 Gateway 注册后由 index.js 调用。
 * @param {object} ctx — 最小 ctx（含 get/effect）
 */
function initSubscriptions(ctx) {
  if (_subscribed) return;

  try {
    let subscribe = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe !== 'function') {
      const ns = ctx.get('agint.eventBus');
      if (ns && typeof ns.subscribe === 'function') subscribe = ns.subscribe;
    }
    if (typeof subscribe !== 'function') {
      console.warn('[agint-input-gateway] adversarial: eventBus subscribe unavailable');
      return;
    }

    _subscribed = true; // 确认拿到 subscribe 函数后才标记

    const disposer = subscribe(
      {
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
          // diagnosis.completed: 有诊断结果才转发
          if (topic === 'diagnosis.completed') {
            if ((p.clusterCount ?? 0) === 0) return; // 无诊断结果，静默
            _queue.push({
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

          // curriculum.challenge-verdicted: 只转发 fail
          else if (topic === 'curriculum.challenge-verdicted') {
            if (p.result !== 'fail' && p.result !== 'failed') return; // pass 不转发
            _queue.push({
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
            _queue.push({
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

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => { try { disposer(); } catch {} });
    }
  } catch (e) {
    console.warn('[agint-input-gateway] adversarial init error:', e?.message ?? e);
  }
}

export const adversarialChannel = {
  id: CHANNEL_ID,
  type: CHANNEL_TYPE,
  cron: '0 3 * * 0', // 每周日 03:00（C2 02:00 之后，C3 04:00 之前）

  /**
   * fetch: 取出队列中累积的对抗信号。
   */
  async fetch(_ctx) {
    const drained = _queue;
    _queue = [];
    return drained;
  },

  /**
   * health: 报告订阅状态和队列积压。
   */
  async health() {
    return {
      channelId: CHANNEL_ID,
      status: _subscribed ? 'ok' : 'degraded',
      queuedSignals: _queue.length,
      detectors: {
        counterfactual: { active: true, source: 'diagnosis.completed' },
        curriculumResult: { active: true, source: 'curriculum.challenge-verdicted' },
        boundaryDivergence: { active: true, source: 'curriculum.boundary-probed' },
      },
    };
  },
};

export { initSubscriptions };

