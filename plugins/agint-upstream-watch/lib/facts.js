/**
 * agint-upstream-watch — 段 1：确定性判读（产事实，不调模型）。
 *
 * ## 为什么事实和结论必须分开
 *
 * 事实（版本号、删了哪些导出、AGINT 用到了没有）是**可复算**的，任何时候都能跑；
 * 结论（这次变动对 AGINT 意味着什么）需要判断力，会失败、会误判。
 * 混在一起只有一个后果：模型一挂，连「已知事实」都看不到了，
 * 排查时无法区分「没事发生」和「没跑起来」。
 *
 * 所以本文件只输出可复算的东西，一个形容词都不要有。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyLevel, preStageChange, normalizeTag, parseVersion,
} from './version.js';
import {
  scanDependencyFace, probePackageApi, resolveDshRoot,
} from './depface.js';

/** 变更小节的分类关键词（中英双语 release body 用） */
const SECTION_PATTERNS = [
  { id: 'feature', re: /新增|新功能|New Features|Features|特性/i },
  { id: 'improve', re: /优化|改进|体验|Improvements|Enhancements/i },
  { id: 'fix', re: /修复|问题修复|Bug Fixes|Fixes/i },
  { id: 'other', re: /其他|变更|Breaking|Other Changes/i },
];

/**
 * 解析 release body，抽出「一共几条、其中哪几条像破坏性变更、内容类型分布」。
 *
 * body 是双语的（中文段 + 英文段），切在英文段起点，否则每个条目会数成两遍。
 *
 * ⛔ 分节统计（`sections`）只当参考，**不能当主指标**：上游写 release 的格式会变。
 *    2026-10-28 实测 `0.2.2-alpha.2` 就只用一个 `<h3>新增功能</h3>` 把 116 条全装进去，
 *    根本没有「体验优化 / 问题修复 / 其他变更」这几个小节 —— 按小节名归类会得出
 *    「116 条全是新功能」这种荒谬结论。所以主指标是**逐条按内容打标**（`tagCounts`），
 *    它不依赖标题怎么写。
 */
export function parseReleaseBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) {
    return {
      sectionCount: 0, entryCount: 0, breakingHits: 0,
      sections: {}, tagCounts: {}, breakingSamples: [],
    };
  }
  const enIdx = text.search(/<h3[^>]*id="en-/i);
  const part = enIdx > 0 ? text.slice(0, enIdx) : text;

  const sections = {};
  const tagCounts = {};
  const breakingSamples = [];
  let currentSection = 'other';
  let entryCount = 0;
  let breakingHits = 0;
  let sectionCount = 0;

  const BREAKING = /破坏性|BREAKING|需迁移|不再允许|已移除|移除(了|该)|改名|更名|minimum|最低|engines|协议\s*\d|必须同步升级/i;
  // 逐条内容分类（不看标题）
  const TAGGERS = [
    { id: 'breaking', re: BREAKING },
    { id: 'feature', re: /新增|支持|引入|add|support|introduc/i },
    { id: 'fix', re: /修复|修正|fix|bug/i },
    { id: 'improve', re: /优化|改进|提升|改善|improv|enhanc|better/i },
  ];

  for (const raw of part.split(/\r?\n/)) {
    const line = raw.trim();

    const h3 = /^<h3[^>]*>(.*?)<\/h3>/i.exec(line);
    if (h3) {
      sectionCount += 1;
      const title = h3[1];
      const hit = SECTION_PATTERNS.find((s) => s.re.test(title));
      currentSection = hit ? hit.id : 'other';
      sections[currentSection] = sections[currentSection] ?? 0;
      continue;
    }

    if (!line.startsWith('- ')) continue;
    entryCount += 1;
    sections[currentSection] = (sections[currentSection] ?? 0) + 1;

    const content = line.slice(2);
    const isBreaking = BREAKING.test(content);
    if (isBreaking) {
      breakingHits += 1;
      if (breakingSamples.length < 5) {
        breakingSamples.push(content.replace(/[*`<>]/g, '').slice(0, 140));
      }
    }

    // 一条可以同时命中多个标签，breaking 优先记
    let tagged = false;
    for (const t of TAGGERS) {
      if (t.re.test(content)) {
        tagCounts[t.id] = (tagCounts[t.id] ?? 0) + 1;
        if (t.id === 'breaking') tagged = true;
      }
    }
    if (!tagged && !TAGGERS.some((t) => t.id !== 'breaking' && t.re.test(content))) {
      tagCounts.other = (tagCounts.other ?? 0) + 1;
    }
  }

  return { sectionCount, entryCount, breakingHits, sections, tagCounts, breakingSamples };
}

/** 读本机 dsh 版本（判读要拿它当基准） */
export function readInstalledDshVersion(env = process.env) {
  const root = resolveDshRoot(env);
  return root?.version ?? null;
}

/** 读 AGINT 仓库自己的 tested 版本（VERSION 表首行，取 `dsh tested` 列） */
export function readAgintDshTested(repoRoot) {
  try {
    const txt = readFileSync(join(repoRoot, 'VERSION'), 'utf8');
    const line = txt.split(/\r?\n/).find((l) => /^\|\s*v\d/.test(l.trim()));
    if (!line) return null;
    const cells = line.split('|').map((c) => c.trim());
    // 列序：| AGINT | dsh minimum | dsh tested | notes |
    const tested = cells[3] ?? '';
    const m = /(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/i.exec(tested);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 段 1 主流程：产事实。
 *
 * @param {object} p
 * @param {object} p.signal      频道信号 payload（tag / versionTracks / body 需要另取）
 * @param {string} p.body        release 正文（判读器自己去 GitHub 取，或从信号缓存）
 * @param {string} p.repoRoot    AGINT 仓库根（扫依赖面用）
 * @param {object} [p.env]
 * @param {(repoRoot:string)=>Promise<Map>} [p.scanFace] 可注入（测试用）
 * @param {(args:object)=>Promise<object>} [p.probe]     可注入（测试用）
 */
export async function collectFacts({
  signal, body, repoRoot, env = process.env, scanFace, probe,
}) {
  const tag = String(signal?.tag ?? '');
  const targetVersion = normalizeTag(tag);
  const installed = readInstalledDshVersion(env);
  const agintTested = readAgintDshTested(repoRoot);

  const bodyInfo = parseReleaseBody(body);
  const level = (installed && targetVersion) ? classifyLevel(installed, targetVersion) : 'unknown';
  const stage = (installed && targetVersion) ? preStageChange(installed, targetVersion) : 'unknown';

  // ── 依赖面实测 ──
  const doScan = scanFace ?? scanDependencyFace;
  const doProbe = probe ?? probePackageApi;
  const face = await doScan(repoRoot);

  const depFace = [];
  for (const [pkg, rec] of face) {
    // 只测与 dsh 同版本的包：`@deepseek-ai/dsh-schedule` 这类跟随主版本，
    // 目标版本号一致才有意义。版本号对不上的（如第三方 @deepseek-ai/* 独立包）
    // 仍然测，但结果里 from/to 会体现出来，让读者自己判断。
    let probed;
    try {
      probed = await doProbe({ pkg, toVersion: targetVersion, usedNames: rec.imports, env });
    } catch (e) {
      probed = {
        pkg, from: null, to: targetVersion, verdict: 'unknown', usedImpact: 'none',
        evidence: [`实测异常：${e?.message ?? e}`],
        addedSymbols: [], removedSymbols: [], changedSignatures: [], widenedSignatures: [],
        baselineSuspect: true,
      };
    }
    depFace.push({
      pkg,
      usedCount: probed.usedCount ?? rec.imports.size,
      from: probed.from ?? null,
      to: probed.to ?? targetVersion,
      verdict: probed.verdict,
      usedImpact: probed.usedImpact ?? 'none',
      removedCount: probed.removedSymbols?.length ?? 0,
      narrowedCount: probed.changedSignatures?.length ?? 0,
      addedCount: probed.addedSymbols?.length ?? 0,
      widenedCount: probed.widenedSignatures?.length ?? 0,
      usedRemoved: (probed.usedRemoved ?? []).slice(0, 8),
      evidence: (probed.evidence ?? []).slice(0, 6),
      baselineSuspect: probed.baselineSuspect === true,
    });
  }

  const impactSummary = { breaking: 0, additive: 0, compatible: 0, elsewhere: 0, unknown: 0, none: 0 };
  for (const d of depFace) {
    const k = d.usedImpact === 'elsewhere' ? 'elsewhere' : d.usedImpact;
    impactSummary[k] = (impactSummary[k] ?? 0) + 1;
  }

  // ── 是否值得调模型 ──
  // 省 token 是次要的；主要目的是**避免给模型喂「什么也没发生」的材料**，
  // 那种输入最容易让模型编出一个结论来。
  const triggered = (
    impactSummary.breaking > 0
    || bodyInfo.breakingHits > 0
    || level === 'major' || level === 'minor'
    || stage === 'regressed'
    || depFace.some((d) => d.verdict === 'unknown')
  );

  return {
    tag,
    targetVersion,
    installedVersion: installed,
    agintTestedVersion: agintTested,
    level,
    preStageChange: stage,
    body: {
      sectionCount: bodyInfo.sectionCount,
      entryCount: bodyInfo.entryCount,
      sections: bodyInfo.sections,
      tagCounts: bodyInfo.tagCounts,
      breakingHits: bodyInfo.breakingHits,
      breakingSamples: bodyInfo.breakingSamples,
    },
    versionTracks: signal?.versionTracks ?? null,
    depFace,
    impactSummary,
    triggered,
    collectedAt: new Date().toISOString(),
  };
}

/**
 * 事实的一句话摘要（面板/日志/提案正文用）。
 *
 * ⛔ 只陈述数字，不加「严重」「建议」这类判断词 —— 判断在段 2。
 */
export function summarizeFacts(facts) {
  const parts = [];
  if (facts.installedVersion) parts.push(`本机 dsh ${facts.installedVersion}`);
  if (facts.targetVersion) parts.push(`目标 ${facts.targetVersion}（${facts.level}）`);
  if (facts.preStageChange === 'regressed') parts.push('发布阶段倒退');
  const tc = facts.body.tagCounts ?? {};
  const tagStr = Object.entries(tc).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join('/');
  parts.push(`变更 ${facts.body.entryCount} 条${tagStr ? `（${tagStr}）` : ''}，疑似破坏性 ${facts.body.breakingHits} 条`);
  const s = facts.impactSummary;
  parts.push(`依赖面：影响 AGINT ${s.breaking ?? 0} 个包、与他人相关 ${s.elsewhere ?? 0}、纯新增 ${s.additive ?? 0}、未测出 ${s.unknown ?? 0}`);
  return parts.join('；');
}
