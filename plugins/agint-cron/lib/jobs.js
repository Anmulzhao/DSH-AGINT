/**
 * Default cron jobs for 智进. Each receives a `services` map of host services
 * it may call. Action failures are caught and logged; they never crash the
 * scheduler.
 *
 * Jobs (as of P4 / Sprint 14；排期于 2026-09-28 重排，见
 * docs/operations/cron-schedule-principles.md)：
 *   memory-decay    Mon 02:30  L1-L4 遗忘扫描
 *   night-dream     daily 03:00 梦境 sweep
 *   metrics-collect daily 04:00 进化指标采集（时间序列）
 *   tool-stats-backfill daily 04:30 D2 工具统计反向回填
 *   prompt-static-check daily 04:45 Prompt SDK 静态检查
 *   skill-autocreate-aggregate daily 05:15 技能候选聚合（LLM 密集）
 *   skill-autocreate-release   daily 05:45 评估桥 + 发布队列
 *   skill-autocreate-observe   daily 06:15 观察期滚动
 *   curator-weekly  Mon 07:00  技能策展（**必须早于 evolve-review**）
 *   evolve-review   Mon 07:30  周复盘报告（数据快照 + 自动发现）
 *   oracle-weekly   Mon 08:00  美谕周报
 *   wiki-lint       Mon 09:30  Wiki 健康检查（断链/矛盾/孤岛）
 *   evolution-cycle Tue 07:00  闭环引擎驱动（复盘之后第一波）
 *   baseline-regression-suite Tue 09:30 mount 通道 baseline 状态
 *   curriculum-weekly Thu 09:30 自主课程：边界探测 → 待练域生成挑战
 *   skill-graph-weekly Fri 09:30 技能图谱周更
 *   oracle-daily    daily 09:00 美谕晨报
 *   oracle-monthly  每月 1 日 10:00 美谕月报
 *   diagnosis-watchdog 每 30min 诊断域看门狗（表占用率 / 频率熔断是否被咬）
 *
 * 排期硬约束（由 test/schedule-layout.test.mjs 强制）：
 *   ① 任意两个 job 不得落在同一分钟（含 daily × weekly 交叉）
 *   ② 相邻触发间隔 ≥15 分钟；LLM 密集型之间 ≥30 分钟
 *   ③ curator-weekly 必须早于 evolve-review（周复盘要吃本周策展报告）
 */

import { parseCron, nextFire, lastFire } from './cron.js';

export const defaultJobs = [
  {
    id: 'memory-decay',
    name: '记忆遗忘扫描',
    schedule: '30 2 * * 1', // Mon 02:30
    description: 'L1-L4 衰减扫描 + 应用降级/清除（weekly）',
    action: async (services) => {
      const memory = services['agint.memory'];
      if (!memory) throw new Error('memory-decay: agint.memory not available');
      const result = await memory.decayScanRun({ apply: true });
      return result;
    },
  },
  {
    id: 'wiki-lint',
    name: 'Wiki 健康检查',
    // 2026-09-28 重排：周日 03:00 → 周一 09:30。
    // ① 原 03:00 与 night-dream（daily 03:00）同分钟撞车；
    // ② 挪到周一白天，lint 结果在老板在线时产出；
    // ③ 不可取周一 09:00 —— 那是 oracle-daily（daily 09:00）的固定位。
    schedule: '30 9 * * 1', // Mon 09:30
    description: '断链/矛盾/孤岛三项检查（weekly）',
    action: async (services) => {
      const wiki = services['agint.wiki'];
      if (!wiki) throw new Error('wiki-lint: agint.wiki not available');
      const report = await wiki.lint();
      return report;
    },
  },
  {
    id: 'metrics-collect',
    name: '进化指标采集',
    schedule: '0 4 * * *', // daily 04:00
    description: '采集 memory/wiki/cron/rules 健康指标写入时间序列（daily）',
    action: async (services) => {
      const metrics = services['agint.metrics'];
      if (!metrics) throw new Error('metrics-collect: agint.metrics not available');
      const result = await metrics.collect();
      return { count: result.count, collectedAt: result.collectedAt };
    },
  },
  {
    // P0-2 技能策展（Sprint 14 阶段 1）：每周策展。
    // - 2026-09-28 重排：Sun 02:00 → Mon 07:00 —— 仍刻意排在 evolve-review
    //   （现在周一 07:30）**之前**，让周复盘能吃到本周的策展报告
    //   （P0-2 §2.2 / §8.1 run_before_evolve_review）。
    // - 插件未挂载时 soft-skip（不报错），便于先挂 cron 再挂 curator。
    // - 归档是破坏性操作：首次挂载建议先跑 curator_dry_run 看一遍。
    //
    // ⛔⛔ 声明位置也是契约的一部分，不要挪动本块：
    // tick() 对到期 job 按 **声明顺序** 串行执行，所以「curator 早于 evolve-review」
    // 只在两种情况下都成立才叫成立 ——
    //   ① 正常排期：07:00 < 07:30（两个 tick，天然有序）；
    //   ② **同 tick 补跑**（宿主停机后重启，isDue 会把错过的一把全判 due）：
    //      此时排期时刻完全失效，谁先跑只由声明顺序决定。
    // 若把本块挪到 evolve-review 之后，补跑场景下周复盘就会读不到本周策展
    // 报告 —— 不报错，只是静默读到上周数据。test/schedule-layout.test.mjs
    // 对①②各有一条断言。
    id: 'curator-weekly',
    name: '技能策展',
    schedule: '0 7 * * 1',
    description: '扫描技能 → 聚合使用 → 状态转换 → 归档陈旧技能 → 写策展报告（weekly）',
    action: async (services) => {
      const curator = services['agint.curator'];
      if (!curator) return { skipped: true, reason: 'agint.curator not mounted' };
      const result = await curator.run({ trigger: 'cron:curator-weekly' });
      if (result.skipped) return { skipped: true, reason: result.reason };
      return {
        week: result.week,
        dryRun: result.dryRun,
        skillsScanned: result.skillsScanned,
        inference: result.inference,
        staled: result.applied?.staled?.length ?? 0,
        archived: result.applied?.archived?.length ?? 0,
        reactivated: result.applied?.reactivated?.length ?? 0,
      };
    },
  },
  {
    id: 'evolve-review',
    name: '智进周复盘',
    // 2026-09-28 重排：周日 03:45 → 周一 07:30。
    // ⛔ 必须晚于 curator-weekly（周一 07:00）—— 周复盘要吃本周策展报告
    // （P0-2 §2.2 / §8.1 run_before_evolve_review）。这条顺序契约由
    // test/schedule-layout.test.mjs 断言，调换会被测试拦下。
    schedule: '30 7 * * 1', // Mon 07:30
    description: '采集数据快照 → 自动发现 → 写入周复盘报告（weekly）',
    action: async (services) => {
      const evolve = services['agint.evolve'];
      if (!evolve) throw new Error('evolve-review: agint.evolve not available');
      const result = await evolve.writeReview({});
      return { path: result.path, findings: result.findings.length, collectedAt: result.snapshotCollectedAt };
    },
  },
  {
    id: 'night-dream',
    name: '夜间梦境',
    schedule: '0 3 * * *', // daily 03:00 — 与 OpenClaw dreaming 默认一致，处理近 2 天会话
    description: '读会话日志 → 提取候选 → 评分门槛 → 提升进记忆 + 写梦境日记（daily）',
    action: async (services) => {
      const dream = services['agint.dream'];
      if (!dream) throw new Error('night-dream: agint.dream not available');
      const result = await dream.sweep({ apply: true });
      return {
        day: result.day,
        sessions: result.counts.sessions,
        candidates: result.counts.candidates,
        gated: result.counts.gated,
        promoted: result.counts.promoted,
        diaryPath: result.diaryPath,
        errors: result.errors.length,
      };
    },
  },
  {
    // D2 工具统计 JSONL 反向回填：用 session log 给 agint_tool_stats.jsonl
    // 补 callTs/latencyMs/turn/step/sessionId（emit 事件不带这些字段）。
    // 每日 04:30（在 metrics-collect 之后跑），幂等可重复。
    id: 'tool-stats-backfill',
    name: 'D2 工具统计回填',
    schedule: '30 4 * * *',
    description: '用 session log 给 agint_tool_stats.jsonl 反向补 latencyMs/turn/step（daily）',
    action: async (services) => {
      const toolStats = services['agint.toolStats'];
      if (!toolStats) throw new Error('tool-stats-backfill: agint.toolStats not available');
      const result = await toolStats.backfill({});
      return {
        records: result.records,
        updated: result.updated,
        unmatched: result.unmatched,
        sessions: result.sessions,
      };
    },
  },
  {
    // Sprint 6.1: Prompt SDK 批量静态检查
    // - 扫描所有 prompt manifest.json + template.md
    // - 跑 staticCheckPrompt (注入 / 占位符 / manifest 不一致 三类)
    // - blocker → evo.addFailure(pattern='prompt-static:<code>', category='prompt')
    // daily 04:45 不变；2026-09-28 重排后 04:45 独占（原 skill-autocreate-aggregate
    // 已挪到 05:15），与上一个触发点 tool-stats-backfill(04:30) 间隔 15 分钟。
    id: 'prompt-static-check',
    name: 'Prompt 静态检查',
    schedule: '45 4 * * *',
    description: '扫所有 prompt manifest+template 跑静态检查; blocker → evo failure pattern',
    action: async (services) => {
      const sdk = services['agint.promptSDK'];
      const evo = services['agint.evolution'];
      if (!sdk) throw new Error('prompt-static-check: agint.promptSDK not available');

      // 默认扫描根目录: SDK examples + 任意 plugin 的 prompt 子树
      const manifestsRoots = services['agint.manifestsRoots'] ?? [
        // 由 host 装配时注入, fallback 走 SDK examples
      ];

      // dynamic import to avoid pulling zod into the cron module's startup chain
      const { batchStaticCheck, reportFailuresToEvo } = await import(
        '../../agint-quality-sdk/lib/check-all.js'
      );

      const batch = await batchStaticCheck({ manifestsRoots });
      const recorded = await reportFailuresToEvo({ batchReport: batch, evo });
      return {
        scanned: batch.totalScanned,
        clean: batch.cleanCount,
        blockers: batch.blockerCount,
        warnings: batch.warnCount,
        failurePatternsRecorded: recorded.length,
      };
    },
  },
  {
    // Sprint 12 B3: baseline-regression-suite 真 cron hook.
    // - 2026-09-28 重排：Sun 03:15 → Tue 09:30（去周日单点，落老板在线时段）。
    //   不可取 09:00 —— oracle-daily 的固定位。
    // - 调 `agint.evolve.recordBaselineRun({channel:'mount', passRate, passed, total})`
    //   把 passRate < 0.95 写为 frozen=true
    // - 不直接跑回归测试 —— 测试入口是 `eval/run-baseline-regression.mjs`；
    //   此 cron 仅作为"调度器接入点"，把"通道 frozen 状态"持久化到 storage。
    // - 默认 passRate=1.0 / passed=0 / total=0（占位行）；
    //   真实 passRate 由后续 Sprint 13 B4 接入回归 runner 注入（见 design Sprint12 §B3）。
    id: 'baseline-regression-suite',
    name: 'Baseline Regression 周检',
    schedule: '30 9 * * 2', // Tue 09:30
    description: '把 mount 通道 baseline-regression 状态写一行 baseline_history（weekly）',
    action: async (services) => {
      const evolve = services['agint.evolve'];
      if (!evolve) throw new Error('baseline-regression-suite: agint.evolve not available');
      // 注入 passRate 由 Sprint 13 B4 接入回归 runner（design Sprint12 §B3）；
      // 当前以"占位行"语义写一行，让 baseline_history 表与 baselineGate 链路先跑通。
      const recorded = await evolve.recordBaselineRun({
        channel: 'mount',
        passRate: 1.0,
        passed: 0,
        total: 0,
        source: 'cron:baseline-regression-suite',
      });
      return {
        id: recorded.id,
        channel: recorded.channel,
        passRate: recorded.passRate,
        frozen: recorded.frozen,
      };
    },
  },
  {
    // P0-1 技能自动创建：每日聚合（设计稿 §3.1 [2]，Sprint 14 检测层）。
    // 2026-09-28 重排：04:45 → 05:15。原时刻与 prompt-static-check（04:45）
    // 同分钟撞车（本 job 是 LLM 密集型，与静态检查挤同一 tick）。
    // - 读 agint_tool_stats.jsonl 过去 24h → 任务实例聚合 → 模式检测 → 候选生成
    // - 仍在 tool-stats-backfill（04:30）之后 —— 吃它补完的 latencyMs/turn/step。
    // - 插件未挂载时 soft-skip（不报错），便于先挂 cron 再挂 autocreate。
    id: 'skill-autocreate-aggregate',
    name: '技能自动创建聚合',
    schedule: '15 5 * * *',
    description: '聚合工具调用 → 检测重复任务模式 → 生成技能候选提案（daily）',
    action: async (services) => {
      const ac = services['agint.skillAutocreate'];
      if (!ac) return { skipped: true, reason: 'agint.skillAutocreate not mounted' };
      const result = await ac.detect({ triggerEvent: 'cron:skill-autocreate-aggregate' });
      return {
        skipped: result.skipped ?? false,
        records: result.records,
        tasks: result.tasks,
        patternsUpserted: result.patternsUpserted,
        newRepeatPatterns: result.newRepeatPatterns,
        candidatesCreated: result.candidatesCreated,
      };
    },
  },
  {
    // P0-1 发布层（Sprint 16 + B 修复 2026-09-13）：每日发布窗口检查。
    // - daily 05:45（聚合 05:15 之后，给新候选留出评估时间）
    // - 先 evaluateQueue 把 PENDING_EVAL 候选推进评估（接通评估桥，此前无自动驱动），
    //   再 releaseQueue 遍历 QUEUED_FOR_RELEASE / BUDGET_WAIT 候选走三道门自动发布；
    //   两步在同一 cron 内顺序执行 → detect → eval → release → observe 单日闭环。
    // - 人工确认窗内（默认关）全部被门 2 拦下——正好实现拍板 2
    // - 插件未挂载时 soft-skip
    id: 'skill-autocreate-release',
    name: '技能自动创建发布窗口',
    schedule: '45 5 * * *',
    description: '评估桥(evaluateQueue)+发布队列(releaseQueue)：开关/确认窗/policy/预算 → 原子挂载（daily）',
    action: async (services) => {
      const ac = services['agint.skillAutocreate'];
      if (!ac?.releaseQueue) return { skipped: true, reason: 'agint.skillAutocreate.releaseQueue not mounted' };
      // 评估桥：把待评估候选推进到 QUEUED_FOR_RELEASE（失败单条容错，不影响发布）
      const evalRes = ac.evaluateQueue ? await ac.evaluateQueue().catch((e) => ({ error: String(e?.message ?? e) })) : null;
      const result = await ac.releaseQueue();
      return {
        skipped: result.skipped ?? false,
        evaluated: evalRes?.attempted ?? null,
        evalQueued: evalRes?.queued ?? null,
        evalFailed: evalRes?.failed ?? null,
        attempted: result.attempted,
        released: result.released,
        held: (result.results ?? []).filter((r) => !r.released).length,
      };
    },
  },
  {
    // P0-1 发布层（Sprint 16）：每日观察期滚动。
    // - daily 06:15（发布窗口 05:45 之后）
    // - OBSERVING release 判定：STABLE（窗满+调用达标）/ 自动回滚（0 调用三重确认）
    //   / 展期一次 / 数据源失效顺延
    id: 'skill-autocreate-observe',
    name: '技能自动创建观察期滚动',
    schedule: '15 6 * * *',
    description: '观察期判定：STABLE / 0调用自动回滚 / 展期（daily）',
    action: async (services) => {
      const ac = services['agint.skillAutocreate'];
      if (!ac?.observe) return { skipped: true, reason: 'agint.skillAutocreate.observe not mounted' };
      const result = await ac.observe();
      return {
        observing: result.observing,
        stable: result.stable,
        rolledBack: result.rolledBack,
        postponed: result.postponed,
      };
    },
  },
  {
    // P7 自主课程生成器（Sprint 14 Part B）：每周生成挑战。
    // - 2026-09-28 重排：Sun 05:00 → Thu 09:30（去周日单点，分散到周中）。
    //   不可取 09:00 —— oracle-daily（daily 09:00）的固定位。
    // - probe() 找待练域（UNCERTAIN / 校准失准 / CAN 超期未复验）→ 逐域
    //   generate({ count: 1 })。generate 自带同域 24h 冷却 + 批量上限 +
    //   无模板域诚实留白（unverifiable → skipped，不硬造）。
    // - 出队不自动执行（P7 §4.5）：挑战生成后躺着，由 agent 用
    //   curriculum_next 工具领取、真实执行后 curriculum_submit 提交。
    // - 插件未挂载 / paused 时 soft-skip（不报错），与 curator-weekly 同策略。
    id: 'curriculum-weekly',
    name: '自主课程生成',
    schedule: '30 9 * * 4', // Thu 09:30
    description: '边界探测 → 对待练域逐一生成挑战（出队不自动执行）（weekly）',
    action: async (services) => {
      const curriculum = services['agint.curriculum'];
      if (!curriculum) return { skipped: true, reason: 'agint.curriculum not mounted' };
      const probed = await curriculum.probe();
      if (probed.skipped) return { skipped: true, reason: probed.reason };
      const domains = (probed.domains ?? []).map((d) => d.domain);
      const results = [];
      for (const domain of domains) {
        const gen = await curriculum.generate({ domain, count: 1 });
        results.push({
          domain,
          skipped: gen.skipped ?? false,
          reason: gen.reason ?? null,
          level: gen.level ?? null,
          count: (gen.generated ?? []).length,
        });
      }
      return {
        probedDomains: domains,
        unverifiable: (probed.unverifiable ?? []).map((d) => d.domain),
        generated: results.filter((r) => !r.skipped && r.count > 0).length,
        results,
      };
    },
  },
  {
    // P2-2 技能图谱周更（Sprint 20）：全量重算节点 + 四类边，并上报覆盖率。
    // - 2026-09-28 重排：Sun 07:00 → Fri 09:30（去周日单点，分散到周中）。
    //   不可取 09:00 —— oracle-daily（daily 09:00）的固定位。
    // - 聚合一律走周更，事件只做脏标记 + 状态同步（P2-2 §5.1「简洁 > 冗余」）。
    // - **count-only 标定期是默认档**：updateFull 只写 meta，正式表 0 行，
    //   返回 lastCalibration 告诉老板「若转 live 会得到多少节点/边」。
    //   未跑过标定期直接调 setMode('live') 会被拒绝（对齐 P2-1 不变量）。
    // - updateFull 永不 throw（fail-open）；未挂载时 soft-skip（不报错）。
    id: 'skill-graph-weekly',
    name: '技能图谱周更',
    schedule: '30 9 * * 5', // Fri 09:30
    description: '技能节点全量刷新 + 四类边重算 + 覆盖率上报（weekly，默认 count-only 标定期）',
    action: async (services) => {
      const graph = services['agint.skillGraph'];
      if (!graph) return { skipped: true, reason: 'agint.skillGraph not mounted' };
      const updated = await graph.updateFull({ trigger: 'cron:skill-graph-weekly' });
      if (updated.skipped) return { skipped: true, reason: updated.reason };
      const coverage = await graph.getCoverage();
      return {
        mode: updated.mode,
        nodes: updated.nodes,
        edgesAdded: updated.edgesAdded,
        edgesRemoved: updated.edgesRemoved,
        durationMs: updated.durationMs,
        // ⚠️ 两个口径必须分开报，不可混：
        //   persisted = 正式表里真实存在的（count-only 档恒为 0）
        //   projected = 若转 live 会得到什么（只出现在 lastCalibration）
        persisted: coverage.edgesByType,
        persistedHealth: coverage.health,
        coverage: coverage.coverage,
        projected: updated.edgesByType,
        // count-only 档的解锁凭证：promotable=true 才允许 setMode('live')
        calibration: updated.calibration ?? null,
        error: updated.error ?? null,
      };
    },
  },
  {
    // 诊断域看门狗（2026-09-26 事故后新增，每 30 分钟）。
    //
    // 背景：09-26 诊断报告自激环把 reports 表灌到 12,605 条（cap 50），而
    // **没有任何机制在逼近上限前示警** —— 环跑了 18 分钟才靠人肉发现日志刷屏。
    // 事后二修给 report() 加了频率熔断，但即便熔断真被咬，也只有登录翻日志才知道。
    // 本 job 把「诊断域有没有失控」变成一个每半小时可见的信号。
    //
    // 三条判据（全是绝对值 ⇒ **无需持久化历史**）：
    //   ① 表占用率：≥80% cap → WARN；≥cap → CRITICAL（守门本应已拦住新写入）
    //   ② reportRateGuard.trips > 0 → WARN ★ 「频率熔断真被咬过」的唯一直接证据
    //   ③ reportRateGuard.recent > max/2 → WARN（近一个窗口内调用密集）
    //
    // 异常一律 throw：throw 会走 runOne 的 catch ⇒ console.error 立即可见 +
    // cron_state.lastError 落盘 + cron_list 报 lastOk=false。看门狗本该安静，
    // 要响就响得能被看见（静默失败正是 09-26 事故的教训之一）。
    // 服务未挂载时 soft-skip（返回 skipped），与其它 job 同策略。
    //
    // ⏳ 待验证不改（2026-09-28 提案登记）：`*/30 * * * *` → `*/30 7-23 * * *`
    // （48→34 次/日，-29%）的前提是「深夜无人活动」。先观测 diagnosis annotations
    // 的产出时间分布，确认深夜确无会话活动后再改；否则夜间失控将失去唯一告警源。
    // 表达式本身已验证可被 parseCron 解析（`*/30` 分钟位 × `7-23` 小时位）。
    id: 'diagnosis-watchdog',
    name: '诊断域看门狗',
    schedule: '*/30 * * * *', // 每 30 分钟
    description: '巡检诊断各表占用率 + 频率熔断状态；逼近 cap / 熔断被咬 / 调用密集时告警（每 30 分钟）',
    action: async (services) => {
      const stats = services['agint.diagnosis.stats'];
      if (!stats) return { skipped: true, reason: 'agint.diagnosis.stats not available' };

      const s = await stats();
      const limits = s.limits ?? {};
      const guard = s.reportRateGuard ?? {};
      const WARN_RATIO = 0.8;
      const alerts = [];
      const usage = {};

      for (const [table, cap] of [
        ['annotations', limits.ANNOTATIONS],
        ['clusters', limits.CLUSTERS],
        ['reports', limits.REPORTS],
      ]) {
        const used = s[table];
        if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) continue;
        const ratio = used / cap;
        usage[table] = { used, cap, pct: Math.round(ratio * 100) };
        if (used >= cap) {
          alerts.push(`CRITICAL ${table} 表已满 ${used}/${cap}（守门本应已拦住新写入 ⇒ 守门失效）`);
        } else if (ratio >= WARN_RATIO) {
          alerts.push(`WARN ${table} 表逼近上限 ${used}/${cap}（${Math.round(ratio * 100)}%）`);
        }
      }

      if (Number.isFinite(guard.max) && guard.max > 0) {
        if (Number(guard.trips) > 0) {
          alerts.push(
            `WARN report() 频率熔断已被咬 ${guard.trips} 次（window ${guard.windowMs}ms / max ${guard.max}）` +
            ' —— 存在短窗口高频调用 report 的驱动方，去看日志里的「调用方栈」',
          );
        }
        if (Number(guard.recent) > guard.max * 0.5) {
          alerts.push(`WARN 近 ${guard.windowMs}ms 内 report 调用 ${guard.recent} 次（上限 ${guard.max}）`);
        }
      }

      const summary = { usage, reportRateGuard: guard, checkedAt: new Date().toISOString() };
      if (alerts.length) {
        // 先打详细指标（含各表 used/cap 与熔断计数），再 throw 让调度层记账。
        console.warn('[agint-cron:diagnosis-watchdog] ' + alerts.join(' ｜ ') + '\n  指标 ' + JSON.stringify(summary));
        throw new Error('diagnosis-watchdog: ' + alerts.join(' ｜ '));
      }
      return { alert: false, ...summary };
    },
  },
  {
    // 闭环引擎的驱动入口（2026-09-27 新增，配合新插件 agint-evolution-driver）。
    // mutator / population 挂载至今从未运行，根因不是接线，是**缺 caller**：
    // mutate 的内容（oldText→newText）必须有人提供，而它自己的红线是「不调真 LLM」。
    // driver 就是那个 caller —— 本 job 只负责「每周唤它一次」。
    //
    // 时机：2026-09-28 重排：Sun 04:15 → Tue 07:00。仍是「紧跟 evolve-review
    // （周一 07:30）之后的第一波」—— 复盘刚产出新提案，driver 才有东西可挑。
    // ⛔ 不可取 04:00 —— 那是 metrics-collect（daily 04:00）的固定位；
    //    提案原稿写的 `0 4 * * 3` 正是踩了这个坑（新引入一处同分钟撞车）。
    //
    // ⛔ 这个 job 不产生代码改动：driver 第一阶段的 commit 是默认关的
    // （AGINT_EVOLUTION_DRIVER_COMMIT=on 才开）。它只做「提案 → 变异候选 → 入种群」。
    // 服务未挂载时 soft-skip（与其它 job 同策略）—— driver 是软依赖插件，
    // 没挂它不代表 cron 出错。
    id: 'evolution-cycle',
    name: '闭环引擎驱动',
    schedule: '0 7 * * 2', // Tue 07:00
    description: '唤 agint-evolution-driver 跑一轮：提案 → LLM 构造原子编辑 → propose → ingest（weekly）',
    action: async (services) => {
      const driver = services['agint.evolutionDriver'];
      if (!driver) return { skipped: true, reason: 'agint.evolutionDriver not mounted' };
      const out = await driver.runOnce({});
      const status = typeof driver.status === 'function' ? driver.status() : {};
      return { ...out, status };
    },
  },
  {
    // 美的神谕层三档广播（2026-09-27 新增，配合新插件 agint-aesthetic-oracle，
    // 方案 v2.3 §5/§8 Day 1-2）。agint-metrics 之上的薄评论员：读 summary →
    // 评分 → 三问 → 广播；本插件只负责「按节奏唤它」，不碰任何数据面。
    //
    // 三档时刻与现有 job 无冲突（§7 错峰复核）：
    //   oracle-daily    0 9 * * *   daily 09:00（吃 04:00 metrics-collect 的数据，
    //                               广播首行如实标注 asOf，禁止反向触发采集）
    //   oracle-weekly   0 8 * * 1   weekly 周一 08:00（2026-09-28 重排：原周日
    //                               21:00 老板未必在，且把周报类都堆在周日；
    //                               挪到周一紧接 evolve-review 07:30 之后串读）
    //   oracle-monthly  0 10 1 * *  monthly 每月 1 日 10:00
    //
    // 自保全在服务侧（§6.2/§6.3）：runScheduled 内 3 次重试（1s/4s/16s 指数
    // 退避）+ 连续 3 次失败沉默 + 配额护栏 + kill-switch（config enabled:false
    // ⇒ 神谕层不 provide 服务 ⇒ 本三 job soft-skip，与 evolution-driver 同策略）。
    id: 'oracle-daily',
    name: '美谕晨报',
    schedule: '0 9 * * *', // daily 09:00
    description: '美的神谕层每日广播：读 metrics summary → 美总分 → 三问 → ≤5 行美评（daily）',
    action: async (services) => {
      const oracle = services['agint.aestheticOracle'];
      if (!oracle) return { skipped: true, reason: 'agint.aestheticOracle not mounted' };
      return oracle.runScheduled('daily');
    },
  },
  {
    id: 'oracle-weekly',
    name: '美谕周报',
    schedule: '0 8 * * 1', // Mon 08:00
    description: '美的神谕层每周广播：Q1 三问全量判定 + 周区间美评（weekly）',
    action: async (services) => {
      const oracle = services['agint.aestheticOracle'];
      if (!oracle) return { skipped: true, reason: 'agint.aestheticOracle not mounted' };
      return oracle.runScheduled('weekly');
    },
  },
  {
    id: 'oracle-monthly',
    name: '美谕月报',
    schedule: '0 10 1 * *', // 每月 1 日 10:00
    description: '美的神谕层每月广播：月度三问汇总 + 基线趋势（monthly）',
    action: async (services) => {
      const oracle = services['agint.aestheticOracle'];
      if (!oracle) return { skipped: true, reason: 'agint.aestheticOracle not mounted' };
      return oracle.runScheduled('monthly');
    },
  },
];

/** Validate and parse job schedules into parsed cron objects. */
export function compileJobs(jobs = defaultJobs) {
  return jobs.map((job) => {
    if (!job.id || !job.schedule || typeof job.action !== 'function') {
      throw new Error(`agint-cron: invalid job spec (id=${job.id})`);
    }
    return { ...job, parsed: parseCron(job.schedule) };
  });
}