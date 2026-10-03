/**
 * agint-evolve: pure report logic (no I/O, no service access).
 *
 * findingsFromSnapshot() turns a live data snapshot into a list of
 * auto-detected issues (stale cron jobs, wiki broken links / contradictions /
 * orphans, rule redundancy, memory bloat or low confidence, declining
 * metrics). buildReport() renders the weekly review markdown with the data
 * snapshot table, findings, proposal section, and the routing rules (教训→
 * memory / 方法→准则 / 知识→wiki) — the 复盘闭环 Phase 1 (挖掘) + Phase 2
 * (归类) skeleton. Phase 3 (提案) happens in the model via evolve_propose.
 */

/** One finding: level ok|info|warn, machine key, human message. */
export function findingsFromSnapshot(snapshot) {
  const out = [];
  const s = snapshot ?? {};

  // ---- cron: blind spots (the 21-day blind-spot accident guard) ----
  const cron = s.cron;
  if (cron && Array.isArray(cron.issues) && cron.issues.length > 0) {
    for (const issue of cron.issues) {
      out.push({ level: 'warn', key: 'cron.stale', message: `定时任务失效：${issue.id}（${issue.reason ?? '未知原因'}）` });
    }
  }

  // ---- wiki: knowledge health ----
  const wiki = s.wiki;
  if (wiki) {
    const broken = Array.isArray(wiki.brokenLinks) ? wiki.brokenLinks.length : 0;
    const contrad = Array.isArray(wiki.contradictions) ? wiki.contradictions.length : 0;
    const orphans = Array.isArray(wiki.orphans) ? wiki.orphans.length : 0;
    if (broken > 0) out.push({ level: 'warn', key: 'wiki.brokenLinks', message: `Wiki 有 ${broken} 个失效引用（断链）` });
    if (contrad > 0) out.push({ level: 'warn', key: 'wiki.contradictions', message: `Wiki 有 ${contrad} 个矛盾标记（⚠️）` });
    if (orphans > 0) out.push({ level: 'info', key: 'wiki.orphans', message: `Wiki 有 ${orphans} 个孤岛条目（未被引用，考虑合并或归档）` });
  }

  // ---- rules: adherence + redundancy ----
  const rules = s.rules;
  if (rules) {
    const totals = rules.totals ?? {};
    const hits = totals.hits ?? 0;
    const blocked = (totals.denies ?? 0) + (totals.asks ?? 0);
    if (Array.isArray(rules.lintIssues) && rules.lintIssues.length > 0) {
      out.push({ level: 'warn', key: 'rules.lint', message: `规则表有 ${rules.lintIssues.length} 个冗余/失效项（重复或非法 pattern）` });
    }
    if (hits > 0 && blocked > 0) {
      out.push({ level: 'info', key: 'rules.blocked', message: `门禁拦截/询问 ${blocked}/${hits} 次（遵守率 ${Math.round(((hits - blocked) / hits) * 100)}%）` });
    } else if (hits === 0) {
      out.push({ level: 'info', key: 'rules.noActivity', message: '本期无门禁活动（hits=0）——规则可能形同虚设，或本期没有危险操作' });
    }
  }

  // ---- memory: scale + confidence ----
  const memory = s.memory;
  if (memory) {
    if ((memory.total ?? 0) > 50) {
      out.push({ level: 'info', key: 'memory.bloat', message: `记忆 ${memory.total} 条——超过 50 条阈值，建议运行 memory_forget_scan` });
    }
    if (typeof memory.avgConfidence === 'number' && memory.avgConfidence < 0.4) {
      out.push({ level: 'warn', key: 'memory.confidence', message: `记忆平均置信度 ${memory.avgConfidence} < 0.4——大量低置信度条目，考虑清理或降级` });
    }
  }

  // ---- input gateway: external signals + security (v0.7.2) ----
  const ig = s.inputGateway;
  if (ig) {
    const channels = Array.isArray(ig.channels) ? ig.channels : [];
    for (const ch of channels) {
      const emitted = ch.counters?.signalsEmitted ?? 0;
      const fetched = ch.counters?.fetchCount ?? 0;
      if (fetched >= 2 && emitted === 0 && ch.enabled) {
        out.push({
          level: 'info',
          key: 'gateway.silent.' + ch.channelId,
          message: '输入网关 ' + ch.channelId + ' 已采集 ' + fetched + ' 次但从未产出信号——上游链可能空转（如 diagnosis 无聚类 / curriculum 无待练域）',
        });
      }
    }
    const sec = ig.security;
    if (sec && typeof sec.ruleCount === 'number' && sec.ruleCount > 0) {
      const flagged = channels.reduce((acc, c) => acc + (c.counters?.securityFlagged ?? 0), 0);
      const dropped = channels.reduce((acc, c) => acc + (c.counters?.securityDropped ?? 0), 0);
      if (flagged > 0 || dropped > 0) {
        out.push({
          level: 'warn',
          key: 'gateway.security',
          message: '外部信号 prompt injection 命中 ' + flagged + ' 条 / 丢弃 ' + dropped + ' 条（安全门禁 action=' + (sec.action ?? '-') + '）',
        });
      }
    }
  }

  // ---- metrics trends (when a metrics summary exists) ----
  const metrics = s.metrics;
  if (metrics && Array.isArray(metrics.metrics)) {
    for (const m of metrics.metrics) {
      if (typeof m.delta === 'number' && m.delta > 0) {
        // Positive delta on count metrics = deterioration; on adherencePct it is improvement.
        const worsening = m.key !== 'rules.adherencePct';
        if (worsening) {
          out.push({ level: 'warn', key: `trend.${m.key}`, message: `指标 ${m.key} 较上次恶化 +${m.delta}（当前 ${m.value}）` });
        }
      }
    }
  }

  // ---- eval 存量 FAIL 归因（A4 / 路线图 1.4）----
  // ⛔ 这里只报「有没有归因盲区」和「有没有真缺陷」，不报「fail 数减少」
  //   （fail 数变化是 driver 口径问题，误报会让人以为产品在变好）。
  const ev = s.evalFailAttribution;
  if (ev) {
    const unattr = ev.byCategory?.NOT_ATTRIBUTED ?? 0;
    if (unattr > 0) {
      out.push({
        level: 'warn',
        key: 'eval.fail.unattributed',
        message: `eval 存量 ${ev.total} 条 FAIL 里有 ${unattr} 条未归因 —— 归因盲区会让修法选错（改场景 vs 改代码）`,
      });
    }
    const defects = ev.byCategory?.REAL_DEFECT ?? 0;
    if (defects > 0) {
      out.push({
        level: 'warn',
        key: 'eval.fail.realDefect',
        message: `eval 有 ${defects} 条 REAL_DEFECT —— 被测代码不满足场景契约，须改产品代码并过门禁`,
      });
    }
    if (typeof ev.coverageMin === 'number' && typeof ev.coverage === 'number' && ev.coverage < ev.coverageMin) {
      out.push({
        level: 'warn',
        key: 'eval.fail.coverage',
        message: `eval FAIL 归因覆盖率 ${(ev.coverage * 100).toFixed(1)}% < 阈值 ${(ev.coverageMin * 100).toFixed(0)}%`,
      });
    }
  }

  if (out.length === 0) out.push({ level: 'ok', key: 'all.healthy', message: '未发现明显问题' });
  return out;
}

/** Row of the snapshot table: [域, 值描述]. */
function snapshotRow(key, value) {
  return `| ${key} | ${value} |`;
}

function renderSnapshotTable(s) {
  const rows = [];
  if (s.memory) {
    const m = s.memory;
    const byType = m.byType ?? {};
    rows.push(snapshotRow('记忆', `${m.total ?? 0} 条（教训 ${byType.lesson ?? 0} / 决策 ${byType.decision ?? 0} / 偏好 ${byType.preference ?? 0} / 规律 ${byType.pattern ?? 0}），平均置信度 ${m.avgConfidence ?? '-'}`));
  }
  if (s.wiki) {
    const w = s.wiki;
    rows.push(snapshotRow('Wiki', `${w.checked ?? 0} 个文件；断链 ${(w.brokenLinks ?? []).length} / 矛盾 ${(w.contradictions ?? []).length} / 孤岛 ${(w.orphans ?? []).length}`));
  }
  if (s.cron) {
    const c = s.cron;
    rows.push(snapshotRow('Cron', `${(c.jobs ?? []).length} 个任务；失效 ${(c.issues ?? []).length}`));
  }
  if (s.rules) {
    const r = s.rules;
    const totals = r.totals ?? {};
    const hits = totals.hits ?? 0;
    const blocked = (totals.denies ?? 0) + (totals.asks ?? 0);
    rows.push(snapshotRow('规则门禁', `命中 ${hits} 次，拦截/询问 ${blocked} 次${hits > 0 ? `，遵守率 ${Math.round(((hits - blocked) / hits) * 100)}%` : ''}；冗余/失效 ${(r.lintIssues ?? []).length}`));
  }
  if (s.metrics) {
    rows.push(snapshotRow('指标', `${s.metrics.count ?? 0} 项已采集（用 metrics_summary 看明细）`));
    // Sprint 12 / A10 — 周复盘模板新增两行：eventBus 死信率 + sync 订阅数
    const mList = Array.isArray(s.metrics.metrics) ? s.metrics.metrics : [];
    const sync = mList.find((m) => m.key === 'eventBus.syncSubscriptions');
    const dlRate = mList.find((m) => m.key === 'eventBus.deadletterRate');
    if (sync && sync.value !== undefined) {
      rows.push(snapshotRow('Event Bus sync 订阅数', `${sync.value} 个（上限 3）`));
    }
    if (dlRate && dlRate.value !== undefined) {
      let meta = '';
      try { const p = JSON.parse(dlRate.meta || '{}'); meta = `（死信 ${p.deadletterCount ?? 0} / 发布 ${p.publishedCount ?? 0}）`; } catch { /* ignore */ }
      rows.push(snapshotRow('Event Bus 死信率', `${dlRate.value}%${meta}`));
    }
  }
  if (s.sessions) {
    rows.push(snapshotRow('会话', s.sessions.count !== undefined ? `${s.sessions.count} 个历史会话` : '（sessionQuery 未接入）'));
  }
  // ── A4：eval 存量 FAIL 归因（固定章节的数据行）────────────────────
  // ⛔ 三态诚实：没采到 ≠ 0 个 fail。缺席时整行不印，不印「0 个」。
  if (s.evalFailAttribution) {
    const e = s.evalFailAttribution;
    const cov = e.coverage === null || e.coverage === undefined
      ? 'N/A'
      : `${(e.coverage * 100).toFixed(1)}%`;
    rows.push(snapshotRow(
      'eval 存量 FAIL 归因',
      `${e.total} 条 FAIL，已归因 ${e.attributed} 条（覆盖率 ${cov}）`
      + `；ASSERT_DRIFT ${e.byCategory?.ASSERT_DRIFT ?? 0} / HARNESS_GAP ${e.byCategory?.HARNESS_GAP ?? 0}`
      + ` / REAL_DEFECT ${e.byCategory?.REAL_DEFECT ?? 0} / NOT_ATTRIBUTED ${e.byCategory?.NOT_ATTRIBUTED ?? 0}`,
    ));
  }
  if (s.inputGateway) {
    const ig = s.inputGateway;
    const chs = Array.isArray(ig.channels) ? ig.channels : [];
    const emitted = chs.reduce((acc, c) => acc + (c.counters?.signalsEmitted ?? 0), 0);
    const flagged = chs.reduce((acc, c) => acc + (c.counters?.securityFlagged ?? 0), 0);
    const sec = ig.security ?? {};
    rows.push(snapshotRow('外部信号', chs.length + ' 个 Channel，累计产出 ' + emitted + ' 条信号；security 命中 ' + flagged + ' 条（action=' + (sec.action ?? '-') + '，' + (sec.ruleCount ?? 0) + ' 条规则）'));
  }
  if (rows.length === 0) rows.push(snapshotRow('数据源', '全部不可用——检查 host 服务是否已挂载'));
  return rows.join('\n');
}

/**
 * 渲染 eval 存量 FAIL 归因固定章节（A4）。
 *
 * ⛔ 三态诚实（K 纪律）：
 *   - 数据源缺席 ⇒ 印「本周未采到」，**不印「0 个 FAIL」**
 *     （「没查」与「没有」在报告里长得一样，但含义相反）
 *   - 采到了 0 个 FAIL ⇒ 明说「0 个 FAIL（driver 全绿）」并提示「无内容可归因」
 *   - 归因盲区 / REAL_DEFECT 明写出来，不藏在总数里
 *
 * @param {string[]} lines
 * @param {object|null|undefined} e snapshot.evalFailAttribution
 */
export function renderEvalFailAttribution(lines, e, opts = {}) {
  if (!e) {
    // ⛔ 2026-10-04：区分「路径没解析出来」与「没采到数据」。
    //   部署位（~/.dsh/.agint-bundle/plugins/…）的祖先目录里没有 eval/ ⇒ 自动探测
    //   解析不出仓库根。这时报「未采到」会把运维引去查归因脚本，而真因是路径没解析出来。
    if (opts.pathUnresolved) {
      lines.push('- ⛔ **归因路径未解析**：本插件不在仓库布局内，向上找不到含 `eval/` 的目录。');
      lines.push('  这**不是**「0 个 FAIL」，也**不是**「本周没跑归因」—— 是插件根本没拿到产物路径。');
      lines.push('  修法二选一：');
      lines.push('  1. 在 `cordis.patch.yml` 的 `agint-evolve` 行显式给 `evalAttributionPath`（指向仓库的 `eval/attribution/fail-attribution.json`）；');
      lines.push('  2. 把 `eval/attribution/fail-attribution.json` 放到部署位可解析到的位置。');
      lines.push('  改完需重启宿主（boot 期配置）。');
      return;
    }
    lines.push('- 本周未采到 eval 归因数据（`agint-evolve` 未读到 `evalFailAttribution` 快照项）。');
    lines.push('  ⛔ 这不等于「0 个 FAIL」—— 没采到与没有，两回事。');
    lines.push('  补齐方式：让 `bin/attribute-eval-fails.mjs` 出 JSON，接进 `dataSnapshot()`。');
    return;
  }

  // ⛔ parseError 必须在任何 `?? 0` 之前短路。
  //   否则「产物坏了」会被 `total ?? 0` 吞成「0 个 FAIL」——
  //   那正是本节存在的理由要防的那类静默降级（K：空数据≠0）。
  if (e.parseError) {
    lines.push(`- ⛔ 归因产物解析失败：\`${e.parseError}\``);
    lines.push('  本章数据**不可信**，不许按 0 个 FAIL 读。请重跑 `bin/attribute-eval-fails.mjs --json` 后重试。');
    return;
  }

  const total = e.total ?? 0;
  const attributed = e.attributed ?? 0;
  const cov = typeof e.coverage === 'number' ? `${(e.coverage * 100).toFixed(1)}%` : 'N/A';
  const covMin = typeof e.coverageMin === 'number' ? `${(e.coverageMin * 100).toFixed(0)}%` : '未设阈值';
  lines.push(`- FAIL **${total}** 条，已归因 **${attributed}** 条，覆盖率 **${cov}**（阈值 ${covMin}）`);

  if (total === 0) {
    lines.push('  - driver 本轮 0 个 FAIL ⇒ **无内容可归因**。这与「没跑」不同，driver 口径见 §一。');
    return;
  }

  if (e.parseError) {
    lines.push(`> ⛔ 归因产物解析失败：\`${e.parseError}\` ⇒ 本章数据不可信，请重跑 \`bin/attribute-eval-fails.mjs --json\`。`);
    return;
  }
  const cat = e.byCategory ?? {};
  lines.push('');
  lines.push('| 根因类 | 条数 | 该改什么 |');
  lines.push('|---|---|---|');
  lines.push(`| ASSERT_DRIFT（断言漂移） | ${cat.ASSERT_DRIFT ?? 0} | 改场景期望 |`);
  lines.push(`| HARNESS_GAP（评估基建缺口） | ${cat.HARNESS_GAP ?? 0} | 改 driver mock/派发 |`);
  lines.push(`| REAL_DEFECT（真产品缺陷） | ${cat.REAL_DEFECT ?? 0} | 改产品代码 + 过门禁 |`);
  lines.push(`| NOT_ATTRIBUTED（未归因） | ${cat.NOT_ATTRIBUTED ?? 0} | 人工取证 |`);
  lines.push('');
  if ((cat.NOT_ATTRIBUTED ?? 0) > 0) {
    lines.push(`> ⚠️ **${cat.NOT_ATTRIBUTED} 条未归因** —— 归因盲区。错类会把修法引到反方向（改场景 vs 改代码），不许猜。`);
  }
  if ((cat.REAL_DEFECT ?? 0) > 0) {
    lines.push(`> ⚠️ **${cat.REAL_DEFECT} 条 REAL_DEFECT** —— 被测代码不满足场景契约，这是产品缺陷，须过门禁 + 实测。`);
  }
  if (Array.isArray(e.unattributedUnitIds) && e.unattributedUnitIds.length > 0) {
    lines.push(`> 未归因单元：${e.unattributedUnitIds.map((x) => '`' + x + '`').join(' · ')}`);
  }
  lines.push('> ⛔ 本章**不许**为了让 driver 全绿而放宽判据 —— 下一次真回归会被一起放过。');
  lines.push('> 完整证据链见 `docs/operations/eval-fail-attribution-<日期>.md`（由 `bin/attribute-eval-fails.mjs` 生成）。');
}

/**
 * Render the weekly review markdown.
 * @param {{date: string, snapshot: object, findings: Array, notes?: string}} input
 * @returns {string} markdown
 */
export function buildReport({ date, snapshot, findings, notes }) {
  const d = String(date ?? new Date().toISOString().slice(0, 10));
  const collectedAt = snapshot?.collectedAt ? String(snapshot.collectedAt) : new Date().toISOString();
  const lines = [];
  lines.push(`# 智进周复盘 ${d}`);
  lines.push('');
  lines.push(`> 自动生成于 ${collectedAt}｜数据源：agint-memory / agint-wiki / agint-cron / agint-rules / agint-metrics / agint-input-gateway`);
  lines.push('');
  lines.push('## 一、数据快照');
  lines.push('');
  lines.push('| 域 | 关键值 |');
  lines.push('|---|---|');
  lines.push(renderSnapshotTable(snapshot ?? {}));
  lines.push('');
  lines.push('## 二、自动发现');
  lines.push('');
  if (findings.length === 0) {
    lines.push('- 未发现明显问题');
  } else {
    for (const f of findings) {
      const icon = f.level === 'warn' ? '⚠️' : f.level === 'info' ? 'ℹ️' : '✅';
      lines.push(`- ${icon} [${f.key}] ${f.message}`);
    }
  }
  lines.push('');
  lines.push('## 二·B、eval 存量 FAIL 归因（A4 固定章节）');
  lines.push('');
  renderEvalFailAttribution(lines, snapshot?.evalFailAttribution, {
    pathUnresolved: snapshot?.evalFailAttributionUnresolved === true,
  });
  lines.push('');
  lines.push('## 二·A、外部信号与多源输入');
  lines.push('');
  const ig = snapshot?.inputGateway;
  if (ig && Array.isArray(ig.channels) && ig.channels.length > 0) {
    lines.push('| Channel | 类型 | 状态 | 采集 | 产出 | 过滤 | security |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const ch of ig.channels) {
      const c = ch.counters ?? {};
      lines.push('| ' + ch.channelId + ' | ' + ch.channelType + ' | ' + (ch.enabled ? '开' : '关') + ' | ' + (c.fetchCount ?? 0) + ' | ' + (c.signalsEmitted ?? 0) + ' | ' + (c.signalsFiltered ?? 0) + '（去重 ' + (c.signalsDeduplicated ?? 0) + '） | 命中 ' + (c.securityFlagged ?? 0) + ' / 丢 ' + (c.securityDropped ?? 0) + ' |');
    }
    const sec = ig.security ?? {};
    lines.push('');
    lines.push('> 门禁 action=' + (sec.action ?? '-') + '，规则 ' + (sec.ruleCount ?? 0) + ' 条，检查范围 ' + (Array.isArray(sec.checkedTypes) ? sec.checkedTypes.join(' / ') : '-') + '；命中信号附 security 元数据供下游复核。');
  } else {
    lines.push('- 输入网关未挂载或不可用（agint-input-gateway 未提供 getStatus）。');
  }
  lines.push('');
  lines.push('## 三、改进提案');
  lines.push('');
  lines.push('> 用 evolve_propose 在此追加提案（category: rule / skill / doc / preset / service / plugin / other），' +
    '状态用 evolve_set_status 跟踪（proposed → applied / rejected）。');
  lines.push('');
  if (notes && String(notes).trim() !== '') {
    lines.push('## 四、备注');
    lines.push('');
    lines.push(String(notes).trim());
    lines.push('');
  }
  lines.push('## 五、哲学对齐检查');
  lines.push('');
  lines.push('> v0.2 起强制：每个复盘报告必须有本节（AGENTS.md 边界 + 路线图 §哲学锚点护栏硬要求）。详见 `docs/evolution-philosophy-checkpoints.md` 第四章。');
  lines.push('');
  lines.push('逐条对照哲学锚点（简洁 / 安全 / 真实 / 靠谱 / 主动）：');
  lines.push('- **简洁**：本期是否新增了同义工具 / 重复规则 / 冗余文档？');
  lines.push('- **安全**：本期落地的写工具是否走 D-QAF + ask 门禁？有无越权数据读取？');
  lines.push('- **真实**：本期复盘结论是否带文件:行号引用？数值与快照表一致？');
  lines.push('- **靠谱**：本期 owner 关闭的 ticket / 提案是否真有 commit + test 通过？');
  lines.push('- **主动**：本期是否发现 ≥1 个潜在隐患并自动起 proposal？');
  lines.push('');
  lines.push('收口结论（填一行）：本期哲学对齐度 = ⭕全过 / ⚠️N 项偏离（详述）。');
  lines.push('');
  lines.push('## 路由规范（复盘产出去向）');
  lines.push('');
  lines.push('- 教训（不可再做）→ agint-memory，type=lesson，必须带 evidence');
  lines.push('- 决策（如何取舍）→ agint-memory，type=decision');
  lines.push('- 方法/准则（可复用流程）→ 准则段落（AGENTS/agent-instructions）');
  lines.push('- 知识（领域事实）→ agint-wiki');
  lines.push('- 未采集指标（谄媚率/任务步数中位数）→ 需 session 日志挖掘，留待 evolve Phase 1 扩展');
  lines.push('');
  return lines.join('\n');
}
