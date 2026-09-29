/**
 * lib/broadcast.js — agint-aesthetic-oracle 广播层纯函数（v2.3 方案 §5 / §6）。
 *
 * 职责边界：本文件只做「数据整形 + 模板渲染 + 护栏判定」，零 I/O、零服务访问。
 * 编排（读 summary → 评分 → 落表 → 发事件 → 审计）在 lib/index.js。
 *
 * v2.3 两条硬规则的落点：
 *   - §5 asOf 透出：每条广播首行必须带数据时间戳（metrics 04:00 采集 → 09:00
 *     广播存在 5 小时时延，如实标注）。禁止反向触发 _collectRaw —— 本模块根本
 *     接触不到 metrics 服务，结构上杜绝。
 *   - §5.4/§9.3 不刷屏：单条 ≤2KB（§7 预算）+ 分档配额（daily/weekly/monthly
 *     各自独立窗口）+ oracle.alert 独立日配额（防告警风暴）。
 */

import { DIM_KEYS, DIM_WEIGHTS, q3Advice, NO_ADVICE } from './scoring.js';

// ── 常量 ───────────────────────────────────────────────────────────────────

/** 单条广播字节上限（§7：≤ 2 KB / broadcast，UTF-8）。 */
export const MAX_BYTES = 2048;

/** 分档配额（§5.4 保留 v2.2；alert 独立日配额防风暴）。 */
export const QUOTA_LIMITS = Object.freeze({ daily: 2, weekly: 3, monthly: 3, alert: 3 });

/** 广播档位 → eventBus topic（§5 v2.3 增补；schema 注册归 Day 2-3）。 */
export const KIND_TOPIC = Object.freeze({
  daily: 'oracle.daily',
  weekly: 'oracle.weekly',
  monthly: 'oracle.monthly',
  alert: 'oracle.alert',
});

/** 四维指标中文名。 */
export const WORST_LABELS = Object.freeze({
  noise: '噪声比',
  confidence: '决策确信度',
  redundancy: '冗余度',
  bloat: '臃肿度',
});

const THRESHOLD_TEXT = Object.freeze({
  noise: '阈 30%',
  confidence: '阈 0.70',
  redundancy: '阈 5%',
  bloat: '预算 120KB',
});

// ── 时间 / 周期 key（全部本地时区——cron 按本地时刻触发）────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期 key：YYYY-MM-DD。 */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地月份 key：YYYY-MM。 */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** ISO 周 key：YYYY-Www（周一为一周之始）。 */
export function isoWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // 移到本周四（ISO 周锚点）
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

/** asOf → 本地可读「YYYY-MM-DD HH:mm」；无效输入原样透出（诚实优先）。 */
export function fmtAsOfLocal(iso) {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${dateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地周区间文本：MM-DD ~ MM-DD（周一起算）。 */
function weekRangeText(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - dow);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (x) => `${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  return `${fmt(start)} ~ ${fmt(end)}`;
}

// ── summary() → 原子值 / 建议上下文 / 活跃度 ───────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * 从 metrics summary() 抽取神谕层所需原子值。
 *
 * 纪律：本函数只「读」，不做任何二次采集；key 缺席 → null（下游 deriveComposites
 * 判 N/A + 权重归一，AC-4）。activity（§3.5）= logCount7d / logCount30d ——
 * **排除 targetKind=oracle 已在 metrics 采集侧完成**（metrics-ext.js 硬规则），
 * 本层拿到的就是排除后的数，不再有机会污染。
 *
 * @param {{asOf?: string, metrics?: Array<{key,value,meta}>}} summary
 */
export function extractAtomic(summary) {
  const byKey = new Map();
  for (const m of summary?.metrics ?? []) if (m?.key) byKey.set(m.key, m);
  const num = (k) => { const m = byKey.get(k); return isNum(m?.value) ? m.value : null; };
  const meta = (k) => {
    const raw = byKey.get(k)?.meta;
    if (typeof raw !== 'string' || !raw) return {};
    try { return JSON.parse(raw) ?? {}; } catch { return {}; }
  };

  const rulesMeta = meta('rules.lintIssues');
  const wikiMeta = meta('wiki.orphans');
  const contradMeta = meta('wiki.contradictions');
  const memoryMeta = meta('memory.total');
  const skillsMeta = meta('skills.totalBytes');

  const lintIssues = Array.isArray(rulesMeta.issues) ? rulesMeta.issues : [];
  // duplicate-pattern 才是冗余分子；lint 还有其他 kind（stale 等），别混。
  const duplicates = lintIssues.filter((i) => i?.kind === 'duplicate-pattern');
  // meta.issues 缺席（防御形态）时退化为 lint 总数——记录在案（viaFallback），
  // 让口径偏差可追溯而不是静默算错。
  const ruleDuplicates = byKey.has('rules.lintIssues')
    ? (Array.isArray(rulesMeta.issues) ? duplicates.length : (num('rules.lintIssues') ?? null))
    : null;

  // Q3 证据绑定的真实清单（§4 真实关）：wiki_lint 的 contradictions/orphans 明细
  // 原样透传（metrics 侧已整形成数组；防御形态归一化成 String）。
  const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);

  const noEv = memoryMeta.noEvidence ?? {};
  const log7 = num('evolution.logCount7d');
  const log30 = num('evolution.logCount30d');
  const activity = isNum(log7) && isNum(log30) && log30 > 0 ? round3(log7 / log30) : null;

  return {
    asOf: typeof summary?.asOf === 'string' ? summary.asOf : '',
    atomic: {
      wikiOrphans: num('wiki.orphans'),
      wikiContradictions: num('wiki.contradictions'),
      ruleDuplicates,
      memoryNoEvidence: isNum(noEv.count) ? noEv.count : null,
      wikiTotal: isNum(wikiMeta.total) ? wikiMeta.total : null,
      rulesTotal: isNum(rulesMeta.rulesTotal) ? rulesMeta.rulesTotal : null,
      memoryTotal: num('memory.total'),
      avgConfXCompliance: isNum(memoryMeta.avgConfXCompliance) ? memoryMeta.avgConfXCompliance : null,
      // curator 重叠对数：Day 0 未入 metrics 原子表（生产实测恒 0），缺省 0。
      curatorOverlaps: 0,
      skillsTotal: isNum(skillsMeta.fileCount) ? skillsMeta.fileCount : null,
      skillsBytes: num('skills.totalBytes'),
    },
    // Q3 建议的证据上下文（广播文本只引用计数与机制，id 清单进审计条目——§5 示例口径）
    // §4 真实关（2026-09-29）：建议必须绑定真实 lint 证据，故把 wiki 矛盾/孤儿
    // 的明细清单一并透传（redundancy 最丑但 rule_lint 0 命中时，q3Advice 靠
    // wikiContradictionFiles 指向真正的问题，而不是编一条 duplicate 建议）。
    adviceCtx: {
      memoryNoEvidenceCount: isNum(noEv.count) ? noEv.count : null,
      ruleLintIssues: lintIssues,
      wikiContradictionFiles: strList(contradMeta.files),
      wikiContradictionCount: num('wiki.contradictions'),
      wikiOrphanFiles: strList(wikiMeta.files),
      curatorOverlaps: 0,
      skillsBytes: num('skills.totalBytes'),
    },
    // id 清单：只给审计 findings 用，不进广播正文（防 2KB 爆掉）
    auditIds: Array.isArray(noEv.ids) ? noEv.ids : null,
    activity,
  };
}

// ── 渲染护栏 ───────────────────────────────────────────────────────────────

/** 行数组 → { text, bytes, truncated }：超 2KB 时从尾部裁行（保首行 asOf 与总分行）。 */
export function fitLines(lines) {
  let text = lines.join('\n');
  let bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_BYTES) return { text, lines, bytes, truncated: false };
  const kept = [...lines];
  // ⚠ 判定对象必须是「裁完后的全文含截断标记」，不能用 kept.slice(0,-1)——
  //   否则退出循环时全文仍可能超限（实测 2116 > 2048，2026-09-27）。
  while (kept.length > 2 && Buffer.byteLength(`${kept.join('\n')}\n…（截断）`, 'utf8') > MAX_BYTES) {
    kept.pop();
  }
  text = `${kept.join('\n')}\n…（截断）`;
  bytes = Buffer.byteLength(text, 'utf8');
  return { text, lines: kept, bytes, truncated: true };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const fmtDelta = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

/** 最丑行的「证据尾」：指到指标级 + 来源，不深挖到行（§4：深挖归 weekly 提案）。 */
function describeWorst(key, value, atomic) {
  const n = (v) => (isNum(v) ? v : '?');
  switch (key) {
    case 'noise':
      return `${pct(value)}（${THRESHOLD_TEXT.noise}）——`
        + `${n(atomic.memoryNoEvidence)} 条记忆无 evidence、${n(atomic.wikiOrphans)} 条 wiki 孤岛、${n(atomic.ruleDuplicates)} 条重复规则`;
    case 'confidence':
      return `${value.toFixed(3)}（${THRESHOLD_TEXT.confidence}）——AVG(置信×证据合规) 低于下限`;
    case 'redundancy':
      return `${pct(value)}（${THRESHOLD_TEXT.redundancy}）——`
        + `${n(atomic.ruleDuplicates)} 条重复规则、${n(atomic.wikiContradictions)} 条 wiki 矛盾`;
    case 'bloat':
      return `${pct(value)} 预算（${THRESHOLD_TEXT.bloat}）——SKILL.md 共 ${Math.round((atomic.skillsBytes ?? 0) / 1024)}KB`;
    default:
      return `${value}`;
  }
}

/** 配额滚动：周期翻转清零（幂等，返回新 quota 对象；调用方自行落盘）。 */
export function rollQuota(quota, now = new Date()) {
  const dk = dateKey(now);
  const wk = isoWeekKey(now);
  const mk = monthKey(now);
  const q = { ...quota };
  if (q.date !== dk) { q.date = dk; q.daily = 0; q.alerts = 0; q.violations = 0; }
  if (q.weeklyKey !== wk) { q.weeklyKey = wk; q.weekly = 0; }
  if (q.monthlyKey !== mk) { q.monthlyKey = mk; q.monthly = 0; }
  return q;
}

// ── 三档 + alert 模板（§5；AC-2：daily ≤5 行、≤2KB、首行含 asOf）────────────

/**
 * 渲染广播文本。
 * @param {'daily'|'weekly'|'monthly'|'alert'} kind
 * @param {object} c
 *   now / asOf / evaluation（evaluateAesthetics 输出）/ atomic / activity /
 *   baseline { established, score } / dayIndex（基线未建立时的第 N 天）/
 *   staleDays（§6.1 缓存回退时的数据龄标注，天）/
 *   reason + detail（仅 alert）
 */
export function renderReport(kind, c = {}) {
  const asOfText = fmtAsOfLocal(c.asOf);
  const ev = c.evaluation ?? {};
  const scored = ev.scored ?? {};
  const verdict = ev.verdict ?? {};
  const breath = isNum(c.activity) && c.activity < 0.1
    ? `｜呼吸：进化静默期（${c.activity}）` : '';

  if (kind === 'alert') {
    const now = c.now ?? new Date();
    const lines = [
      `🔔 美谕警报 ${dateKey(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
      String(c.reason ?? '（未说明）'),
      String(c.detail ?? '').trim(),
      '（警报不占常规配额；审计见 oracle-alert-* 条目）',
    ].filter((l) => l !== '');
    return fitLines(lines);
  }

  // 总分行：基线语义（§3.6）——首周记 Day N/7，建立后 Δ 相对基线
  const scoreTxt = isNum(scored.score) ? `总分：${scored.score}/100` : '总分：N/A';
  const baseTxt = c.baseline?.established
    ? `基线 ${isNum(c.baseline.score) ? c.baseline.score : '?'}`
    : `首周起算·Day ${isNum(c.dayIndex) ? c.dayIndex : '?'}/7`;
  const deltaTxt = c.baseline?.established && isNum(scored.score) && isNum(c.baseline.score)
    ? `｜Δ：${fmtDelta(scored.score - c.baseline.score)}` : '｜Δ：—';
  const naTxt = Array.isArray(scored.naDims) && scored.naDims.length
    ? `｜N/A：${scored.naDims.join('/')}` : '';
  // §6.1 缓存回退标注（Day 2-3）：合进总分行不加行——AC-2 的 daily ≤5 行上限
  // 不因数据陈旧而放松；首行 asOf（缓存时点）本身已诚实透出数据新旧。
  const staleTxt = isNum(c.staleDays) ? `｜⚠缓存${c.staleDays}天` : '';
  const scoreLine = `${scoreTxt}（${baseTxt}）${deltaTxt}${breath}${naTxt}${staleTxt}`;

  // 最丑行 + 建议 + 证据（Q2/Q3；最丑缺席时后两行收起）
  const worst = ev.worst ?? null;
  const worstLines = worst
    ? [
        `最丑：${WORST_LABELS[worst.key] ?? worst.key} ${describeWorst(worst.key, worst.value, c.atomic ?? {})}`,
        `建议：${ev.advice?.advice ?? '（无机械建议）'}`,
        `证据：${ev.advice?.evidence ?? '（无）'}`,
      ]
    : ['最丑：无——可用维度均在阈内'];

  if (kind === 'daily') {
    return fitLines([`📊 今日美评 ${dateKey(c.now ?? new Date())}（数据截至 ${asOfText}）`, scoreLine, ...worstLines]);
  }
  if (kind === 'weekly') {
    const v = verdict.verdict ?? 'flat';
    const vText = { beautiful: '在变美', ugly: '在变丑', flat: '持平' }[v] ?? v;
    const q1 = `（恶化 ${verdict.worseCount ?? 0}／改善 ${verdict.betterCount ?? 0}${verdict.note ? `；${verdict.note}` : ''}）`;
    return fitLines([
      `📈 本周美谕 ${weekRangeText(c.now ?? new Date())}（数据截至 ${asOfText}）`,
      scoreLine,
      `本周三问：Q1 ${vText}${q1}`,
      ...worstLines,
    ]);
  }
  // monthly
  const v = verdict.verdict ?? 'flat';
  const vText = { beautiful: '在变美', ugly: '在变丑', flat: '持平' }[v] ?? v;
  return fitLines([
    `🗓️ 本月美鉴 ${monthKey(c.now ?? new Date())}（数据截至 ${asOfText}）`,
    scoreLine,
    `本月三问：Q1 ${vText}`,
    ...worstLines,
  ]);
}

// ── 落盘形态整形（index.js 消费；放本文件以便与渲染同测）────────────────────

/** baseline 存储形态（纯数）→ q1Verdict 需要的 dims 形态。 */
export function dimsFromRecord(rec) {
  const out = {};
  for (const k of DIM_KEYS) {
    const v = rec?.[k];
    out[k] = isNum(v) ? { value: v, na: false } : { value: null, na: true };
  }
  return out;
}

/** composites → 存储形态（na 维存 null；z.record(number.nullable)）。 */
export function compositesRecord(composites) {
  const out = {};
  for (const k of DIM_KEYS) {
    const v = composites?.[k]?.value;
    out[k] = isNum(v) ? v : null;
  }
  return out;
}

/** evaluation → 审计 scores（schema 是 z.record(z.number())，null 维直接省略）。 */
export function auditScores(evaluation) {
  const out = {};
  if (isNum(evaluation?.scored?.score)) out.aestheticScore = evaluation.scored.score;
  for (const k of DIM_KEYS) {
    const v = evaluation?.composites?.[k]?.value;
    if (isNum(v)) out[k] = v;
  }
  return out;
}

/** 审计条目 targetId（唯一性承担者；schema 注释的契约：targetKind 静态档 + targetId 带日期）。 */
export function auditTargetId(kind, now = new Date(), seq = null) {
  if (kind === 'daily') return `oracle-daily-${dateKey(now)}`;
  if (kind === 'weekly') return `oracle-weekly-${isoWeekKey(now)}`;
  if (kind === 'monthly') return `oracle-monthly-${monthKey(now)}`;
  return `oracle-alert-${dateKey(now)}${seq != null ? `-${seq}` : ''}`;
}

// ── weekly 美谕提案（§5 weekly 部分 / Day 4-5）──────────────────────────────

/** 提案 category 映射（evolve 枚举：rule/skill/doc/preset/service/plugin/other）。 */
const PROPOSAL_CATEGORY = Object.freeze({
  noise: 'doc',        // 补 evidence / 归档 orphans → 记忆与 wiki 内容
  confidence: 'doc',   // 定向复核 lesson 条目 → 内容质量
  redundancy: 'rule',  // 合并 duplicate 规则 → 规则层
  bloat: 'skill',      // 归档陈旧/重叠技能 → 技能层
});

/**
 * 从评分结果派生 weekly 提案（§5：3 条，evidence 必填）。
 *
 * 派生规则：可用维按**绝对扣分**降序（与 Q2 同口径），只取扣分 > 0 的维，
 * 最多 3 条——0 扣分（阈内）的维没有可改进项，提了也是噪声。每条经
 * q3Advice 生成（纯机械动作 + 必附证据），⭐ 只产出文本，不执行任何动作：
 * 归档/合并由老板决定后走各自插件，oracle 永不调 curator_archive。
 *
 * §4 真实关（2026-09-29）：q3Advice 返回 NO_ADVICE 的维直接跳过——
 * 查不到证据就不提提案（「本日无可执行建议」不是提案正文）。
 *
 * @returns {Array<{title, body, category, note}>}
 */
export function buildWeeklyProposals(evaluation, adviceCtx = {}, meta = {}) {
  const dims = evaluation?.scored?.dims ?? {};
  const composites = evaluation?.composites ?? {};
  const ranked = DIM_KEYS
    .filter((k) => dims[k]?.available && isNum(dims[k]?.deduction) && dims[k].deduction > 0)
    .map((k) => ({ key: k, deduction: dims[k].deduction }))
    .sort((a, b) => b.deduction - a.deduction);
  const drafts = [];
  for (const { key, deduction } of ranked) {
    if (drafts.length >= 3) break;
    const a = q3Advice(key, adviceCtx) ?? {};
    if (!a.advice || a.advice === NO_ADVICE) continue; // 无可执行建议的维不提
    const c = composites?.[key] ?? {};
    const valTxt = isNum(c.value) ? (key === 'confidence' ? c.value.toFixed(3) : pct(c.value)) : 'N/A';
    const title = `美谕提案：${WORST_LABELS[key] ?? key} 扣 ${deduction.toFixed(1)} 分`;
    const body = [
      `建议：${a.advice}`,
      `证据：${a.evidence ?? '（无）'}`,
      `现状：${valTxt}（${THRESHOLD_TEXT[key] ?? ''}），绝对扣分 ${deduction.toFixed(1)}/${DIM_WEIGHTS[key]}`,
      meta.weekKey ? `周期：${meta.weekKey}` : null,
      meta.targetId ? `审计：${meta.targetId}（id 清单等详情见审计 findings）` : null,
      '性质：纯机械动作提案（status 锁 proposed，永不 auto-apply；执行与否由老板定）',
    ].filter(Boolean).join('\n');
    drafts.push({ title, body, category: PROPOSAL_CATEGORY[key] ?? 'other' });
  }
  return drafts;
}
