/**
 * agint-trajectory/lib/export.js — ShareGPT / JSONL 导出（§6，Sprint 19 T8）。
 *
 * 三条硬约束：
 *   1. **分离导出**（不变量 #3）：success 与 failure 永不混写同一文件。
 *      aborted 归入 failure 侧（非成功即非成功样本，诚实标注在 sidecar）。
 *   2. **导出自检**（§6.1）：逐行 JSON.parse + 最小字段校验，失败标
 *      exportInvalid 并由 stats() 暴露——不允许带病交付。
 *   3. **路径跨平台**（§6.1 教训：quality-sdk 正则只认正斜杠 → Windows
 *      scanned=0）：一律 path.join，正则里不写死斜杠。
 */

import { join } from 'node:path';

const SHAREGPT_FROM = ['system', 'human', 'gpt', 'observation'];

/** 元数据一句话（system 轮前缀；§6.1） */
export function systemPreamble(traj) {
  const ref = traj?.taskRef ?? {};
  const bits = [`source=${traj?.source ?? 'unknown'}`];
  if (ref.cronJob) bits.push(`cron=${ref.cronJob}`);
  if (ref.variantId) bits.push(`variant=${ref.variantId}`);
  if (Number.isInteger(ref.round)) bits.push(`round=${ref.round}`);
  if (ref.subagentTaskId) bits.push(`subagentTask=${ref.subagentTaskId}`);
  if (traj?.startedAt) bits.push(`started=${traj.startedAt}`);
  return `AGINT trajectory ${traj?.id ?? ''} (${bits.join(', ')})`;
}

/**
 * 单条轨迹 → ShareGPT 记录。
 * @param {Object} traj
 * @param {{foldObservation?:boolean}} opts fold=true 时 observation 折叠为
 *        human 前缀 `Observation:`（兼容只认 system/human/gpt 的微调框架）。
 */
export function toShareGpt(traj, opts = {}) {
  const fold = opts.foldObservation === true;
  const steps = Array.isArray(traj?.payload?.steps) ? traj.payload.steps : [];
  const conversations = [];
  let hasSystem = false;
  for (const s of steps) {
    const role = SHAREGPT_FROM.includes(s?.role) ? s.role : 'observation';
    if (role === 'system') hasSystem = true;
    if (role === 'observation' && fold) {
      conversations.push({ from: 'human', value: `Observation: ${s.content ?? ''}` });
    } else {
      conversations.push({ from: role, value: s.content ?? '' });
    }
  }
  if (!hasSystem) conversations.unshift({ from: 'system', value: systemPreamble(traj) });
  return { id: traj?.id ?? '', conversations };
}

/** 单条轨迹 → sidecar 索引项（元数据不污染 ShareGPT 体） */
export function toIndexEntry(traj) {
  return {
    trajId: traj?.id ?? '',
    kind: traj?.kind ?? 'success',
    source: traj?.source ?? '',
    errorClass: traj?.outcome?.errorClass ?? null,
    attributionId: traj?.outcome?.attributionId ?? null,
    usage: {
      tokensIn: traj?.usage?.tokensIn ?? 0,
      tokensOut: traj?.usage?.tokensOut ?? 0,
      toolCalls: traj?.usage?.toolCalls ?? 0,
    },
    durationMs: traj?.durationMs ?? 0,
    truncated: traj?.truncated === true,
    redacted: traj?.redacted === true,
  };
}

/**
 * 构建导出内容（纯函数，不碰文件系统）。
 * @param {Array} trajectories
 * @param {{format?:'sharegpt'|'jsonl', foldObservation?:boolean}} opts
 * @returns {{success:string[], failure:string[], index:Object[], counts:Object}}
 */
export function buildExport(trajectories = [], opts = {}) {
  const format = opts.format === 'jsonl' ? 'jsonl' : 'sharegpt';
  const success = [];
  const failure = [];
  const index = [];
  for (const t of trajectories) {
    if (!t) continue;
    const isFailure = t.kind !== 'success';
    const line = format === 'jsonl'
      ? JSON.stringify(t)
      : JSON.stringify(toShareGpt(t, opts));
    (isFailure ? failure : success).push(line);
    index.push(toIndexEntry(t));
  }
  return {
    success,
    failure,
    index,
    counts: { success: success.length, failure: failure.length, total: success.length + failure.length },
  };
}

/**
 * 导出自检（§6.1）：逐行 JSON.parse + 最小字段校验。
 * @param {string[]} lines
 * @param {'sharegpt'|'jsonl'} format
 * @returns {{valid:boolean, invalid:number, errors:string[]}}
 */
export function validateExport(lines = [], format = 'sharegpt') {
  const errors = [];
  let invalid = 0;
  lines.forEach((line, i) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      invalid++;
      errors.push(`line ${i + 1}: JSON.parse failed (${e?.message ?? e})`);
      return;
    }
    if (format === 'sharegpt') {
      const conv = obj?.conversations;
      if (!Array.isArray(conv) || conv.length === 0) {
        invalid++;
        errors.push(`line ${i + 1}: conversations empty`);
        return;
      }
      for (const c of conv) {
        if (!c || !SHAREGPT_FROM.includes(c.from)) {
          invalid++;
          errors.push(`line ${i + 1}: illegal from='${c?.from}'`);
          return;
        }
        if (typeof c.value !== 'string') {
          invalid++;
          errors.push(`line ${i + 1}: value not string`);
          return;
        }
      }
    } else if (!obj || typeof obj.id !== 'string' || !obj.source) {
      invalid++;
      errors.push(`line ${i + 1}: missing id/source`);
    }
  });
  return { valid: invalid === 0, invalid, errors: errors.slice(0, 20) };
}

/**
 * 落盘导出文件。fs 可注入（测试用内存实现）。
 * @returns {Promise<{successPath:string, failurePath:string, indexPath:string, counts:Object, validation:Object}>}
 */
export async function writeExport(args = {}) {
  const {
    dir, date, format = 'sharegpt', success = [], failure = [], index = [],
    fs = null, counts = { success: success.length, failure: failure.length, total: success.length + failure.length },
  } = args;
  if (!dir) throw new Error('agint.trajectory.export: dir required');
  const io = fs ?? await import('node:fs/promises');
  const day = date ?? new Date().toISOString().slice(0, 10);
  await io.mkdir(dir, { recursive: true });
  const prefix = format === 'jsonl' ? 'jsonl' : 'sharegpt';
  const successPath = join(dir, `${prefix}-success-${day}.jsonl`);
  const failurePath = join(dir, `${prefix}-failure-${day}.jsonl`);
  const indexPath = join(dir, `index-${day}.json`);
  await io.writeFile(successPath, success.length ? `${success.join('\n')}\n` : '', 'utf8');
  await io.writeFile(failurePath, failure.length ? `${failure.join('\n')}\n` : '', 'utf8');
  await io.writeFile(indexPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), format, counts, entries: index }, null, 2)}\n`, 'utf8');
  const validation = {
    success: validateExport(success, format),
    failure: validateExport(failure, format),
  };
  return {
    successPath,
    failurePath,
    indexPath,
    counts,
    validation,
    valid: validation.success.valid && validation.failure.valid,
  };
}
