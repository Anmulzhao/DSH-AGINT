/**
 * test/smoke.mjs — agint-self-model v0.7.1 集成 + 单元冒烟
 *
 * 不依赖 dsh 启动（mock ctx，内存存储降级）。跑法（须在仓库根目录）：
 *   node test/smoke.mjs        （cwd = 仓库根）
 * 退出码: 0 全过, 1 任一 fail.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const AGINT_ROOT = process.cwd();
const url = (rel) => pathToFileURL(resolve(AGINT_ROOT, rel)).href;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('✓', name); }
  else { fail += 1; console.log('✗', name, extra); }
}

const schema = await import(url('plugins/agint-self-model/lib/schema.js'));
const capability = await import(url('plugins/agint-self-model/lib/capability.js'));
const calibration = await import(url('plugins/agint-self-model/lib/calibration.js'));
const selfModel = await import(url('plugins/agint-self-model/lib/index.js'));

// ── 纯函数：classifyStatus（FROZEN 三态）────────────────────────────────────
ok('classifyStatus CAN', capability.classifyStatus({ recentSuccess: 5, recentFailure: 0, nonEnvRootCauseRatio: 1 }) === 'CAN');
ok('classifyStatus CANNOT', capability.classifyStatus({ recentSuccess: 0, recentFailure: 3, nonEnvRootCauseRatio: 1 }) === 'CANNOT');
ok('classifyStatus UNCERTAIN (no samples)', capability.classifyStatus({ recentSuccess: 0, recentFailure: 0, nonEnvRootCauseRatio: 0 }) === 'UNCERTAIN');

// ── 纯函数：computeCalibration（cold-start 守门 + 误差 >10% 护栏）─────────────
const cal = calibration.computeCalibration([
  { domain: 'a', predicted: 0.9, actual: 0.9, samples: 20 }, // 误差 0 → 正常
  { domain: 'b', predicted: 0.9, actual: 0.5, samples: 20 }, // 误差 0.4 > 0.1 → miscalibrated
  { domain: 'c', predicted: 0.9, actual: 0.5, samples: 5 },  // cold-start → 不计误差
]);
ok('computeCalibration cold-start 不计误差', cal.find((x) => x.domain === 'c')._miscalibrated === false);
ok('computeCalibration 误差>10% 触发 miscalibration', cal.find((x) => x.domain === 'b')._miscalibrated === true);
ok('computeCalibration 误差≤10% 不触发', cal.find((x) => x.domain === 'a')._miscalibrated === false);

// ── FROZEN：lastVerifiedAt 必填（空字符串硬抛错）──────────────────────────
let threw = false;
try {
  schema.CapabilityEntrySchema.parse({
    domain: 'd', capability: 'c', status: 'CAN', confidence: 0.5, evidenceRefs: [],
    lastVerifiedAt: '', updatedAt: new Date().toISOString(),
  });
} catch { threw = true; }
ok('FROZEN lastVerifiedAt 空串硬抛错', threw);
let validEntry = true;
try {
  schema.CapabilityEntrySchema.parse({
    domain: 'd', capability: 'c', status: 'CAN', confidence: 0.5, evidenceRefs: [],
    lastVerifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
} catch { validEntry = false; }
ok('FROZEN 合法 CapabilityEntry 通过', validEntry);

// ── 端到端：apply + update + snapshot + calibrate + A11 发布 ─────────────────
function mockCtx(services = {}) {
  const provided = new Map(Object.entries(services));
  return {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => provided.set(k, v),
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    storageDomain: { open: () => { throw new Error('test: no real storage'); } },
    on: () => () => {},
  };
}

const published = [];
const services = {
  'agint.eventBus.publish': async (e) => { published.push(e); return { accepted: true }; },
  'agint.eventBus.subscribe': () => () => {},
  'agint.evolution': {
    queryFailures: async () => [
      { category: 'codegen', pattern: 'pf1' }, { category: 'codegen', pattern: 'pf2' }, { category: 'reasoning', pattern: 'pf3' },
    ],
    queryTemplates: async () => [
      { category: 'codegen', pattern: 'pt1' }, { category: 'codegen', pattern: 'pt2' },
    ],
    addFailure: async () => ({}),
    getLogRange: async () => [],
    stats: async () => ({}),
  },
  'agint.diagnosis': {
    report: async () => ({
      rootCauseDistribution: {
        REASONING_ERROR: 1, PLANNING_FAILURE: 0, PROMPT_DEFICIENCY: 0,
        TOOL_GAP: 0, KNOWLEDGE_GAP: 0, ENVIRONMENT_SHIFT: 0, UNCERTAIN: 0,
      },
    }),
  },
  'agint.metrics': { snapshot: async () => ({ metrics: [] }), collect: async () => ({}), summary: async () => ({ metrics: [] }) },
  'agint.toolStats': { summary: async () => ({ summary: [] }) },
};
const ctx = mockCtx(services);
selfModel.apply(ctx, {});

const snapSvc = ctx.get('agint.selfModel.snapshot');
const updSvc = ctx.get('agint.selfModel.update');
const calSvc = ctx.get('agint.selfModel.calibrate');
const statsSvc = ctx.get('agint.selfModel.stats');
const inspectSvc = ctx.get('agint.selfModel.inspectSummary');
ok('5 Service 已注册', snapSvc && updSvc && calSvc && statsSvc && inspectSvc);

const upd = await updSvc({ trigger: 'weekly' });
ok('update 返回 updatedDomains 非空', Array.isArray(upd.updatedDomains) && upd.updatedDomains.length > 0);
const snap = await snapSvc({});
ok('snapshot.capabilities 非空', Array.isArray(snap.capabilities) && snap.capabilities.length > 0);
ok('snapshot 状态均为 FROZEN 三态', snap.capabilities.every((c) => ['CAN', 'CANNOT', 'UNCERTAIN'].includes(c.status)));
ok('snapshot 含 4 块', Array.isArray(snap.reasoningProfile) && Array.isArray(snap.resourceBaseline) && snap.calibrationSummary && typeof snap.calibrationSummary === 'object');

const stats = await statsSvc();
ok('stats 计数正确', stats.capabilityMap > 0 && stats.calibrationLog > 0);
const inspect = await inspectSvc();
ok('inspectSummary 返回计数', typeof inspect.capabilityCount === 'number' && Array.isArray(inspect.calibrationSummary.miscalibrated));

// A11 发布（T1 影子期 publish-only）
const a11 = published.find((e) => e.topic === 'self.model.updated');
ok('A11 self.model.updated 已发布', !!a11);
ok('A11 payload 结构正确', a11 && Array.isArray(a11.payload.changedDomains)
  && a11.payload.capabilitySummary && a11.payload.calibrationSummary);

// calibrate
const calRes = await calSvc({});
ok('calibrate 返回数组', Array.isArray(calRes) && calRes.length > 0);
ok('calibrate 结果形态', calRes.every((r) => typeof r.domain === 'string' && typeof r.error === 'number' && typeof r.samples === 'number'));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
