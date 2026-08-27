/**
 * lib/rollback.js — Sprint 10 v0.6.3 #5
 *
 * 三段式原子事务（设计稿 §二.4）：
 *   step 1 原子快照：pluginDir SHA-256 链 + in-memory 文件备份（失败时回退到此位）
 *   step 2 恢复：按 commitEntry.preimageContent 写回 targetPath
 *   step 3 smoke test：ctx.qualitySandbox.runSmoke({ target: { path } })
 *     pass → tags ['rollback-ok']；fail → 恢复到安全位 + 触发 ABSTAIN
 *
 * capturePreimageHash 是纯函数（不依赖 ctx）。
 * FROZEN rollback({ commitId }) → { ok, restoredHash } 不破；事务层返回额外 4 字段。
 */

import { dirname, resolve } from 'node:path';
import { randomId, contentHash } from './storage.js';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);
const EXCLUDED_LOG_RE = /\.(log|lock|swp)$/i;

// in-memory 快照表：transactionId → { pluginDir, files[] }；事务结束立即清空
const _snapshots = new Map();

async function _readDirSafe(fs, dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }
}

/**
 * 纯函数：pluginDir 下排除干扰文件后 SHA-256 链（每条 rel+content 拼接）。
 */
export async function capturePreimageHash(pluginDir, deps = {}) {
  const fs = deps.nodeFs || (await import('node:fs/promises'));
  const root = resolve(pluginDir);
  const entries = [];

  async function walk(dir) {
    const dirents = await _readDirSafe(fs, dir);
    for (const d of dirents) {
      const name = d.name;
      if (d.isDirectory()) {
        if (!EXCLUDED_DIRS.has(name)) await walk(resolve(dir, name));
      } else if (d.isFile() && !EXCLUDED_LOG_RE.test(name)) {
        const abs = resolve(dir, name);
        const rel = abs.slice(root.length + 1).replace(/\\/g, '/');
        let content = '';
        try { content = await fs.readFile(abs, 'utf8'); } catch (_err) { content = ''; }
        entries.push({ rel, content });
      }
    }
  }
  await walk(root);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const chain = entries.map((e) => `${e.rel}\0${e.content}`).join('\n');
  return { hash: await contentHash(chain), fileCount: entries.length };
}

async function _collectFiles(pluginDir, deps) {
  const fs = deps.nodeFs || (await import('node:fs/promises'));
  const root = resolve(pluginDir);
  const files = [];
  async function walk(dir) {
    const dirents = await _readDirSafe(fs, dir);
    for (const d of dirents) {
      const name = d.name;
      if (d.isDirectory()) {
        if (!EXCLUDED_DIRS.has(name)) await walk(resolve(dir, name));
      } else if (d.isFile() && !EXCLUDED_LOG_RE.test(name)) {
        const abs = resolve(dir, name);
        let content = '';
        try { content = await fs.readFile(abs, 'utf8'); } catch (_err) { content = ''; }
        files.push({ rel: abs.slice(root.length + 1).replace(/\\/g, '/'), abs, content });
      }
    }
  }
  await walk(root);
  return files;
}

async function _restoreSnapshot(snapshot, deps) {
  const fs = deps.nodeFs || (await import('node:fs/promises'));
  for (const { abs, content } of snapshot.files) {
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}

/**
 * 三段式事务：原子快照 → 恢复 → smoke test。
 */
export async function runRollbackTransaction({
  ctx, commitEntry, proposal, repoRoot, pluginName, targetPath, nodeFs,
}) {
  if (!ctx) throw new Error('runRollbackTransaction: ctx is required');
  if (!commitEntry) throw new Error('runRollbackTransaction: commitEntry is required');
  if (!pluginName) throw new Error('runRollbackTransaction: pluginName is required');

  const rollbackTransactionId = randomId();
  const deps = { nodeFs };
  const pluginDir = resolve(repoRoot, 'plugins', pluginName);
  const absTarget = resolve(repoRoot, targetPath);
  const fs = deps.nodeFs || (await import('node:fs/promises'));

  // ── step 1: 原子快照
  const { hash: preimageHashAtStart } = await capturePreimageHash(pluginDir, deps);
  const snapFiles = await _collectFiles(pluginDir, deps);
  _snapshots.set(rollbackTransactionId, { pluginDir: resolve(pluginDir), files: snapFiles, createdAt: Date.now() });

  // ── step 2: 恢复 targetPath
  await fs.mkdir(dirname(absTarget), { recursive: true });
  if (proposal && proposal.kind === 'TOOL_SYNTHESIS' && commitEntry.preimageContent.length === 0) {
    try { await fs.unlink(absTarget); }
    catch (err) {
      if (err && err.code !== 'ENOENT') {
        _snapshots.delete(rollbackTransactionId);
        throw new Error(`runRollbackTransaction: TOOL_SYNTHESIS unlink 失败 — ${err.message}`);
      }
    }
  } else {
    await fs.writeFile(absTarget, commitEntry.preimageContent, 'utf8');
  }

  let restoredContent = '';
  try { restoredContent = await fs.readFile(absTarget, 'utf8'); }
  catch (err) {
    if (!(proposal && proposal.kind === 'TOOL_SYNTHESIS' && commitEntry.preimageContent.length === 0)) {
      _snapshots.delete(rollbackTransactionId);
      throw new Error(`runRollbackTransaction: 读 restoredContent 失败（${targetPath}）— ${err.message}`);
    }
  }
  const restoredHash = await contentHash(restoredContent);

  // ── step 3: smoke test
  let smokeResult = { ok: true, checks: [], reason: undefined };
  try {
    const sandbox = ctx.get && ctx.get('agint.qualitySandbox');
    if (!sandbox || typeof sandbox.runSmoke !== 'function') {
      smokeResult = { ok: false, reason: 'sandbox-unavailable', checks: [] };
    } else {
      const raw = await sandbox.runSmoke({
        target: { path: targetPath, name: `${pluginName}/${targetPath.split('/').pop()}` },
      });
      smokeResult = {
        ok: Boolean(raw && raw.ok),
        checks: raw && Array.isArray(raw.checks) ? raw.checks : [],
        reason: raw && raw.ok ? undefined : (raw && raw.reason) || 'smoke-failed',
      };
    }
  } catch (err) {
    smokeResult = { ok: false, reason: err && err.message ? err.message : 'smoke-threw', checks: [] };
  }

  // ── 3a: smoke 通过 → tags ['rollback-ok']
  if (smokeResult.ok) {
    _snapshots.delete(rollbackTransactionId);
    return { rollbackTransactionId, preimageHashAtStart, restoredHash, smokeResult, recovered: false, tags: ['rollback-ok'] };
  }

  // ── 3b: smoke 失败 → 自动恢复到 step 1 拍的安全位
  const snap = _snapshots.get(rollbackTransactionId); _snapshots.delete(rollbackTransactionId);
  let recovered = false;
  if (snap && snap.files.length > 0) {
    try { await _restoreSnapshot(snap, deps); recovered = true; }
    catch (_err) { recovered = false; }
  }

  // 触发 policy ABSTAIN
  let policyNotified = false;
  try {
    const policy = ctx.get && ctx.get('agint.qualityPolicy');
    if (policy && typeof policy.decide === 'function') {
      await policy.decide({
        results: [{
          target: { id: targetPath, kind: 'plugin-postimage' },
          dimensions: [
            { name: 'safety', score: { score: 0.0, veto: true } },
            { name: 'trust', score: { score: 0.0, veto: true } },
          ],
          ok: false,
          reason: `rollback-smoke-failed:${smokeResult.reason || 'unknown'}`,
        }],
      });
      policyNotified = true;
    }
  } catch (_err) { policyNotified = false; }

  return {
    rollbackTransactionId, preimageHashAtStart, restoredHash, smokeResult, recovered, policyNotified,
    tags: recovered ? ['rollback-failed', 'auto-recovered'] : ['rollback-failed'],
    error: `rollback-failed-smoke:${smokeResult.reason || 'unknown'}`,
  };
}

/** 测试 / 运维用：返回当前 in-memory 快照状态。 */
export function _snapshotState() {
  return { active: _snapshots.size, ids: Array.from(_snapshots.keys()) };
}

/** 测试用：清空所有 in-memory 快照。 */
export function _snapshotReset() { _snapshots.clear(); }
