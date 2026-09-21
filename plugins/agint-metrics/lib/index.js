/**
 * agint-metrics: host service plugin (provides `agint.metrics`).
 *
 * HOST plane, single instance: opens the `agint_metrics` storage domain once
 * (unique name — `agint` / `agint_rules` are taken, K12) and serves every
 * session. Metrics are a kv time series: each collect() writes one record per
 * computable metric key with a timestamp; summary() returns the latest record
 * per key plus the delta vs the previous record (trend).
 *
 * Sources are read lazily with ctx.get at call time (agint.cron / agint.rules
 * / agint.wiki / agint.memory); a missing or unhealthy source skips its
 * metrics instead of failing the run. The daily collect is wired as the
 * `metrics-collect` cron job (see packages/agint-cron/lib/jobs.js).
 *
 * Sprint 12 / A5: also subscribes to policy.deployed / policy.rolledback (T1
 * shadow period) and writes 1 counter record per envelope into the same
 * `agint_metrics` table (key: policy.deployedCount / policy.rolledbackCount).
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-metrics
 *         name: ./plugins/agint-metrics/lib/index.js
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { computeMetrics, describeMetric } from './metrics.js';
import { attachPolicyCounterSubscription } from './policyCounters.js';
import { attachMountCounterSubscription } from './mountCounters.js';
import { metricSchema, defaultRandomId, buildMetricsService } from './service.js';

const name = 'agint-metrics';
const inject = ['storageDomain'];
const Config = z.object({});

const spec = defineDomain({
  name: 'agint_metrics',
  version: 1,
  tables: { metric: { valueSchema: metricSchema } },
});

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;
  let _policyBusUnsubscribe = null;
  let _mountBusUnsubscribe = null;

  // ctx.effect semantics: callback runs IMMEDIATELY; its RETURN value is the
  // disposer that runs when this fiber is disposed (K4/K8 double-sentinel).
  // fix-20260920：原实现 `if (domain) return domain.close();` 会**跳过**订阅注销
  // （domain 一旦打开就早退），改成先注销所有订阅再关 domain。
  ctx.effect(() => () => {
    disposed = true;
    try { if (typeof _policyBusUnsubscribe === 'function') _policyBusUnsubscribe(); }
    catch { /* ignore */ }
    try { if (typeof _mountBusUnsubscribe === 'function') _mountBusUnsubscribe(); }
    catch { /* ignore */ }
    if (domain) return domain.close();
  });

  const randomId = defaultRandomId;

  const table = async () => {
    if (disposed) throw new Error('agint-metrics: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-metrics: domain unavailable');
    return d.table('metric');
  };

  // Sprint 12 / A5 修订：storageDomain.open 真生产返 Promise，但 mock ctx / 测试 fixture
  // 常返 sync plain object。用 Promise.resolve() 兼容两种形态 —— metrics apply 不抛，
  // policy.* 订阅才能在 domain open 后挂上。
  const ready = Promise.resolve(ctx.storageDomain.open(spec)).then(
    (d) => {
      if (disposed) { void d.close().catch(() => {}); return null; }
      domain = d;
      // Sprint 12 / A5: domain open 后挂 policy.* 订阅（shadow T1）
      const _subscribeBus = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
      _policyBusUnsubscribe = attachPolicyCounterSubscription({
        subscribeFn: _subscribeBus,
        tableFn: table,
        randomIdFn: randomId,
      });
      // A2 接线（2026-09-20）：mount.* 六个 topic 此前**有发布方、零订阅方**，
      // 挂载成功/失败完全不可观测。这里补上计数订阅。
      _mountBusUnsubscribe = attachMountCounterSubscription({
        subscribeFn: _subscribeBus,
        tableFn: table,
        randomIdFn: randomId,
      });
      return d;
    },
    (error) => { domainError = error; return null; },
  );

  ctx.provide('agint.metrics', buildMetricsService({ ctx, table, computeMetrics, describeMetric, randomId }));
}

export { Config, apply, inject, name };