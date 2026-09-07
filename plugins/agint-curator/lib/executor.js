/**
 * agint-curator: executor — 策展执行器（archive/unarchive/pin/unpin + 状态转换落地）。
 *
 * P0-2 §3.1 [6] / §9.2。归档是策展里唯一的「破坏性」操作，所以这里的顺序是
 * 「先校验 → 再移动 → 最后落状态」，任何一步失败都不留下半完成状态：
 *
 *   1. 存在性 + 幂等（已 archived → skipped，不报错）
 *   2. 保护校验（pinned / protected / 非本地管理来源）
 *   3. 预算校验（本周归档数 < weekly_archive_budget，超限 → budget_wait 跳过）
 *   4. 移动目录到 skills/.archive/<name>/（目标已存在则加时间戳后缀，绝不覆盖）
 *   5. 更新 skill_states（状态 + archivedAt + archiveReason + stateHistory）
 *   6. 写 curation_actions + audit_log + 发事件
 *
 * 失败处理（§9.2）：
 *   - 移动失败 → 不落状态，记 failed，不影响其他技能
 *   - 状态落盘失败 → 目录移回原位（回滚），记 failed
 */

import { rename, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { packSkillState, packCurationAction, isoWeek } from './storage.js';
import { MANAGED_SOURCES } from './schema.js';

/**
 * @param {Object} deps
 * @param {(name:string)=>Promise<Object>} deps.getTable
 * @param {(entry:Object)=>Promise<Object>} deps.audit
 * @param {(topic:string, payload:Object)=>Promise<boolean>} deps.publishEvent
 * @param {()=>Object} deps.effectiveConfig
 */
export function createExecutor({ getTable, audit, publishEvent, effectiveConfig }) {
  const nowIso = () => new Date().toISOString();

  async function findSkill(skillName) {
    const t = await getTable('skill_states');
    const hit = t.entries().find(([, v]) => v.skillName === skillName);
    return hit ? { key: hit[0], value: hit[1], table: t } : null;
  }

  async function putSkill(existing, business) {
    const t = await getTable('skill_states');
    const packed = packSkillState(business, existing);
    await t.put(packed.id, packed);
    return packed;
  }

  async function recordAction(entry) {
    const t = await getTable('curation_actions');
    const packed = packCurationAction({
      timestamp: nowIso(),
      actor: entry.actor ?? 'system',
      action: entry.action,
      skillName: entry.skillName ?? '*',
      details: entry.details ?? {},
      result: entry.result ?? 'success',
      errorMessage: entry.errorMessage ?? null,
    });
    await t.put(packed.id, packed);
    return packed;
  }

  /** 本周（ISO 周）已成功归档数 —— 预算计数（P0-2 §9.1 L2） */
  async function archivedThisWeek() {
    const week = isoWeek();
    const t = await getTable('curation_actions');
    let n = 0;
    for (const [, v] of t.entries()) {
      if (v.action !== 'archive' || v.result !== 'success') continue;
      if (v.details?.dryRun === true) continue;
      if (isoWeek(new Date(v.timestamp)) === week) n++;
    }
    return n;
  }

  /** 目录是否存在（不存在时归档退化为「仅落状态」，不报错） */
  async function exists(p) {
    try { await stat(p); return true; } catch { return false; }
  }

  async function moveToArchive(skill, cfg) {
    const src = join(cfg.skills_dir, skill.dirName ?? skill.skillName);
    if (!(await exists(src))) return { moved: false, path: null, reason: 'skill directory not found' };
    const archiveRoot = join(cfg.skills_dir, cfg.archive_dir_name);
    await mkdir(archiveRoot, { recursive: true });
    let target = join(archiveRoot, skill.dirName ?? skill.skillName);
    if (await exists(target)) target = `${target}-${Date.now()}`;
    await rename(src, target);
    return { moved: true, path: target, reason: null };
  }

  async function moveBackFromArchive(skill, cfg) {
    const archiveRoot = join(cfg.skills_dir, cfg.archive_dir_name);
    const src = join(archiveRoot, skill.dirName ?? skill.skillName);
    if (!(await exists(src))) return { moved: false, path: null, reason: 'archived directory not found' };
    const target = join(cfg.skills_dir, skill.dirName ?? skill.skillName);
    if (await exists(target)) return { moved: false, path: null, reason: 'target directory already exists' };
    await rename(src, target);
    return { moved: true, path: target, reason: null };
  }

  /** 统一的保护校验：返回 null 表示放行，否则返回 { code, reason } */
  function guard(skill, cfg, { allowPinned = false } = {}) {
    if (!skill) return { code: 'not_found', reason: '技能不存在' };
    if (!allowPinned && skill.state === 'pinned') {
      return { code: 'pinned', reason: 'pinned：人工固定，不参与自动转换（先 unpin）' };
    }
    if (skill.protected === true) {
      return { code: 'protected', reason: 'protected：受保护内置技能，不参与策展' };
    }
    if (!MANAGED_SOURCES.includes(skill.source ?? 'manual')) {
      return { code: 'unmanaged_source', reason: `source=${skill.source}：非 AGINT 管理的技能` };
    }
    if (skill.cronReferenced === true && cfg.cron_referenced_protection !== false) {
      return { code: 'cron_referenced', reason: 'cron-referenced：被 cron job 引用，不自动归档' };
    }
    return null;
  }

  // ── archive（自动/人工共用）────────────────────────────────────────────
  /**
   * @param {Object} args { skillName, reason, actor, dryRun, trigger, allowPinned }
   * @returns {Promise<{result:'success'|'skipped'|'failed', reason:string, skill?:Object}>}
   */
  async function archive(args) {
    const cfg = effectiveConfig();
    const found = await findSkill(args.skillName);
    const skill = found?.value;

    if (!skill) {
      await recordAction({ action: 'archive', skillName: args.skillName, result: 'failed', errorMessage: '技能不存在', details: { trigger: args.trigger ?? 'manual' } });
      return { result: 'failed', reason: '技能不存在' };
    }
    if (skill.state === 'archived') {
      // 幂等（§9.1）：已归档再归档直接跳过，不产生副作用
      await recordAction({ action: 'archive', skillName: args.skillName, result: 'skipped', details: { reason: 'already archived', trigger: args.trigger ?? 'manual' } });
      return { result: 'skipped', reason: '已归档（幂等跳过）', skill };
    }

    const blocked = guard(skill, cfg, { allowPinned: args.allowPinned === true });
    if (blocked) {
      await recordAction({ action: 'archive', skillName: args.skillName, result: 'skipped', details: { reason: blocked.reason, trigger: args.trigger ?? 'manual' } });
      return { result: 'skipped', reason: blocked.reason, skill };
    }

    const budget = cfg.weekly_archive_budget ?? 10;
    const used = await archivedThisWeek();
    if (used >= budget) {
      await recordAction({ action: 'archive', skillName: args.skillName, result: 'skipped', details: { reason: `本周归档预算已用尽 ${used}/${budget}（budget_wait，下周重试）`, trigger: args.trigger ?? 'manual' } });
      return { result: 'skipped', reason: `本周归档预算已用尽 ${used}/${budget}（budget_wait，下周重试）`, skill };
    }

    const dryRun = args.dryRun === true;
    const ts = nowIso();
    const historyEntry = { from: skill.state, to: 'archived', at: ts, reason: args.reason ?? 'manual archive', actor: args.actor ?? 'system' };

    // dry-run：算出「将会变成什么样」就返回，**不落任何表、不移动目录**
    // （验收标准：dry_run 输出与真实执行完全一致，除不落盘外）
    if (dryRun) {
      return {
        result: 'success',
        reason: args.reason ?? 'manual archive',
        dryRun: true,
        skill: { ...skill, state: 'archived', stateChangedAt: ts, archivedAt: ts, archiveReason: args.reason ?? 'manual archive', stateHistory: [...(skill.stateHistory ?? []), historyEntry] },
        movedTo: null,
      };
    }

    let moved = { moved: false, path: null, reason: 'move disabled' };
    if (cfg.move_directory_on_archive !== false) {
      try {
        moved = await moveToArchive(skill, cfg);
      } catch (e) {
        await recordAction({ action: 'archive', skillName: args.skillName, result: 'failed', errorMessage: `目录移动失败：${e?.message ?? e}`, details: { trigger: args.trigger ?? 'manual' } });
        await audit({ actor: args.actor ?? 'system', action: 'archive_failed', targetType: 'skill_state', targetId: skill.id, reason: String(e?.message ?? e) });
        return { result: 'failed', reason: `目录移动失败：${e?.message ?? e}`, skill };
      }
    }

    try {
      const updated = await putSkill(skill, {
        ...skill,
        state: 'archived',
        stateChangedAt: ts,
        stateHistory: [...(skill.stateHistory ?? []), historyEntry],
        archivedAt: ts,
        archiveReason: args.reason ?? 'manual archive',
        updatedAt: ts,
      });
      await recordAction({
        action: 'archive', skillName: args.skillName, actor: args.actor ?? 'system',
        details: { fromState: skill.state, toState: 'archived', reason: args.reason ?? 'manual archive', trigger: args.trigger ?? 'manual', dryRun, movedTo: moved.path },
      });
      await audit({
        actor: args.actor ?? 'system', action: 'archived', targetType: 'skill_state', targetId: updated.id,
        details: { movedTo: moved.path, dryRun }, reason: args.reason ?? 'manual archive',
      });
      if (!dryRun) {
        await publishEvent('curator.skill-archived', {
          skillName: args.skillName, reason: args.reason ?? 'manual archive', archivedAt: ts, movedTo: moved.path,
        });
      }
      return { result: 'success', reason: args.reason ?? 'manual archive', skill: updated, movedTo: moved.path };
    } catch (e) {
      // 回滚：状态没落成功，把已移动的目录移回原位
      if (moved.moved) {
        try { await moveBackFromArchive(skill, cfg); } catch { /* 回滚失败也要留痕 */ }
      }
      await recordAction({ action: 'archive', skillName: args.skillName, result: 'failed', errorMessage: String(e?.message ?? e), details: { trigger: args.trigger ?? 'manual' } });
      return { result: 'failed', reason: String(e?.message ?? e), skill };
    }
  }

  // ── unarchive（§9.1 L3：需人工确认，工具侧标注 ask）────────────────────
  async function unarchive(args) {
    const cfg = effectiveConfig();
    const found = await findSkill(args.skillName);
    const skill = found?.value;
    if (!skill) return { result: 'failed', reason: '技能不存在' };
    if (skill.state !== 'archived') {
      await recordAction({ action: 'unarchive', skillName: args.skillName, result: 'skipped', details: { reason: `当前状态 ${skill.state}，无需恢复` } });
      return { result: 'skipped', reason: `当前状态 ${skill.state}，无需恢复（幂等跳过）`, skill };
    }

    const dryRun = args.dryRun === true;
    let moved = { moved: false, path: null, reason: dryRun ? 'dry-run' : 'move disabled' };
    if (!dryRun && cfg.move_directory_on_archive !== false) {
      moved = await moveBackFromArchive(skill, cfg);
    }

    const ts = nowIso();
    const updated = await putSkill(skill, {
      ...skill,
      state: 'active',
      stateChangedAt: ts,
      stateHistory: [...(skill.stateHistory ?? []), { from: 'archived', to: 'active', at: ts, reason: args.reason ?? 'manual unarchive', actor: args.actor ?? 'human' }],
      archivedAt: null,
      archiveReason: null,
      updatedAt: ts,
    });
    await recordAction({
      action: 'unarchive', skillName: args.skillName, actor: args.actor ?? 'human',
      details: { fromState: 'archived', toState: 'active', reason: args.reason ?? 'manual unarchive', trigger: args.trigger ?? 'manual', dryRun, movedTo: moved.path },
    });
    await audit({ actor: args.actor ?? 'human', action: 'unarchived', targetType: 'skill_state', targetId: updated.id, details: { movedTo: moved.path } });
    if (!dryRun) {
      await publishEvent('curator.skill-reactivated', { skillName: args.skillName, reactivatedAt: ts, reason: args.reason ?? 'manual unarchive' });
    }
    return { result: 'success', reason: args.reason ?? 'manual unarchive', skill: updated, movedTo: moved.path };
  }

  // ── pin / unpin ────────────────────────────────────────────────────────
  async function pin(args) {
    const found = await findSkill(args.skillName);
    const skill = found?.value;
    if (!skill) return { result: 'failed', reason: '技能不存在' };
    if (skill.state === 'pinned') {
      await recordAction({ action: 'pin', skillName: args.skillName, result: 'skipped', details: { reason: 'already pinned' } });
      return { result: 'skipped', reason: '已 pinned（幂等跳过）', skill };
    }
    const ts = nowIso();
    const updated = await putSkill(skill, {
      ...skill,
      state: 'pinned',
      stateChangedAt: ts,
      stateHistory: [...(skill.stateHistory ?? []), { from: skill.state, to: 'pinned', at: ts, reason: args.reason ?? 'manual pin', actor: args.actor ?? 'human' }],
      updatedAt: ts,
    });
    await recordAction({ action: 'pin', skillName: args.skillName, actor: args.actor ?? 'human', details: { fromState: skill.state, toState: 'pinned', reason: args.reason ?? 'manual pin' } });
    await audit({ actor: args.actor ?? 'human', action: 'pinned', targetType: 'skill_state', targetId: updated.id, reason: args.reason ?? 'manual pin' });
    await publishEvent('curator.skill-pinned', { skillName: args.skillName, actor: args.actor ?? 'human' });
    return { result: 'success', reason: args.reason ?? 'manual pin', skill: updated };
  }

  async function unpin(args) {
    const found = await findSkill(args.skillName);
    const skill = found?.value;
    if (!skill) return { result: 'failed', reason: '技能不存在' };
    if (skill.state !== 'pinned') {
      await recordAction({ action: 'unpin', skillName: args.skillName, result: 'skipped', details: { reason: `当前状态 ${skill.state}，无需 unpin` } });
      return { result: 'skipped', reason: `当前状态 ${skill.state}，无需 unpin（幂等跳过）`, skill };
    }
    const ts = nowIso();
    const updated = await putSkill(skill, {
      ...skill,
      state: 'active',
      stateChangedAt: ts,
      stateHistory: [...(skill.stateHistory ?? []), { from: 'pinned', to: 'active', at: ts, reason: args.reason ?? 'manual unpin', actor: args.actor ?? 'human' }],
      updatedAt: ts,
    });
    await recordAction({ action: 'unpin', skillName: args.skillName, actor: args.actor ?? 'human', details: { fromState: 'pinned', toState: 'active', reason: args.reason ?? 'manual unpin' } });
    await audit({ actor: args.actor ?? 'human', action: 'unpinned', targetType: 'skill_state', targetId: updated.id });
    return { result: 'success', reason: args.reason ?? 'manual unpin', skill: updated };
  }

  /**
   * 应用 state-engine 的决策（run/dryRun 共用同一条路径 —— 验收标准：
   * dry_run 输出与真实执行完全一致，除不落盘外）。
   */
  async function applyDecisions(decisions, { dryRun = false, trigger = 'weekly_curation', actor = 'system' } = {}) {
    const cfg = effectiveConfig();
    const out = { staled: [], archived: [], reactivated: [], skipped: [] };
    for (const d of decisions) {
      if (d.action === 'keep') { out.skipped.push({ skillName: d.skillName, reason: d.reason }); continue; }
      if (d.action === 'stale') {
        const found = await findSkill(d.skillName);
        if (!found) { out.skipped.push({ skillName: d.skillName, reason: '技能不存在' }); continue; }
        const ts = nowIso();
        if (!dryRun) {
          const updated = await putSkill(found.value, {
            ...found.value,
            state: 'stale',
            stateChangedAt: ts,
            stateHistory: [...(found.value.stateHistory ?? []), { from: d.from, to: 'stale', at: ts, reason: d.reason, actor }],
            updatedAt: ts,
          });
          await recordAction({ action: 'state_change', skillName: d.skillName, actor, details: { fromState: d.from, toState: 'stale', reason: d.reason, trigger, dryRun } });
          await audit({ actor, action: 'staled', targetType: 'skill_state', targetId: updated.id, reason: d.reason });
          await publishEvent('curator.skill-staled', { skillName: d.skillName, reason: d.reason, lastUsedAt: found.value.usage?.lastUsedAt ?? null });
        }
        out.staled.push({ skillName: d.skillName, reason: d.reason, daysSinceUse: Math.floor(d.daysSinceUse) });
        continue;
      }
      if (d.action === 'archive') {
        const r = await archive({ skillName: d.skillName, reason: d.reason, actor, dryRun, trigger });
        if (r.result === 'success') out.archived.push({ skillName: d.skillName, reason: d.reason, lastUsedAt: r.skill?.usage?.lastUsedAt ?? null });
        else out.skipped.push({ skillName: d.skillName, reason: r.reason });
        continue;
      }
      if (d.action === 'reactivate') {
        const found = await findSkill(d.skillName);
        if (!found) { out.skipped.push({ skillName: d.skillName, reason: '技能不存在' }); continue; }
        const ts = nowIso();
        if (!dryRun) {
          const updated = await putSkill(found.value, {
            ...found.value,
            state: 'active',
            stateChangedAt: ts,
            stateHistory: [...(found.value.stateHistory ?? []), { from: 'stale', to: 'active', at: ts, reason: d.reason, actor }],
            updatedAt: ts,
          });
          await recordAction({ action: 'state_change', skillName: d.skillName, actor, details: { fromState: 'stale', toState: 'active', reason: d.reason, trigger, dryRun } });
          await audit({ actor, action: 'reactivated', targetType: 'skill_state', targetId: updated.id, reason: d.reason });
          await publishEvent('curator.skill-reactivated', { skillName: d.skillName, reactivatedAt: ts, reason: d.reason });
        }
        out.reactivated.push({ skillName: d.skillName, reason: d.reason });
      }
    }
    void cfg;
    return out;
  }

  return { findSkill, putSkill, recordAction, archivedThisWeek, archive, unarchive, pin, unpin, applyDecisions };
}
