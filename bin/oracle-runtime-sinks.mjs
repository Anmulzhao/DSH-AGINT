#!/usr/bin/env node
/**
 * bin/oracle-runtime-sinks.mjs —— 受控链路的**真实 sink 适配器**
 *
 * 2026-11-07「开始接线，大胆一些」：把 B1 的「显式注入 sink」从概念落到实处。
 * 这里提供两个真 sink，走插件自己的 lib + 真实 DomainFacility + 自带 zod spec，
 * 不绕校验、不直写 storages JSON 格式、不挂 cordis、不连 3080。
 *
 * ⛔ 安全核心：assertRehearsalRoot() —— 演练域不得等于（或位于）生产 storages；
 *    未显式 approve 时，任何指向生产域的 sink 一律拒绝构造。
 * ⛔ 默认 sink 是 makeDryRunSink()：只记录载荷，writes=0。
 * ⛔ 投递的只是 status='proposed' 候选（纲领附二 R1/R3「投递 ≠ 修改」），
 *    evolve 提案显式 autoExecutable:false ⇒ 不会进自动执行队列。
 * ⛔ 不读任何分数字段：信封已由 buildPrescriptionEnvelope 冻结并拒收分数。
 *
 * 复刻 agint-offline-harness 的 file kv backend，但把 STORAGES 参数化，
 * 使演练可以指向隔离域而不碰线上对象。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SINKS_SCHEMA = '1.0';
export const DEFAULT_DSH_ROOT = '/home/kylin/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh';
export const DEFAULT_REPO_ROOT = '/home/kylin/projects/DSH/DSH-AGINT';
export const DEFAULT_BUNDLE_ROOT = '/home/kylin/projects/DSH/AGINT-data/.agint-bundle/plugins';

/**
 * ⛔ 硬判据：演练域不得等于生产 storages，也不得是它的子目录。
 * approve 必须显式为 true 才允许指向生产域（本批 CLI 永不置 true）。
 */
export function assertRehearsalRoot(storages, productionStorages, { approve = false } = {}) {
  if (typeof storages !== 'string' || !storages.trim()) {
    return { ok: false, reason: 'SINK_ROOT_MISSING: 未指定 storages 根' };
  }
  const s = resolve(storages);
  const p = productionStorages ? resolve(productionStorages) : null;
  if (!approve && p && (s === p || s.startsWith(p + sep))) {
    return {
      ok: false,
      reason: `SINK_ROOT_IS_PRODUCTION: ${s} 等于/位于生产 storages ${p}`
        + ' ⇒ 未显式 approve 时拒绝构造真 sink（演练必须指向隔离域）',
    };
  }
  if (!existsSync(s)) {
    return { ok: false, reason: `SINK_ROOT_NOT_EXISTS: ${s} 不存在 ⇒ 不自动创建，避免误写` };
  }
  return { ok: true, reason: '', storages: s, productionStorages: p, approve };
}

/** 默认 sink：只把载荷记进内存数组，零写入。 */
export function makeDryRunSink() {
  const recorded = [];
  const sink = (envelope) => {
    recorded.push(Object.freeze({ ...envelope }));
    return { ok: true, recorded: true, writes: 0, target: envelope?.target ?? null };
  };
  return { sink, recorded, kind: 'dry-run', writes: 0 };
}

/** 参数化 file kv backend：与 harness 同形状，读写原样 JSON（1 空格缩进）。 */
function fileKvBackend(storages) {
  return {
    kv: {
      async open(descriptor) {
        const file = join(storages, `${descriptor.name}.json`);
        let data = { unit: { name: descriptor.name, version: descriptor.version }, global: null, tables: {} };
        if (existsSync(file)) {
          try {
            data = JSON.parse(await readFile(file, 'utf8'));
          } catch (e) {
            throw new Error(`解析 ${file} 失败: ${e.message}`);
          }
        }
        data.tables ??= {};
        const save = async () => { await writeFile(file, `${JSON.stringify(data, null, 1)}\n`); };
        return {
          async loadAll() {
            return {
              unit: data.unit ?? { name: descriptor.name, version: descriptor.version },
              global: data.global ?? null,
              tables: data.tables ?? {},
            };
          },
          async putRecord(table, key, value) { (data.tables[table] ??= {})[key] = value; await save(); },
          async deleteRecord(table, key) { if (data.tables[table]) { delete data.tables[table][key]; await save(); } },
          async setGlobal(value) { data.global = value; await save(); },
          async close() {},
        };
      },
    },
  };
}

async function loadFacility(dshRoot, storages) {
  const facilityPath = join(dshRoot, 'node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js');
  if (!existsSync(facilityPath)) {
    throw new Error(`DSH_STORAGE_DOMAIN_MISSING: ${facilityPath} 不存在（DSH_ROOT 是否指对？）`);
  }
  const { DomainFacility } = await import(pathToFileURL(facilityPath).href);
  const backend = fileKvBackend(storages);
  const domainCtx = {
    storage: { backend: { get: () => backend } },
    logger: { warn: () => {}, error: () => {} },
    emit: () => {},
    effect: () => {},
  };
  const facility = new DomainFacility(domainCtx, { backend: 'file', routes: {} });
  const provided = new Map();
  const disposers = [];
  const ctx = {
    storageDomain: facility,
    provide: (k, v) => provided.set(k, v),
    get: () => null,               // 离线软降级：不带任何跨插件服务
    effect: (fn) => { disposers.push(fn); },
    logger: domainCtx.logger,
    emit: () => {},
  };
  return {
    ctx,
    provided,
    dispose: async () => {
      for (const d of disposers.reverse()) { try { await d(); } catch { /* ignore */ } }
    },
  };
}

/** 插件 lib 路径：优先部署位（能解析真实依赖包），回退仓库位。 */
export function resolvePluginLib(pluginName, { bundleRoot = DEFAULT_BUNDLE_ROOT, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const candidates = [
    join(bundleRoot, pluginName, 'lib/index.js'),
    join(repoRoot, 'plugins', pluginName, 'lib/index.js'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 真 sink：把 status=proposed 候选投进 evolve 提案队列。
 * 走 svc.propose() ⇒ 插件自带 proposalSchema（zod）校验 ⇒ DomainFacility 写穿。
 */
export function makeEvolveSink({
  storages,
  productionStorages = null,
  approve = false,
  dshRoot = DEFAULT_DSH_ROOT,
  bundleRoot = DEFAULT_BUNDLE_ROOT,
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  const guard = assertRehearsalRoot(storages, productionStorages, { approve });
  const sink = async (envelope) => {
    if (!guard.ok) return { ok: false, writes: 0, reason: guard.reason };
    if (envelope?.target !== 'proposal_queue') {
      return { ok: false, writes: 0, reason: `SINK_TARGET_MISMATCH: ${envelope?.target}` };
    }
    const lib = resolvePluginLib('agint-evolve', { bundleRoot, repoRoot });
    if (!lib) return { ok: false, writes: 0, reason: 'EVOLVE_LIB_MISSING: 找不到 agint-evolve/lib/index.js' };

    let host;
    try {
      host = await loadFacility(dshRoot, guard.storages);
      const mod = await import(pathToFileURL(lib).href);
      await mod.apply(host.ctx, { root: repoRoot }); // evolve 的 apply 需要 root
      const svc = host.provided.get('agint.evolve');
      if (!svc || typeof svc.propose !== 'function') {
        throw new Error('agint.evolve.propose 未提供');
      }
      const rec = await svc.propose({
        title: `［受控投递·候选］${String(envelope.body).slice(0, 60)}`,
        body: [
          envelope.body,
          '',
          '— 受控投递元数据（不构成判定）—',
          `信封 id: ${envelope.id}`,
          `外部锚: ${envelope.labelAuthority} / 冻结标签 ${envelope.frozenLabelCount} 条`,
          `可证伪预测: ${envelope.predictedDelta}（来源 ${envelope.predictedDeltaSource}）`,
          `证据: ${envelope.evidenceRef}`,
          '⛔ status=proposed、autoExecutable=false；执行须另走既有驱动与人工审批。',
        ].join('\n'),
        category: 'other',
        source: 'oracle-gated-runtime',
        autoExecutable: false,   // ⛔ 复核类提案：不进自动执行队列
        note: 'oracle 受控投递通道产出；投递 ≠ 修改（纲领附二 R3）',
      });
      await host.dispose();
      return {
        ok: true, writes: 1, target: 'proposal_queue',
        ref: rec?.id ?? null, status: rec?.status ?? 'proposed',
        storageRoot: guard.storages,
      };
    } catch (e) {
      if (host) { try { await host.dispose(); } catch { /* ignore */ } }
      return { ok: false, writes: 0, reason: `SINK_ERROR: ${e.message}` };
    }
  };
  return { sink, kind: 'evolve-propose', guard, writes: guard.ok ? undefined : 0 };
}

/**
 * 真 sink：往 curriculum 挑战队列投一条真实模板挑战。
 * 走 svc.generate() ⇒ packChallenge + 插件 spec 校验，不自己拼记录。
 */
export function makeCurriculumSink({
  storages,
  productionStorages = null,
  approve = false,
  dshRoot = DEFAULT_DSH_ROOT,
  bundleRoot = DEFAULT_BUNDLE_ROOT,
  repoRoot = DEFAULT_REPO_ROOT,
  domain = 'integration',
} = {}) {
  const guard = assertRehearsalRoot(storages, productionStorages, { approve });
  const sink = async (envelope) => {
    if (!guard.ok) return { ok: false, writes: 0, reason: guard.reason };
    if (envelope?.target !== 'curriculum_challenge_queue') {
      return { ok: false, writes: 0, reason: `SINK_TARGET_MISMATCH: ${envelope?.target}` };
    }
    const lib = resolvePluginLib('agint-curriculum', { bundleRoot, repoRoot });
    if (!lib) return { ok: false, writes: 0, reason: 'CURRICULUM_LIB_MISSING: 找不到 agint-curriculum/lib/index.js' };

    let host;
    try {
      host = await loadFacility(dshRoot, guard.storages);
      const mod = await import(pathToFileURL(lib).href);
      await mod.apply(host.ctx, {});
      const svc = host.provided.get('agint.curriculum');
      if (!svc || typeof svc.generate !== 'function') throw new Error('agint.curriculum.generate 未提供');
      const res = await svc.generate({ domain, count: 1, force: true });
      await host.dispose();
      if (res?.skipped) return { ok: false, writes: 0, reason: `SINK_SKIPPED: ${res.reason ?? '模板/冷却跳过'}` };
      const ids = Array.isArray(res?.challengeIds) ? res.challengeIds : (res?.created ?? []).map?.((c) => c?.id) ?? [];
      if (!ids.length) return { ok: false, writes: 0, reason: 'SINK_NO_CHALLENGE: generate 未产出挑战 id' };
      return { ok: true, writes: ids.length, target: 'curriculum_challenge_queue', ref: ids[0], storageRoot: guard.storages };
    } catch (e) {
      if (host) { try { await host.dispose(); } catch { /* ignore */ } }
      return { ok: false, writes: 0, reason: `SINK_ERROR: ${e.message}` };
    }
  };
  return { sink, kind: 'curriculum-generate', guard, writes: guard.ok ? undefined : 0 };
}

/** sink 自省：给 --status 用，不触发任何挂载。 */
export function describeSinks() {
  return {
    schemaVersion: SINKS_SCHEMA,
    default: { kind: 'dry-run', writes: 0, note: '默认只记录载荷' },
    available: [
      { kind: 'evolve-propose', target: 'proposal_queue', via: 'agint.evolve.propose() + proposalSchema' },
      { kind: 'curriculum-generate', target: 'curriculum_challenge_queue', via: 'agint.curriculum.generate() + challenge spec' },
    ],
    guard: 'assertRehearsalRoot：未 approve 时禁止指向生产 storages；演练须用隔离域',
  };
}
