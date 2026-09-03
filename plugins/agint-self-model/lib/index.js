/**
 * agint-self-model v0.7.1 — Cordis 入口（Sprint 13 / Part 2）
 *
 * 定位（设计稿 §4.1 / D2）：只读观察者。聚合 evolution-memory / diagnosis /
 * metrics / tool-stats 形成自我画像；输出能力边界供 curriculum（Sprint 14）
 * 消费；发布 A11 self.model.updated（T1 影子期 publish-only）。
 *
 * 5 Service（3 FROZEN + 2 辅助，设计稿 §4.3）：
 *   agint.selfModel.snapshot({ domain? })        → SelfModelSnapshot
 *   agint.selfModel.update({ trigger, evidence }) → { ok, updatedDomains[] }
 *   agint.selfModel.calibrate({ windowDays? })    → CalibrationResult[]
 *   agint.selfModel.stats()                       → 计数摘要（辅助）
 *   agint.selfModel.inspectSummary()              → 巡检摘要（辅助）
 *
 * 事件集成（设计稿 §4.5）：
 *   - 消费（影子）：订阅 A6 diagnosis.completed / A8 dream.completed → 轻量 update
 *   - 发布（A11）：self.model.updated（publish-only；payload FROZEN）
 *
 * 不变量：
 *   - 不写 qualityPolicy / mutator / population 任何状态（D2；self-model-isolation 强制）
 *   - 所有数据来源调用软降级（D6 复用，缺失即空/零，不影响契约）
 */

import { openStore, nowIso } from './storage.js';
import {
  readCapabilities, recomputeCapabilities,
} from './capability.js';
import {
  readReasoningProfile, readResourceBaseline, recomputeObservation,
} from './observation.js';
import {
  runCalibration, summarizeCalibration, readCalibrationLog,
} from './calibration.js';
import {
  UpdateTriggerSchema, DEFAULT_CALIBRATION_WINDOW_DAYS,
} from './schema.js';

const name = 'agint-self-model';
const inject = [
  'storageDomain',
  'agint.evolution',
  'agint.diagnosis',
  'agint.metrics',
  'agint.toolStats',
  'agint.eventBus',
];
const Config = undefined;

// ── 数据来源访问器（软降级；D6 复用既有 Service）────────────────────────────

function buildDeps(ctx) {
  return {
    get(svcName) {
      try {
        return (typeof ctx.get === 'function') ? ctx.get(svcName) : null;
      }
      catch {
        return null;
      }
    },
  };
}

// ── 聚合：能力图谱证据（从 evolution + diagnosis 按 domain 聚合）──────────────

async function aggregateCapabilityEvidence(deps, { windowDays = 7 } = {}) {
  let failures = [];
  let templates = [];
  const evo = deps.get('agint.evolution');
  try {
    if (evo && typeof evo.queryFailures === 'function') {
      failures = (await evo.queryFailures({ days: windowDays })) ?? [];
    }
  }
  catch { failures = []; }
  try {
    if (evo && typeof evo.queryTemplates === 'function') {
      templates = (await evo.queryTemplates({ days: windowDays })) ?? [];
    }
  }
  catch { templates = []; }

  // 全局非环境根因占比（diagnosis 根因分布代理；ENVIRONMENT_SHIFT 视为环境噪音）
  let nonEnvRatio = 1;
  try {
    const diag = deps.get('agint.diagnosis');
    if (diag && typeof diag.report === 'function') {
      const rep = await diag.report({ windowDays });
      const dist = rep?.rootCauseDistribution ?? {};
      const total = Object.values(dist).reduce((s, v) => s + (Number(v) || 0), 0);
      const env = Number(dist.ENVIRONMENT_SHIFT) || 0;
      nonEnvRatio = total > 0 ? Math.max(0, Math.min(1, (total - env) / total)) : 1;
    }
  }
  catch { /* ignore */ }

  const byDomain = new Map();
  const push = (domain, kind, ref) => {
    const d = domain && typeof domain === 'string' && domain.length > 0 ? domain : 'unknown';
    if (!byDomain.has(d)) byDomain.set(d, { ok: 0, fail: 0, refs: [] });
    byDomain.get(d)[kind] += 1;
    if (ref) byDomain.get(d).refs.push(String(ref));
  };
  for (const f of (Array.isArray(failures) ? failures : [])) push(f?.category ?? 'unknown', 'fail', f?.pattern);
  for (const t of (Array.isArray(templates) ? templates : [])) push(t?.category ?? 'unknown', 'ok', t?.pattern);

  const aggregated = [];
  for (const [domain, info] of byDomain) {
    aggregated.push({
      domain,
      capability: domain, // v0.7.1 每域单能力（简化；curriculum 消费前最小集）
      evidence: {
        recentSuccess: info.ok,
        recentFailure: info.fail,
        nonEnvRootCauseRatio: nonEnvRatio,
        evidenceRefs: info.refs.slice(0, 20),
      },
    });
  }
  return aggregated;
}

// ── 聚合：校准实测 per domain（evolution 成功率）────────────────────────────

async function buildCalibrationDomains(deps, { windowDays }) {
  let failures = [];
  let templates = [];
  const evo = deps.get('agint.evolution');
  try {
    if (evo && typeof evo.queryFailures === 'function') failures = (await evo.queryFailures({ days: windowDays })) ?? [];
  }
  catch { failures = []; }
  try {
    if (evo && typeof evo.queryTemplates === 'function') templates = (await evo.queryTemplates({ days: windowDays })) ?? [];
  }
  catch { templates = []; }
  const byDomain = new Map();
  const push = (domain, kind) => {
    const d = domain && typeof domain === 'string' && domain.length > 0 ? domain : 'unknown';
    if (!byDomain.has(d)) byDomain.set(d, { ok: 0, fail: 0 });
    byDomain.get(d)[kind] += 1;
  };
  for (const f of (Array.isArray(failures) ? failures : [])) push(f?.category ?? 'unknown', 'fail');
  for (const t of (Array.isArray(templates) ? templates : [])) push(t?.category ?? 'unknown', 'ok');
  return [...byDomain.entries()].map(([domain, info]) => {
    const total = info.ok + info.fail;
    return { domain, actual: total > 0 ? info.ok / total : 0, samples: total };
  });
}

// ── 发布 A11（T1 影子期 publish-only；软降级）───────────────────────────────

async function publishUpdated(ctx, { changedDomains, snapshot }) {
  const publish = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.publish') : null;
  if (typeof publish !== 'function') return false;
  try {
    await publish({
      topic: 'self.model.updated',
      version: 1,
      source: 'agint-self-model',
      payload: {
        changedDomains,
        capabilitySummary: {
          canCount: snapshot.capabilities.filter((c) => c.status === 'CAN').length,
          cannotCount: snapshot.capabilities.filter((c) => c.status === 'CANNOT').length,
          uncertainCount: snapshot.capabilities.filter((c) => c.status === 'UNCERTAIN').length,
        },
        calibrationSummary: snapshot.calibrationSummary,
      },
    });
    return true;
  }
  catch {
    return false; // 软降级：影子期 publisher 不可用时静默跳过
  }
}

// ── snapshot 构造 ──────────────────────────────────────────────────────────

async function buildSnapshot(store) {
  const [capabilities, reasoningProfile, resourceBaseline, calibrationSummary] = await Promise.all([
    readCapabilities(store),
    readReasoningProfile(store),
    readResourceBaseline(store),
    summarizeCalibration(store),
  ]);
  return { capabilities, reasoningProfile, resourceBaseline, calibrationSummary };
}

// ── 主 update（轻量重算 + 可选全量校准 + A11 发布）─────────────────────────

async function selfUpdate(ctx, store, deps, { trigger, evidence }) {
  // 校验 trigger（FROZEN enum；非法即抛）
  UpdateTriggerSchema.parse(trigger);
  const now = nowIso();
  const aggregated = await aggregateCapabilityEvidence(deps, { windowDays: 7 });
  const updatedDomains = await recomputeCapabilities(store, aggregated, { now });
  await recomputeObservation(store, deps, { now });

  // weekly 触发器走全量校准主路径（设计稿 §4.5）
  let miscalibrated = [];
  if (trigger === 'weekly') {
    const result = await runCalibration({
      store,
      getDomains: () => buildCalibrationDomains(deps, { windowDays: DEFAULT_CALIBRATION_WINDOW_DAYS }),
      getPriorPredicted: () => null, // runCalibration 自行从 calibration_log 取最新 predicted
      writeFailure: async (domain, error) => {
        const evo = deps.get('agint.evolution');
        if (evo && typeof evo.addFailure === 'function') {
          await evo.addFailure({
            pattern: `self-model-miscalibration:${domain}`,
            category: 'self-model',
            severity: 'low',
            evidence: `calibration error ${error} > threshold (domain=${domain})`,
          });
        }
      },
      now,
    });
    miscalibrated = result.miscalibrated;
  }

  const snapshot = await buildSnapshot(store);
  if (trigger === 'weekly' && miscalibrated.length > 0) {
    // 周复盘告警（控制台；真实告警走 wiki 复盘模板由 quality-report 消费）
    console.warn(`[agint-self-model] calibration miscalibrated domains: ${miscalibrated.join(', ')}`);
  }
  // A11 发布（T1 影子期 publish-only；软降级不阻塞）
  await publishUpdated(ctx, { changedDomains: updatedDomains, snapshot });
  return { ok: true, updatedDomains };
}

// ── apply ───────────────────────────────────────────────────────────────────

function apply(ctx, _config = {}) {
  const store = openStore(ctx);
  const deps = buildDeps(ctx);
  const disposers = [];

  ctx.effect(() => () => {
    try { store.close?.(); } catch { /* ignore */ }
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });

  // Service: snapshot
  async function snapshot({ domain } = {}) {
    const snap = await buildSnapshot(store);
    if (domain && typeof domain === 'string' && domain.length > 0) {
      return { ...snap, capabilities: snap.capabilities.filter((c) => c.domain === domain) };
    }
    return snap;
  }

  // Service: update
  async function update(input = {}) {
    return selfUpdate(ctx, store, deps, {
      trigger: input?.trigger ?? 'weekly',
      evidence: input?.evidence,
    });
  }

  // Service: calibrate
  async function calibrate({ windowDays } = {}) {
    const wd = Number.isInteger(windowDays) && windowDays > 0 ? windowDays : DEFAULT_CALIBRATION_WINDOW_DAYS;
    const result = await runCalibration({
      store,
      getDomains: () => buildCalibrationDomains(deps, { windowDays: wd }),
      getPriorPredicted: () => null,
      writeFailure: async (d, error) => {
        const evo = deps.get('agint.evolution');
        if (evo && typeof evo.addFailure === 'function') {
          await evo.addFailure({
            pattern: `self-model-miscalibration:${d}`,
            category: 'self-model',
            severity: 'low',
            evidence: `calibration error ${error} > threshold (domain=${d})`,
          });
        }
      },
    });
    return result.results;
  }

  // Service: stats（辅助）
  async function stats() {
    const [cap, reason, res, cal] = await Promise.all([
      store.tables.capabilityMap.size(),
      store.tables.reasoningProfile.size(),
      store.tables.resourceBaseline.size(),
      store.tables.calibrationLog.size(),
    ]);
    return {
      capabilityMap: cap, reasoningProfile: reason,
      resourceBaseline: res, calibrationLog: cal,
    };
  }

  // Service: inspectSummary（辅助，对齐 event-bus 惯例）
  async function inspectSummary() {
    const [capCount, calSummary] = await Promise.all([
      store.tables.capabilityMap.size(),
      summarizeCalibration(store),
    ]);
    return {
      capabilityCount: capCount,
      reasoningCount: await store.tables.reasoningProfile.size(),
      resourceCount: await store.tables.resourceBaseline.size(),
      calibrationCount: await store.tables.calibrationLog.size(),
      calibrationSummary: calSummary,
    };
  }

  ctx.provide('agint.selfModel.snapshot', snapshot);
  ctx.provide('agint.selfModel.update', update);
  ctx.provide('agint.selfModel.calibrate', calibrate);
  ctx.provide('agint.selfModel.stats', stats);
  ctx.provide('agint.selfModel.inspectSummary', inspectSummary);

  // 影子消费：A6 diagnosis.completed / A8 dream.completed（audit-only；handler 永不抛）
  try {
    const subscribe = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof subscribe === 'function') {
      const offA6 = subscribe(
        { subscriber: 'agint-self-model', topics: ['diagnosis.completed'], mode: 'async' },
        async () => { try { await selfUpdate(ctx, store, deps, { trigger: 'diagnosis-completed' }); } catch { /* ignore */ } },
      );
      const offA8 = subscribe(
        { subscriber: 'agint-self-model', topics: ['dream.completed'], mode: 'async' },
        async () => { try { await selfUpdate(ctx, store, deps, { trigger: 'dream-completed' }); } catch { /* ignore */ } },
      );
      if (typeof offA6 === 'function') disposers.push(offA6);
      if (typeof offA8 === 'function') disposers.push(offA8);
    }
  }
  catch { /* bus 不可用：影子订阅静默跳过 */ }
}

export { Config, apply, name, inject };
