#!/usr/bin/env node
/**
 * 架构图「边声明」自洽校验（结构级门禁，2026-11-16）。
 *
 * 边界（写在这里防止以后被误用）：
 *  ⛔ 本脚本**不**证明边在运行时真的通电。25+ 条边是人工声明的结构关系，
 *     其源码层面的真源仍归 Q1（scan.hits，410 条，含注释命中 / 伞键 / 无提供方）。
 *     拿 hits 自动生成边会造出系统里不存在的依赖 —— 这是方案里明确否决的路径。
 *  本脚本只保证「声明本身不烂」：引用存在、kind 合法、有依据、无重复、无自环，
 *  并把「未接线节点」「断点边缺证据」报成 WARN 供人复核。
 *
 * 用法：node bin/check-arch-edges.mjs
 * 退出码：0 = 结构自洽（可带 WARN）；1 = 结构错误。
 */
import { EDGE_DECL, collectArchData } from '../plugins/agint-family-panel/lib/arch-data.js';

const KINDS = new Set(['live', 'break', 'frozen', 'human', 'feedback']);
const STORAGES = (process.env.DSH_HOME || 'D:/DSH/AGINT-date') + '/storages';

const model = collectArchData({ storagesDir: STORAGES });
const ids = new Set(model.nodes.map((n) => n.id));
const fails = [];
const warns = [];

const seen = new Set();
EDGE_DECL.forEach((decl, i) => {
  const [from, to, kind, label, basis] = decl;
  const at = '#' + i + ' ' + String(from) + '->' + String(to);
  if (!from || !to) fails.push(at + '：缺 from/to');
  if (from && !ids.has(from)) fails.push(at + '：from 不在节点集合');
  if (to && !ids.has(to)) fails.push(at + '：to 不在节点集合');
  if (from && from === to) fails.push(at + '：自环');
  if (!KINDS.has(kind)) fails.push(at + '：kind="' + kind + '" 非法（允许 ' + [...KINDS].join('/') + '）');
  if (!label) fails.push(at + '：缺 label');
  if (!basis) fails.push(at + '：缺 basis（凭什么成立）');
  const key = from + '->' + to;
  if (seen.has(key)) fails.push(at + '：重复边');
  seen.add(key);
});

const linked = new Set();
EDGE_DECL.forEach(([f, t]) => { linked.add(f); linked.add(t); });
const isolated = model.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
if (isolated.length) warns.push('未接线节点：' + isolated.join(', '));

const breakNoEvidence = model.edges.filter((e) => e.kind === 'break' && !e.evidence).map((e) => e.from + '->' + e.to);
if (breakNoEvidence.length) warns.push('断点边缺当次证据：' + breakNoEvidence.join(', '));

// 计数器与声明表必须对得上（防止渲染层另算一份）
const kindCount = {};
for (const d of EDGE_DECL) kindCount[d[2]] = (kindCount[d[2]] || 0) + 1;
if (EDGE_DECL.length !== model.counts.edges) {
  fails.push('声明边数 ' + EDGE_DECL.length + ' ≠ 模型边数 ' + model.counts.edges);
}
const sum = model.counts.live + model.counts.break + model.counts.feedback + model.counts.frozen + model.counts.human;
if (sum !== model.counts.edges) fails.push('五类边之和 ' + sum + ' ≠ 边数 ' + model.counts.edges);

console.log('arch edges=' + EDGE_DECL.length + ' nodes=' + model.nodes.length
  + ' kinds=' + JSON.stringify(kindCount));
console.log('live=' + model.counts.live + ' break=' + model.counts.break + ' feedback=' + model.counts.feedback
  + ' frozen=' + model.counts.frozen + ' human=' + model.counts.human);
for (const w of warns) console.log('[WARN] ' + w);
for (const f of fails) console.log('[FAIL] ' + f);
console.log(fails.length ? 'FAIL ' + fails.length + ' 项结构错误' : 'PASS 边声明自洽（' + warns.length + ' 条告警）');
process.exit(fails.length ? 1 : 0);
