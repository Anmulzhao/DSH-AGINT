/**
 * agint-abtest lib/observe.js v0.7.0 — A/B 观察编排（方案 v2.1 §九）
 *
 * cron observe job 的实体。职责：候选对检测 → 语料 gating → 开实验 →
 * 隔离执行 + 三层打分 → 幂等注入 → report 恰一次。
 *
 * 纪律（方案 §九.4）：
 *   - report 只调一次（以 status 判断，终态不重跑）。
 *   - 样本注入幂等（确定性 id），续跑先 listSamples 去重，不重复花 LLM 额度。
 *   - 24h 未齐 → abort，不新开。
 *   - 预算帽 llmBudget（默认 60）：executor/judge 的 attempted 调用计数，超限 skip。
 *   - 任何失败 → skippedSamples + reason，不伪造分数。
 *
 * 执行模型（核实报告 §二.1）：变体是文件内容突变。文档类 → 子会话以变体文本
 * 为依据答题；代码类 → 原位物化（备份→替换→运行→还原）跑脚本/测试。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { scoreExec, judgeArtifact } from './scoring.js';
import { resolveLlmSelection, DEFAULT_TIMEOUT_MS } from '../../agint-skill-autocreate/lib/llm-verdict.js';

const ELIGIBLE_STAGES = new Set(['PENDING_REVIEW', 'NEW']);

// ── 语料 ───────────────────────────────────────────────────────────────

export function loadCorpus(tasksDir, promptId) {
  const p = resolve(tasksDir, `${promptId}.json`);
  if (!existsSync(p)) return null;
  try {
    const corpus = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(corpus.tasks) || corpus.tasks.length < 10) return null;
    return corpus;
  } catch {
    return null;
  }
}

/** 候选对：同 promptId 取最新 created_at 且有语料的变体（方案 §九.1）。 */
export function pickCandidate(variants, tasksDir) {
  const eligible = (variants ?? []).filter((v) =>
    ELIGIBLE_STAGES.has(v.stage)
    && v.mutation_kind === 'PROMPT_MUTATION'
    && v.payload?.promptId && v.payload?.oldText && v.payload?.newText);
  if (eligible.length === 0) return { candidate: null, reason: 'no-candidate-pair' };
  const byPrompt = new Map();
  for (const v of eligible) {
    const list = byPrompt.get(v.payload.promptId) ?? [];
    list.push(v);
    byPrompt.set(v.payload.promptId, list);
  }
  for (const [promptId, list] of byPrompt) {
    list.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const corpus = loadCorpus(tasksDir, promptId);
    if (corpus) return { candidate: { variant: list[0], corpus }, reason: null };
  }
  return { candidate: null, reason: 'no-task-corpus' };
}

// ── 默认执行器（子会话结构化答题，K114：meta.agentPreset 必传）─────────

function executorSchema(answerShape) {
  if (answerShape === 'steps') {
    return { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] };
  }
  if (answerShape === 'conclusion') {
    return { type: 'object', properties: { conclusion: { type: 'string' } }, required: ['conclusion'] };
  }
  return { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
}

async function defaultExecutor({ ctx, task, variantText, assetKind, preset, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const failed = (reason, attempted = false) => ({ ok: false, reason, attempted });
  if (!ctx || typeof ctx.get !== 'function') return failed('ctx unavailable');
  const agents = ctx.get('agents');
  const subagents = ctx.get('subagents');
  if (!agents?.create || !subagents) return failed('agents/subagents unavailable');
  const hasActivation = typeof subagents.startActivation === 'function';
  if (!hasActivation && typeof subagents.start !== 'function') return failed('subagents method missing');

  const selection = resolveLlmSelection(ctx, {});
  const agentOptions = { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
  const abortController = new AbortController();
  let rejectOnTimeout = null;
  const timeoutGuard = new Promise((_, reject) => { rejectOnTimeout = reject; });
  const timer = setTimeout(() => {
    abortController.abort('abtest-executor-timeout');
    rejectOnTimeout?.(new Error(`executor timeout ${timeoutMs}ms`));
  }, timeoutMs);
  let handle = null, activation = null, spawned = false, cancelled = false;
  const disposeLate = (r) => { try { Promise.resolve(r?.dispose?.()).catch(() => {}); } catch { /* ignore */ } };
  try {
    const shape = task.answerShape ?? 'text';
    const promptText = [
      assetKind === 'code' ? '以下是一份代码/脚本工件。阅读它并完成任务。' : '以下是一份文档工件。以它为依据完成任务。',
      '<<<ARTIFACT', String(variantText ?? ''), 'ARTIFACT>>>',
      '', `任务：${task.description}`,
      shape === 'steps' ? '输出 steps：字符串数组，每行一条。' : shape === 'conclusion' ? '输出 conclusion：只含要求的短答案。' : '输出 text：完整分析。',
    ].join('\n');
    handle = await Promise.race([
      agents.create({
        sessionId: `abtest-exec-${randomUUID()}`,
        meta: { cwd: process.cwd(), agentPreset: preset },
        agentOptions,
        signal: abortController.signal,
      }).then((h) => { if (cancelled) disposeLate(h); return h; }),
      timeoutGuard,
    ]);
    const spec = {
      provider: 'spawn',
      label: `agint-abtest executor ${task.id}`,
      parent: handle.agent,
      prompt: [{ type: 'text', text: promptText }],
      agentPreset: preset,
      agentOptions,
      outputSchema: executorSchema(shape),
      signal: abortController.signal,
      ...(hasActivation ? { delivery: 'caller' } : {}),
    };
    activation = await Promise.race([
      (hasActivation
        ? Promise.resolve().then(() => subagents.startActivation(spec))
        : Promise.resolve().then(() => subagents.start('spawn', spec))
      ).then((a) => { if (cancelled) disposeLate(a); return a; }),
      timeoutGuard,
    ]);
    spawned = true;
    const result = await Promise.race([activation.result, timeoutGuard]);
    if (result?.stopReason !== 'completed') return failed(`stopReason=${result?.stopReason}`, true);
    const s = result.structured ?? {};
    if (shape === 'steps') {
      if (!Array.isArray(s.steps) || !s.steps.every((x) => typeof x === 'string')) return failed('steps 非法', true);
      return { ok: true, attempted: true, steps: s.steps };
    }
    if (shape === 'conclusion') {
      if (typeof s.conclusion !== 'string') return failed('conclusion 非法', true);
      return { ok: true, attempted: true, conclusion: s.conclusion.trim() };
    }
    if (typeof s.text !== 'string') return failed('text 非法', true);
    return { ok: true, attempted: true, text: s.text };
  } catch (err) {
    return failed(`executor error: ${err?.message ?? String(err)}`, spawned);
  } finally {
    cancelled = true;
    if (activation?.dispose) { try { await activation.dispose(); } catch { /* settled */ } }
    if (handle?.dispose) { try { await handle.dispose(); } catch { /* settled */ } }
    clearTimeout(timer);
  }
}

// ── 默认脚本运行器（原位物化：备份→替换→运行→还原）─────────────────────

function runChild(cmd, args, cwd, timeoutMs = 120_000) {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout ?? ''}\n${stderr ?? ''}` });
    });
  });
}

async function defaultScriptRunner({ repoRoot, assetPath, oldText, newText, args = [], type }) {
  const abs = resolve(repoRoot, assetPath);
  if (!existsSync(abs)) return { ok: false, reason: `asset 不存在: ${assetPath}` };
  const original = readFileSync(abs, 'utf8');
  if (!original.includes(oldText)) return { ok: false, reason: 'oldText 不在当前文件（物化失败）' };
  // 函数替换避免 newText 里 $& 等被当替换模式
  const variantContent = original.replace(oldText, () => newText);
  const backup = `${abs}.abtest-bak`;
  writeFileSync(backup, original, 'utf8');
  writeFileSync(abs, variantContent, 'utf8');
  try {
    const evidence = type === 'run-tests-inplace'
      ? await runChild(process.execPath, ['--test', abs, ...args], repoRoot)
      : await runChild('bash', [abs, ...args], repoRoot);
    return { ok: true, ...evidence };
  } finally {
    // 还原是硬要求：无论运行成败，原文件必须回去
    writeFileSync(abs, original, 'utf8');
    try { unlinkSync(backup); } catch { /* 已还原即可 */ }
  }
}

// ── 主编排 ─────────────────────────────────────────────────────────────

export async function runObserve({
  abtest, population, publish, ctx,
  tasksDir, repoRoot,
  executor, judge, scriptRunner,
  executorPreset = 'agint', judgePreset = 'agint-zgs',
  llmBudget = 60, staleMs = 24 * 3600 * 1000, now = Date.now(),
}) {
  const emit = async (payload) => {
    if (typeof publish !== 'function') return;
    try { await publish({ topic: 'abtest.observe', version: 1, source: 'agint-abtest', payload }); } catch { /* best-effort */ }
  };
  const skip = async (reason) => { await emit({ skipped: true, reason }); return { skipped: true, reason }; };

  if (!abtest?.start || !abtest?._internal?.putSample) return skip('abtest not mounted');

  // 1. 生命周期：running 实验 → 续跑或超时 abort
  const { tests } = await abtest.listTests();
  const running = tests.filter((t) => t.status === 'running');
  let testId = null, corpus = null, variantTexts = null;
  if (running.length > 0) {
    const t = running[0];
    if (now - Date.parse(t.createdAt) > staleMs) {
      await abtest._internal.abort({ testId: t.testId, reason: 'stale-24h' });
      await emit({ aborted: t.testId, reason: 'stale-24h' });
      return { aborted: t.testId };
    }
    const promptId = t.variantA?.promptId;
    corpus = loadCorpus(tasksDir, promptId);
    if (!corpus) return skip(`corpus missing on resume: ${promptId}`);
    if (!population?.stats) return skip('population not mounted on resume');
    const { variants } = await population.stats();
    const v = (variants ?? []).find((x) => x.variant_id === t.variantB?.version);
    if (!v?.payload?.oldText || !v?.payload?.newText) return skip('variant payload missing on resume');
    testId = t.testId;
    variantTexts = { A: v.payload.oldText, B: v.payload.newText };
  } else {
    // 2. 候选对 + 语料 gating
    if (!population?.stats) return skip('population not mounted');
    const { variants } = await population.stats();
    const { candidate, reason } = pickCandidate(variants, tasksDir);
    if (!candidate) return skip(reason);
    const { variant: v, corpus: c } = candidate;
    corpus = c;
    const started = await abtest.start({
      variantA: { promptId: v.payload.promptId, version: `old@${v.variant_id}` },
      variantB: { promptId: v.payload.promptId, version: v.variant_id },
      taskSuite: corpus.tasks.map((t) => t.id),
    });
    testId = started.testId;
    variantTexts = { A: v.payload.oldText, B: v.payload.newText };
  }

  // 3. 逐任务逐变体执行 + 打分 + 幂等注入
  const exec = executor ?? ((args) => defaultExecutor({ ctx, preset: executorPreset, ...args }));
  const judg = judge ?? ((args) => judgeArtifact({ ctx, agentPreset: judgePreset, ...args }));
  const runScript = scriptRunner ?? defaultScriptRunner;
  const { samples: existing } = await abtest._internal.listSamples({ testId });
  const done = new Set(existing.map((s) => `${s.taskId}:${s.variant}`));
  let llmCalls = 0, injected = 0, budgetCapped = false;
  const skippedSamples = [];

  for (const task of corpus.tasks) {
    for (const variant of ['A', 'B']) {
      if (done.has(`${task.id}:${variant}`)) { injected++; continue; }
      const variantText = variantTexts[variant];
      const requiredCalls = task.layer === 'L1-exec' ? 0 : (task.answerShape === 'text' ? 2 : 1);
      if (llmCalls + requiredCalls > llmBudget) {
        budgetCapped = true;
        skippedSamples.push({ taskId: task.id, variant, reason: 'budget-capped' });
        continue;
      }
      let scored = null;
      try {
        if (task.layer === 'L1-exec') {
          const r = await runScript({
            repoRoot, assetPath: corpus.assetPath,
            oldText: variantTexts.A,
            // A 侧用 oldText 替换自身 ⇒ 原样运行；B 侧才是突变体
            newText: variant === 'A' ? variantTexts.A : variantTexts.B,
            args: task.runner?.args ?? [], type: task.runner?.type,
          });
          if (r.ok === false) {
            skippedSamples.push({ taskId: task.id, variant, reason: r.reason });
            continue;
          }
          scored = scoreExec({ verifySpec: task.verifySpec, evidence: { exitCode: r.exitCode, output: r.output } });
        } else {
          const er = await exec({ task, variantText, assetKind: corpus.artifactKind });
          if (er.attempted) llmCalls++;
          if (!er.ok) {
            skippedSamples.push({ taskId: task.id, variant, reason: er.reason ?? 'executor failed' });
            continue;
          }
          if (task.answerShape === 'text') {
            const jr = await judg({ artifactText: er.text, rubric: corpus.rubric });
            if (jr.attempted) llmCalls++;
            if (!jr.ok) {
              skippedSamples.push({ taskId: task.id, variant, reason: jr.reason ?? 'judge failed' });
              continue;
            }
            scored = { ok: true, score: jr.score };
          } else {
            const evidence = task.answerShape === 'steps' ? { steps: er.steps } : { conclusion: er.conclusion };
            scored = scoreExec({ verifySpec: task.verifySpec, evidence });
          }
        }
      } catch (err) {
        skippedSamples.push({ taskId: task.id, variant, reason: `error: ${err?.message ?? String(err)}` });
        continue;
      }
      if (!scored?.ok) {
        skippedSamples.push({ taskId: task.id, variant, reason: scored?.reason ?? 'no score' });
        continue;
      }
      await abtest._internal.putSample({ testId, variant, taskId: task.id, score: scored.score });
      injected++;
    }
  }

  // 4. report 恰一次（running → 终态；续跑进来时也是 running）
  const decision = await abtest.report({ testId });
  const summary = {
    testId, injected, skippedSamples, llmCalls, budgetCapped,
    winner: decision.winner, pValue: decision.pValue, effectSize: decision.effectSize, samples: decision.samples,
  };
  await emit(summary);
  return summary;
}