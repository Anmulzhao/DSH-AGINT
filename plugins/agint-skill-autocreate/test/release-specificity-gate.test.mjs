// 门 5（发布前特异性复检）测试 —— 2026-09-18
//
// 背景（生产实证，不是假想）：A1 特异性门只作用于候选**产生时**，管不到它上线前
// 累积的存量队列。2026-09-18 首次真实运行后核账发现：37 个 QUEUED_FOR_RELEASE
// 候选里 36 个是纯脚手架，且当日已自动发布出 pwsh-pwsh-pwsh-pwsh。
// 故在发布路径上补最后一道闸，用同一套黑名单判据。
//
// mock 脚手架与 release.test.mjs 同款，独立一份以免两文件耦合。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { packCandidate } from '../lib/storage.js';
import { classifySpecificity, SCAFFOLD_TOOLS } from '../lib/detector.js';

// ── mock ──────────────────────────────────────────────────────────────────
function fakeTable() {
  const m = new Map();
  return {
    put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    entries: () => [...m.entries()],
    del: async (k) => { m.delete(k); },
  };
}
function fakeDomain() {
  const tables = new Map();
  return {
    close: async () => {},
    table: (name) => {
      if (!tables.has(name)) tables.set(name, fakeTable());
      return tables.get(name);
    },
  };
}
function mockCtx(services = {}) {
  const provided = {};
  let domain = null;
  return {
    storageDomain: { open: async () => { if (!domain) domain = fakeDomain(); return domain; } },
    get: (key) => services[key] ?? null,
    provide: (key, val) => { provided[key] = val; },
    effect: () => {},
    _provided: provided,
  };
}

const policyOk = { decide: async () => ({ kind: 'AUTO_DEPLOY', score: 0.8, policyId: 'p1', reason: 'ok' }) };

function candidateWithTools(name, tools, status = 'QUEUED_FOR_RELEASE') {
  return packCandidate({
    sourcePatternId: 'tp_test_spec',
    source: 'auto',
    triggerEvent: 'test',
    skillDraft: {
      name,
      description: '测试用候选',
      category: 'productivity',
      template: 'file-batch',
      frontmatter: { name, description: '测试用候选', triggers: ['x'], tools },
      body: '# 步骤',
      references: [],
      scripts: [],
    },
    estimatedBenefit: {
      successRateImprovement: 0.2, timeSavingsPct: 0.3, tokenSavingsPct: 0.2, harmIncrementEstimate: 0.05,
    },
    status,
    evalResults: { phase1: { status: 'pass' }, phase3: { rankingScore: 0.62, evidenceLevel: 'E0', provisional: true } },
    rejectionReason: null,
    releasedAt: null,
    releasedVersion: null,
    rollbackReason: null,
  });
}

function setup(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autocreate-spec-'));
  const jsonl = join(root, 'tool_stats.jsonl');
  writeFileSync(jsonl, '', 'utf8');
  const ctx = mockCtx({ 'agint.qualityPolicy': opts.policy ?? policyOk });
  plugin.apply(ctx, {
    skills_root: join(root, 'skills'),
    rollback_archive_dir: join(root, 'rolled-back'),
    jsonlPath: jsonl,
    session_source: 'tool_stats',        // 隔离：不读真实 ~/.dsh/sessions
    require_human_approval_until: '2020-01-01T00:00:00.000Z',  // 门 2 不生效，专测门 5
    ...(opts.config ?? {}),
  });
  return { svc: ctx._provided['agint.skillAutocreate'], ctx, root };
}

async function put(ctx, cand) {
  const d = await ctx.storageDomain.open();
  await d.table('candidates').put(cand.id, cand);
}
async function rowOf(ctx, id) {
  const d = await ctx.storageDomain.open();
  const hit = d.table('candidates').entries().find(([k]) => k === id);
  return hit ? hit[1] : null;
}

// ── 门 5 行为 ──────────────────────────────────────────────────────────────

test('门 5：纯脚手架候选被拒发，且落终态 REJECTED（不是 BUDGET_WAIT）', async () => {
  const h = setup();
  const cand = candidateWithTools('pwsh-pwsh-pwsh-pwsh', ['pwsh', 'read', 'edit', 'glob']);
  await put(h.ctx, cand);

  const r = await h.svc.release({ id: cand.id, manual: false });
  assert.equal(r.released, false);
  assert.equal(r.gate, 'specificity', `应停在 specificity 门，实际 gate=${r.gate} reason=${r.reason}`);

  const row = await rowOf(h.ctx, cand.id);
  // 关键：不能是 BUDGET_WAIT —— 那会让 releaseQueue 每天把同一批重试一遍并刷日志。
  // 特异性不合格是永久性的（除非黑名单变更），必须给终态。
  assert.equal(row.status, 'REJECTED');
  assert.match(String(row.rejectionReason), /specificity/);
});

test('门 5：含领域工具的候选照常发布（不误杀）', async () => {
  const h = setup();
  const cand = candidateWithTools('deploy-to-nas', ['ssh_exec', 'ssh_upload', 'read']);
  await put(h.ctx, cand);

  const r = await h.svc.release({ id: cand.id, manual: false });
  assert.equal(r.released, true, `不应拦下带 ssh_* 的候选，gate=${r.gate} reason=${r.reason}`);
});

test('门 5：未收录工具（可能是没登记的领域工具）放行 —— 与 A1 同向', async () => {
  const h = setup();
  const cand = candidateWithTools('some-new-domain-workflow', ['read', 'brand_new_domain_tool']);
  await put(h.ctx, cand);

  const r = await h.svc.release({ id: cand.id, manual: false });
  assert.equal(r.released, true, 'unknown 放行是刻意的（误杀比漏拦更难发现）');
});

test('门 5：空 tools 按「无特异性」拦下（与 A1 边界一致）', async () => {
  const h = setup();
  const cand = candidateWithTools('no-tools-recorded', []);
  await put(h.ctx, cand);

  const r = await h.svc.release({ id: cand.id, manual: false });
  assert.equal(r.released, false);
  assert.equal(r.gate, 'specificity');
});

test('门 5：manual=true 也不绕（与门 3 同理，质量门不该被人工点头打开）', async () => {
  const h = setup();
  const cand = candidateWithTools('pwsh-pwsh-glob', ['pwsh', 'pwsh', 'glob']);
  await put(h.ctx, cand);

  const r = await h.svc.release({ id: cand.id, manual: true });
  assert.equal(r.released, false);
  assert.equal(r.gate, 'specificity');
});

test('门 5：release_specificity_gate_enabled=false 退回旧行为（kill-switch）', async () => {
  const h = setup({ config: { release_specificity_gate_enabled: false } });
  const cand = candidateWithTools('pwsh-pwsh-pwsh-pwsh', ['pwsh', 'read']);
  await put(h.ctx, cand);

  const r = await h.svc.release({ id: cand.id, manual: false });
  assert.equal(r.released, true, '关掉开关后应恢复「不做特异性复检」的旧行为');
});

// ── 回归：2026-09-18 生产里实际逃过门的序列 ────────────────────────────────

test('回归：2026-09-18 实际生成的候选序列，扩黑名单后不再放行', () => {
  // 这条序列当天真的生成了候选 sc_20260918_bc0a06 并进入评估队列。
  // 逃过的原因是 restart_request 当时不在黑名单（被当 unknown → 放行）。
  const tools = ['read', 'ask_user_question', 'edit', 'pwsh', 'grep', 'restart_request'];
  const r = classifySpecificity(tools);
  assert.equal(r.scaffoldOnly, true, `应判为纯脚手架，实际 scaffold=${r.scaffold} domain=${r.domain} unknown=${r.unknown}`);
});

test('回归：审计列出的 20 种控制面工具全部进黑名单（避免再逃）', () => {
  // 来源：生产审计 pattern_specificity_unknown_tools（2026-09-18T02:11:26Z）
  const audited = [
    'restart_status', 'restart_request', 'autocreate_stats', 'autocreate_list_candidates',
    'autocreate_list_patterns', 'autocreate_list_releases', 'autocreate_get_candidate',
    'autocreate_trigger_eval', 'autocreate_release', 'cron_list', 'cron_run_now',
    'dream_status', 'dream_diary', 'dream_run_now', 'memory_read', 'memory_stats',
    'memory_forget_scan', 'evolve_propose', 'evolve_proposals', 'evolve_set_status',
    'evolution_logPhase4', 'curator_list', 'curator_run_now', 'wiki_list', 'wiki_lint',
    'rule_check', 'recall_store_inspect', 'selfModel_update', 'diagnosis_annotate',
    'eventBus_publish',
  ];
  const missing = audited.filter((t) => !SCAFFOLD_TOOLS.has(t));
  assert.deepEqual(missing, [], `这些工具已出现在生产审计里，应补进黑名单：${missing.join(', ')}`);
});

test('回归：黑名单里不含被误判成脚手架的领域工具', () => {
  // 领域工具（真正携带业务语义）必须留在黑名单之外，否则会误杀好模式。
  // ⚠️ 2026-09-18 修订：web_search / web_fetch / agint_search 已**不再是**领域工具
  // （判据：通用"查询"动作，与 memory_search / wiki_search 同性质）——
  // 正是它们曾被当领域工具，才让两个空壳在 04:45 被自动发布。见下一条测试。
  const domainTools = ['ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel',
    'wiki_write', 'memory_write',
    'abtest_start', 'abtest_report', 'curriculum_next', 'curriculum_submit', 'skill'];
  const wrong = domainTools.filter((t) => SCAFFOLD_TOOLS.has(t));
  assert.deepEqual(wrong, [], `这些是领域工具，不应进脚手架黑名单：${wrong.join(', ')}`);
});

test('回归：通用查询动作（web_search/web_fetch/agint_search）已判为脚手架', () => {
  // 生产证据链：DOMAIN_TOOLS 误放这 3 个 → A1 门判 scaffoldOnly=false
  //   → 04:45 cron 自动发布了 agintsearch-pwsh-askuserquestion-pwsh 与
  //      pwsh-glob-webfetch-webfetch（两条正文均被 A3 判 non-informative-body + tool-recap-only）。
  // 即：**只靠"序列里有个联网查询工具"就放行**，等于给纯脚手架开后门。
  for (const t of ['web_search', 'web_fetch', 'agint_search']) {
    assert.equal(SCAFFOLD_TOOLS.has(t), true, `${t} 应归脚手架`);
  }
  // 门 5 端到端：这两条真实候选的序列，现在应被门 5 拦下
  assert.equal(classifySpecificity(['pwsh', 'glob', 'web_fetch', 'web_fetch']).scaffoldOnly, true);
  assert.equal(
    classifySpecificity(['agint_search', 'pwsh', 'ask_user_question']).scaffoldOnly,
    true,
  );
});
