/**
 * agint-upstream-watch — v0.3 判读质量仪器（校准）。
 *
 * ## 它要回答的问题，与它回答不了的问题
 *
 * 能答：**「当时的判断，被后来的事实推翻了没有」**。
 * 判不了：**「这条提案该不该做」「AGINT 有没有变好」** —— 那是人的事、是 quality-eval
 * 的维度分，不是本模块能证的。⛔ 本模块不产「准确率 87%」这种看起来漂亮的总分，
 * 只产**逐条可核对的对拍记录**：哪条判断错了、错在哪个包、错在哪个符号。
 *
 * ## 为什么这件事必须做（而不是锦上添花）
 *
 * v0.1 的立论是「结论必须由实测给出」。但实测本身也会错 —— 2026-10-28 那次
 * 基准拿了 `profiles/node_modules` 里 App 升级甩下的 0.1.1-rc.2，得出
 * 「45 个导出被移除、31 个签名变化」的全假结论。**没有回填，这种错永远看不见**：
 * 判读器会一直自信地输出，而没人知道它上一次是对是错。
 *
 * ## 可证伪的判据（这是本设计的核心）
 *
 * 预测里唯一硬的东西是「AGINT 用到的这些符号，在目标版本里还在不在」。
 * 升级发生后，用**真实的安装树**重算一次，就能两个方向对拍：
 *
 * | 当时判 | 升级后实测 | 结论 | 危害 |
 * |---|---|---|---|
 * | `breaking`（用到的符号被删） | 符号**还在** | 误报 `false-positive` | 白改代码 |
 * | 非 breaking | 符号**没了** | 漏报 `false-negative` | 上线即坏 |
 *
 * ⛔ 两个方向都必须算。只算漏报会让判读器倾向于「全都报 breaking」来刷分；
 *    只算误报会让它倾向于「什么都不报」。两个一起算，它才没有便宜的作弊方向。
 *
 * ## 什么情况下不下结论
 *
 * - 目标版本没装上（人没升 / 升到别的版本）⇒ `pending`，不是「预测正确」
 * - 拿不到安装位置或接口面为空 ⇒ `unknown`，不猜
 * - 判读之后 AGINT 的 import 面变了 ⇒ `code-drift`，只对**两边都在用的符号**对拍，
 *   并把这个事实写在记录里（否则「符号还在」可能只是因为 AGINT 不再用它了）
 */

import {
  resolveInstalledPackage, readInstalledSymbols, scanDependencyFace,
} from './depface.js';
import { normalizeTag } from './version.js';

/**
 * 从一次判读的事实里抽出可证伪清单。
 *
 * ⛔ 只抽「能对拍」的东西：包的 usedImpact + 当时用到的符号名。
 *    LLM 的 headline / rationale 不进 prediction —— 那是自然语言结论，
 *    无法机械对拍，放进来只会让人以为它被验证过了。
 *
 * @param {object} facts - collectFacts() 的输出
 * @returns {object} prediction（落进 digests 表，供日后回填）
 */
export function buildPrediction(facts) {
  const packages = [];
  for (const d of facts?.depFace ?? []) {
    // 只预测有使用面的包：`usedImpact=none` 说明 AGINT 根本没 import 它，
    // 没有「用到的符号」可以对拍。
    if (!Array.isArray(d.usedList) && !d.usedCount) continue;
    packages.push({
      pkg: d.pkg,
      from: d.from ?? null,
      to: d.to ?? facts.targetVersion ?? null,
      usedImpact: d.usedImpact ?? 'none',
      verdict: d.verdict ?? 'unknown',
      overallImpact: d.overallImpact ?? d.usedImpact ?? 'none',
      usedNames: Array.isArray(d.usedNames) ? d.usedNames.slice(0, 200) : [],
    });
  }
  return {
    tag: facts?.tag ?? null,
    targetVersion: facts?.targetVersion ?? null,
    installedAtPredict: facts?.installedVersion ?? null,
    host: facts?.hostFace ? {
      from: facts.hostFace.from ?? null,
      to: facts.hostFace.to ?? null,
      blocking: facts.hostFace.overallImpact === 'blocking',
      semanticImpact: facts.hostFace.semanticImpact ?? 'unknown',
      engineRaised: (facts.hostFace.semanticDeltas ?? []).some((x) => x.kind === 'engine-raised'),
      engineBlocker: (facts.hostFace.semanticDeltas ?? []).some((x) => x.severity === 'blocker'),
    } : null,
    packages,
    predictedAt: new Date().toISOString(),
  };
}

/**
 * 判断某个已判读版本是否「已经装上、可以回填」。
 *
 * @param {string|null} installedVersion 当前本机 dsh 版本
 * @param {Array<{tag:string, targetVersion:string|null}>} digests
 * @param {Set<string>} done 已回填过的 tag
 * @returns {Array<{tag:string, targetVersion:string}>} 需要回填的（通常 0 或 1 条）
 */
export function findBackfillTargets(installedVersion, digests, done = new Set()) {
  if (!installedVersion) return [];
  const out = [];
  for (const d of digests ?? []) {
    if (!d?.tag || done.has(d.tag)) continue;
    const tv = d.targetVersion ? normalizeTag(d.targetVersion) : null;
    if (!tv) continue;
    // ⛔ 必须**精确等于**当前版本：装了更新的版本时，回填对拍的是「目标版本的行为」，
    //    而实际跑的是另一个版本 —— 那种对拍没有意义，宁可一直 pending。
    if (tv === normalizeTag(installedVersion)) out.push({ tag: d.tag, targetVersion: tv });
  }
  return out;
}

/** 名字是否算「还在」：查完整键；成员形式（Owner.member）还要看根名在不在。 */
function symbolPresent(symbols, name) {
  if (symbols.has(name)) return true;
  const root = String(name).split('.')[0];
  if (root !== name && symbols.has(root)) return true;
  return false;
}

/**
 * 对一个已完成升级的判读做对拍。
 *
 * @param {object} p
 * @param {object} p.prediction - buildPrediction() 的输出（随 digest 落盘）
 * @param {string|null} p.installedVersion - 当前本机版本
 * @param {string} p.repoRoot - AGINT 仓库根（用于判断 import 面有没有漂）
 * @param {object} [p.env]
 * @returns {object} outcome
 */
export function evaluateOutcome({ prediction, installedVersion, repoRoot, env = process.env }) {
  const at = new Date().toISOString();
  const base = {
    tag: prediction?.tag ?? null,
    targetVersion: prediction?.targetVersion ?? null,
    evaluatedAt: at,
    installedVersion: installedVersion ?? null,
    status: 'unknown',
    reason: null,
    perPackage: [],
    falsePositive: 0,
    falseNegative: 0,
    confirmed: 0,
    unverifiable: 0,
  };

  if (!prediction || !Array.isArray(prediction.packages)) {
    return { ...base, reason: 'prediction 缺失或形态未知（旧版判读没有留预测清单）' };
  }
  const target = prediction.targetVersion ? normalizeTag(prediction.targetVersion) : null;
  const now = installedVersion ? normalizeTag(installedVersion) : null;
  if (!target || !now) {
    return { ...base, reason: '版本号读不到（prediction.targetVersion 或本机版本为空）' };
  }
  if (target !== now) {
    return { ...base, reason: `本机 ${now} ≠ 预测目标 ${target}，口径不同不可对拍` };
  }

  // 当前的 import 面：用于判定「判读之后 AGINT 自己的代码有没有变」
  let nowFace = null;
  try { nowFace = scanDependencyFace(repoRoot); } catch { nowFace = null; }

  const perPackage = [];
  for (const p of prediction.packages) {
    const rec = {
      pkg: p.pkg,
      predicted: p.usedImpact ?? 'unknown',
      usedAtPredict: (p.usedNames ?? []).length,
      usedNow: null,
      missingUsed: [],
      verdict: 'unverifiable',
      note: null,
    };

    const located = resolveInstalledPackage(p.pkg, env);
    if (!located) {
      rec.note = '本机找不到该包安装位置';
      base.unverifiable += 1;
      perPackage.push(rec);
      continue;
    }
    rec.installedVersion = located.version;

    let symbols;
    try { symbols = readInstalledSymbols(located.dir); } catch { symbols = null; }
    if (!symbols || symbols.size === 0) {
      rec.note = '当前安装版本的接口面为空（可能没 lib/types，或解包失败）';
      base.unverifiable += 1;
      perPackage.push(rec);
      continue;
    }

    // 判读之后的代码漂移：AGINT 现在还用不用这些名字
    const usedNow = nowFace?.get(p.pkg)?.imports ?? null;
    rec.usedNow = usedNow ? [...usedNow].length : null;
    rec.codeDrift = Boolean(usedNow && (p.usedNames ?? []).some((n) => n !== '~dynamic' && !usedNow.has(n)));

    const names = (p.usedNames ?? []).filter((n) => n && n !== '~dynamic');
    rec.checkedNames = names.length;
    if (names.length === 0) {
      rec.note = '该包只有动态 import 或使用面为空，没有可对拍的符号名';
      base.unverifiable += 1;
      perPackage.push(rec);
      continue;
    }

    const missing = names.filter((n) => !symbolPresent(symbols, n));
    rec.missingUsed = missing.slice(0, 10);

    if (p.usedImpact === 'breaking') {
      // 当时说「用到的符号被删」⇒ 升级后应当确实看不到它们
      if (missing.length > 0) {
        rec.verdict = 'confirmed';
        base.confirmed += 1;
        rec.note = `预测成立：${missing.length} 个用到的符号确实不在 ${located.version} 里`;
      } else {
        rec.verdict = 'false-positive';
        base.falsePositive += 1;
        rec.note = `**误报**：当时判 breaking，但用到的 ${names.length} 个符号在 ${located.version} 里都还在`
          + (located.versionMismatch ? '（当时基准可疑，与此一致）' : '');
      }
    } else {
      // 当时说「没风险」⇒ 升级后不应当有用到的符号消失
      if (missing.length > 0) {
        rec.verdict = 'false-negative';
        base.falseNegative += 1;
        rec.note = `**漏报**：当时判 ${p.usedImpact}，但 ${missing.length} 个用到的符号在 ${located.version} 里没有了`;
      } else {
        rec.verdict = 'confirmed';
        base.confirmed += 1;
        rec.note = `预测成立：用到的 ${names.length} 个符号都还在`;
      }
    }
    perPackage.push(rec);
  }

  const status = perPackage.some((x) => x.codeDrift) ? 'code-drift' : 'ok';
  return {
    ...base,
    status,
    reason: status === 'code-drift'
      ? '判读之后 AGINT 的 import 面变了；对拍按「当时用到的名字」进行，漂移事实已记在 perPackage.codeDrift'
      : null,
    perPackage,
  };
}

/**
 * 汇总成校准报告（服务 / 面板 / quality-eval 共用一份口径）。
 *
 * ⛔ 不合成单一「准确率」放在最显眼处：两类错的代价不对称（漏报会让你上线就坏，
 *    误报只是白改一次代码），合成一个数就把这个不对称抹掉了。
 *    两个比率都算，且**分别**给分母（样本数）—— 没有分母的比率是骗人的。
 */
export function summarizeCalibration({ digests = [], outcomes = [], installedVersion = null } = {}) {
  const rows = outcomes ?? [];
  const evaluated = rows.length;
  let fp = 0;
  let fn = 0;
  let confirmed = 0;
  let unverifiable = 0;
  for (const r of rows) {
    fp += r.falsePositive ?? 0;
    fn += r.falseNegative ?? 0;
    confirmed += r.confirmed ?? 0;
    unverifiable += r.unverifiable ?? 0;
  }
  const judged = (digests ?? []).length;
  const targets = new Set(rows.map((r) => r.tag));
  const pending = Math.max(0, judged - targets.size);

  const rate = (n, d) => (d > 0 ? Number((n / d).toFixed(3)) : null);

  return {
    state: evaluated > 0 ? 'ok' : (judged > 0 ? 'pending' : 'empty'),
    installedVersion: installedVersion ?? null,
    judged,
    evaluated,
    pending,
    counts: { falsePositive: fp, falseNegative: fn, confirmed, unverifiable },
    // 分母分开给：falsePositiveRate 的分母是所有被对拍的包，falseNegativeRate 也一样。
    // 用「条」做分母会让一个含 5 个包的版本权重等于含 1 个包的版本，口径不一致。
    packagesChecked: confirmed + fp + fn,
    falsePositiveRate: rate(fp, confirmed + fp + fn),
    falseNegativeRate: rate(fn, confirmed + fp + fn),
    lastEvaluatedAt: rows.map((r) => r.evaluatedAt).filter(Boolean).sort().pop() ?? null,
    // 供 quality-eval 直接读：判读器是否「可自证」
    selfEvident: evaluated > 0,
  };
}

/**
 * 把校准结果转成 quality-eval 能用的**打分输入**（不是分数本身）。
 *
 * 设计约束（对齐 `agint-quality-eval` 的 evaluator 契约）：
 *   - 不给 `score`，只给 `raw` 与 `findings` 材料 —— 打分是 evaluator 的职责，
 *     判读器不该给自己定分（自评陷阱）。
 *   - 样本不足时明确说 `insufficient`，让 evaluator 保持中性，而不是拿 0 样本算 100%。
 */
export function calibrationForQuality(summary) {
  const s = summary ?? {};
  const n = s.packagesChecked ?? 0;
  if (!n) {
    return {
      available: false,
      reason: '尚无已回填的判读（没有升级发生，或预测清单为空）',
      metrics: null,
      findings: [{
        severity: 'info',
        message: '判读器还没有可对拍的样本：升级发生后会自动回填',
        evidence: [],
      }],
    };
  }
  const findings = [];
  if ((s.counts?.falseNegative ?? 0) > 0) {
    findings.push({
      severity: 'warn',
      message: `${s.counts.falseNegative} 个包被漏报（当时判无风险，实际用到的符号没了）`,
      evidence: [`falseNegativeRate=${s.falseNegativeRate}`],
    });
  }
  if ((s.counts?.falsePositive ?? 0) > 0) {
    findings.push({
      severity: 'info',
      message: `${s.counts.falsePositive} 个包被误报（当时判 breaking，实际符号都在）`,
      evidence: [`falsePositiveRate=${s.falsePositiveRate}`],
    });
  }
  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      message: `已对拍 ${n} 个包，未发现误报与漏报`,
      evidence: [],
    });
  }
  return {
    available: true,
    reason: null,
    metrics: {
      packagesChecked: n,
      falsePositiveRate: s.falsePositiveRate,
      falseNegativeRate: s.falseNegativeRate,
      confirmed: s.counts?.confirmed ?? 0,
    },
    findings,
  };
}
