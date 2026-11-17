/**
 * agint-evolution-driver/lib/proposal-transaction.js —— 提案级全组事务（2026-11-07）。
 *
 * ## 一句话口径
 *
 * **先全部构造、全部在内存里验证，再一次性写盘；任一环节失败，一个字节都不落。**
 *
 * ## 为什么单独一个文件（老板 2026-11-07 要求「科学合理」）
 *
 * v0.10.0 把执行单元改成提案，但用的是「逐个文件写、失败即停」：前面的文件已经
 * 落盘，后面的失败就留下半成品。而一条提案里的多个文件常常互相依赖（A import
 * 了 B 新导出的符号、或者要新建一个共用模块），单独落地任何一个都是坏状态。
 *
 * 本文件把「事务编排」与「IO」彻底分开：
 *
 *   · 所有决策（构造 / 验证 / 闸门 / 是否放行）都在**不写盘**的阶段做完；
 *   · 只有最后一步写盘；写盘中途失败则整组回滚；
 *   · 所有 IO 由调用方以 hooks 注入 ⇒ 本文件可脱离宿主做完整单测。
 *
 * ## 阶段（顺序不许改）
 *
 *   ① construct  逐单元生成编辑（含「新建文件」的内容），失败即整体放弃
 *   ② postimage  在内存里算出每个文件的最终文本，查 oldText 唯一性
 *   ③ verify     在内存里做语法/结构验证（不碰工作区）
 *   ④ gate       mutator.validate + policy.decide，任一拒绝即整体放弃
 *   ⑤ write      一次性写全部文件；中途失败 ⇒ restoreMany 整组回滚
 *   ⑥ record     逐文件发事件 / 记账
 *
 * ⛔ ①②③④ 期间**绝不调用 write**。这是本文件存在的全部理由。
 * ⛔ 本文件不读 env、不拿 Date.now()、不碰 fs —— 时间/路径/IO 全在 hooks 里。
 */

/** 把任意 threw 变成一行原因，不吞类型信息。 */
const errText = (e) => String(e?.message ?? e ?? 'unknown').replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * 在内存里算最终文本。
 * 编辑：oldText 必须恰好出现一次（提交前最后一道幻觉闸）。
 * 新建：content 必须非空。
 */
export function computePostimage(unit, edit) {
  const kind = unit?.kind === 'create' ? 'create' : 'edit';
  if (kind === 'create') {
    const content = String(edit?.content ?? '');
    if (!content.trim()) return { ok: false, reason: 'new file content is empty' };
    return { ok: true, postimage: content, kind };
  }
  const text = String(unit?.text ?? '');
  const oldText = String(edit?.oldText ?? '');
  const newText = String(edit?.newText ?? '');
  if (!oldText.trim()) return { ok: false, reason: 'oldText is empty' };
  const count = text.split(oldText).length - 1;
  if (count !== 1) return { ok: false, reason: `oldText occurs ${count} times (need exactly 1)` };
  if (oldText === newText) return { ok: false, reason: 'empty or no-op edit' };
  return { ok: true, postimage: text.replace(oldText, newText), kind };
}

/**
 * 跑一次提案级事务。
 *
 * @param {object} opts
 * @param {Array<{id:string, kind?:'edit'|'create', text?:string, type?:string}>} opts.units
 * @param {object} opts.hooks 全部 IO（见下）
 * @returns {Promise<object>} { ok, phase, reason, commits, skipped, edits, results }
 */
export async function executeProposalTransaction({ units = [], hooks = {} } = {}) {
  const list = (Array.isArray(units) ? units : []).filter(Boolean);
  const results = [];
  const fail = (phase, reason, extra = {}) => ({
    ok: false, phase, reason, commits: [], skipped: results.filter((r) => r.applicable === false).map((r) => r.id),
    edits: results, ...extra,
  });

  if (list.length === 0) return fail('units', 'no target unit resolved');

  const required = ['construct', 'verify', 'decide', 'validate', 'write', 'restoreMany'];
  const missing = required.filter((k) => typeof hooks[k] !== 'function');
  if (missing.length) return fail('hooks', `missing hooks: ${missing.join(', ')}`);

  // ── ① 构造：全部在内存里，一个文件都不写 ─────────────────────────────
  for (let i = 0; i < list.length; i += 1) {
    const unit = list[i];
    let built;
    try {
      built = await hooks.construct({ unit, index: i, total: list.length });
    } catch (e) {
      return fail('construct', `construct threw: ${errText(e)}`);
    }
    if (built?.llmFailure) return fail('construct', `llm unavailable: ${errText(built.reason)}`);
    if (built?.applicable === false) {
      results.push({ id: unit.id, applicable: false, rationale: built.rationale ?? '' });
      continue;                       // 模型明确说「这个文件不用改」，不算失败
    }
    if (!built || built.ok === false) {
      return fail('construct', `${unit.id}: ${errText(built?.reason ?? 'construct failed')}`);
    }
    const post = computePostimage(unit, built.edit ?? built);
    if (post.ok !== true) return fail('construct', `${unit.id}: ${post.reason}`);
    results.push({
      id: unit.id,
      unit,
      kind: post.kind,
      applicable: true,
      edit: built.edit ?? built,
      postimage: post.postimage,
      rationale: built.rationale ?? built.edit?.rationale ?? '',
    });
  }

  const applicable = results.filter((r) => r.applicable === true);
  if (applicable.length === 0) {
    return fail('construct', 'no unit produced an applicable edit');
  }

  // ── ②+③ 内存验证：语法 / 结构 ────────────────────────────────────────
  for (const r of applicable) {
    let v;
    try {
      v = await hooks.verify({ unit: r.unit, postimage: r.postimage, kind: r.kind });
    } catch (e) {
      v = { ok: false, reason: `verify threw: ${errText(e)}` };
    }
    if (v?.ok !== true) return fail('verify', `${r.id}: ${errText(v?.reason ?? 'verify failed')}`);
    r.verify = v;
  }

  // ── ④ 闸门：mutator.validate + policy（全部通过才写）────────────────────
  for (const r of applicable) {
    let proposal = null;
    if (typeof hooks.propose === 'function') {
      try {
        proposal = await hooks.propose({ unit: r.unit, edit: r.edit, postimage: r.postimage, kind: r.kind });
      } catch (e) {
        return fail('gate', `${r.id}: propose threw: ${errText(e)}`);
      }
      r.proposal = proposal;
      let verdict;
      try {
        verdict = await hooks.validate({ proposal });
      } catch (e) {
        verdict = { ok: false, findings: [errText(e)] };
      }
      if (verdict && verdict.ok === false) {
        return fail('gate', `${r.id}: validate rejected — ${(verdict.findings ?? []).slice(0, 2).join(' | ')}`);
      }
    }
    let decision;
    try {
      decision = await hooks.decide({ unit: r.unit, verify: r.verify, proposal, kind: r.kind });
    } catch (e) {
      return fail('gate', `${r.id}: policy threw: ${errText(e)}`);
    }
    const kind = typeof decision === 'string' ? decision : (decision?.kind ?? 'ABSTAIN');
    if (kind === 'REJECT' || kind === 'ABSTAIN' || kind === undefined) {
      return fail('gate', `${r.id}: policy=${kind}${decision?.reason ? ` (${errText(decision.reason)})` : ''}`);
    }
    r.policyDecision = kind;
  }

  // ── ⑤ 一次性写盘 ─────────────────────────────────────────────────────
  const written = [];
  for (const r of applicable) {
    let w;
    try {
      w = await hooks.write({ unit: r.unit, edit: r.edit, postimage: r.postimage, kind: r.kind });
    } catch (e) {
      w = { ok: false, reason: `write threw: ${errText(e)}` };
    }
    if (w?.ok !== true) {
      // ⛔ 整组回滚：不留下「前两个文件已改、第三个没改」的坏状态。
      let restored = { ok: false, reason: '' };
      try {
        restored = await hooks.restoreMany(written);
      } catch (e) {
        restored = { ok: false, reason: `restore threw: ${errText(e)}` };
      }
      return fail('write', `${r.id}: ${errText(w?.reason ?? 'write failed')}`, {
        reverted: restored?.ok === true,
        restoreReason: restored?.reason ?? '',
        attempted: written.length,
      });
    }
    written.push({ ...w, id: r.id, kind: r.kind, policyDecision: r.policyDecision, proposal: r.proposal });
    r.commit = w;
  }

  // ── ⑥ 记账（记账失败不回滚：改动已过全部闸门，账目问题不是安全问题）────
  if (typeof hooks.record === 'function') {
    try {
      await hooks.record(written);
    } catch (e) {
      return {
        ok: true, phase: 'record', reason: `record failed: ${errText(e)}`,
        commits: written, skipped: results.filter((r) => r.applicable === false).map((r) => r.id),
        edits: results, recordFailed: true,
      };
    }
  }

  return {
    ok: true,
    phase: 'done',
    commits: written,
    skipped: results.filter((r) => r.applicable === false).map((r) => r.id),
    edits: results,
  };
}
