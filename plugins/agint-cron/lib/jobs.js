/**
 * Default cron jobs for 智进. Each receives a `services` map of host services
 * it may call. Action failures are caught and logged; they never crash the
 * scheduler.
 *
 * Jobs (as of P4 / Sprint 14):
 *   memory-decay    Mon 02:30  L1-L4 遗忘扫描
 *   curator-weekly  Sun 02:00  技能策展（陈旧检测 + 归档，早于周复盘）
 *   wiki-lint       Sun 03:00  Wiki 健康检查（断链/矛盾/孤岛）
 *   metrics-collect daily 04:00 进化指标采集（时间序列）
 *   evolve-review   Sun 03:45  周复盘报告（数据快照 + 自动发现）
 *   curriculum-weekly Sun 05:00 自主课程：边界探测 → 待练域生成挑战
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
    schedule: '0 3 * * 0', // Sun 03:00
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
    id: 'evolve-review',
    name: '智进周复盘',
    schedule: '45 3 * * 0', // Sun 03:45
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
    // daily 04:45, idempotent (manifest 没变就不进 evo).
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
    // - weekly Sun 03:15（夹在 wiki-lint 03:00 与 evolve-review 03:45 之间）
    // - 调 `agint.evolve.recordBaselineRun({channel:'mount', passRate, passed, total})`
    //   把 passRate < 0.95 写为 frozen=true
    // - 不直接跑回归测试 —— 测试入口是 `eval/run-baseline-regression.mjs`；
    //   此 cron 仅作为"调度器接入点"，把"通道 frozen 状态"持久化到 storage。
    // - 默认 passRate=1.0 / passed=0 / total=0（占位行）；
    //   真实 passRate 由后续 Sprint 13 B4 接入回归 runner 注入（见 design Sprint12 §B3）。
    id: 'baseline-regression-suite',
    name: 'Baseline Regression 周检',
    schedule: '15 3 * * 0', // Sun 03:15
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
    // - daily 04:45（设计稿指定；与 prompt-static-check 同刻但两 job 独立互斥）
    // - 读 agint_tool_stats.jsonl 过去 24h → 任务实例聚合 → 模式检测 → 候选生成
    // - 插件未挂载时 soft-skip（不报错），便于先挂 cron 再挂 autocreate。
    id: 'skill-autocreate-aggregate',
    name: '技能自动创建聚合',
    schedule: '45 4 * * *',
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
    // - daily 05:15（聚合 04:45 之后，给新候选留出评估时间）
    // - 先 evaluateQueue 把 PENDING_EVAL 候选推进评估（接通评估桥，此前无自动驱动），
    //   再 releaseQueue 遍历 QUEUED_FOR_RELEASE / BUDGET_WAIT 候选走三道门自动发布；
    //   两步在同一 cron 内顺序执行 → detect → eval → release → observe 单日闭环。
    // - 人工确认窗内（默认关）全部被门 2 拦下——正好实现拍板 2
    // - 插件未挂载时 soft-skip
    id: 'skill-autocreate-release',
    name: '技能自动创建发布窗口',
    schedule: '15 5 * * *',
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
    // - daily 05:30（发布窗口之后）
    // - OBSERVING release 判定：STABLE（窗满+调用达标）/ 自动回滚（0 调用三重确认）
    //   / 展期一次 / 数据源失效顺延
    id: 'skill-autocreate-observe',
    name: '技能自动创建观察期滚动',
    schedule: '30 5 * * *',
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
    // P0-2 技能策展（Sprint 14 阶段 1）：每周策展。
    // - weekly Sun 02:00 —— 刻意排在 evolve-review(03:45) **之前**，让周复盘
    //   能吃到本周的策展报告（P0-2 §2.2 / §8.1 run_before_evolve_review）。
    //   注：Sprint14 设计稿 §3.5 写「周日 05:00」与其自述的「在 evolve-review
    //   之前」互相矛盾（05:00 晚于 03:45），此处按后者取 02:00。
    // - 插件未挂载时 soft-skip（不报错），便于先挂 cron 再挂 curator。
    // - 归档是破坏性操作：首次挂载建议先跑 curator_dry_run 看一遍。
    id: 'curator-weekly',
    name: '技能策展',
    schedule: '0 2 * * 0',
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
    // P7 自主课程生成器（Sprint 14 Part B）：每周生成挑战。
    // - weekly Sun 05:00 —— 排在周日全家桶（curator 02:00 / wiki-lint 03:00 /
    //   baseline-regression 03:15 / evolve-review 03:45）之后，不挤同时段。
    // - probe() 找待练域（UNCERTAIN / 校准失准 / CAN 超期未复验）→ 逐域
    //   generate({ count: 1 })。generate 自带同域 24h 冷却 + 批量上限 +
    //   无模板域诚实留白（unverifiable → skipped，不硬造）。
    // - 出队不自动执行（P7 §4.5）：挑战生成后躺着，由 agent 用
    //   curriculum_next 工具领取、真实执行后 curriculum_submit 提交。
    // - 插件未挂载 / paused 时 soft-skip（不报错），与 curator-weekly 同策略。
    id: 'curriculum-weekly',
    name: '自主课程生成',
    schedule: '0 5 * * 0', // Sun 05:00
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
    // - weekly Sun 07:00 —— 排进既有周日流水线
    //   （curator 02:00 / wiki-lint 03:00 / baseline 03:15 / evolve 03:45 /
    //    curriculum 05:00）之后的空档，不挤同时段。
    // - 聚合一律走周更，事件只做脏标记 + 状态同步（P2-2 §5.1「简洁 > 冗余」）。
    // - **count-only 标定期是默认档**：updateFull 只写 meta，正式表 0 行，
    //   返回 lastCalibration 告诉老板「若转 live 会得到多少节点/边」。
    //   未跑过标定期直接调 setMode('live') 会被拒绝（对齐 P2-1 不变量）。
    // - updateFull 永不 throw（fail-open）；未挂载时 soft-skip（不报错）。
    id: 'skill-graph-weekly',
    name: '技能图谱周更',
    schedule: '0 7 * * 0', // Sun 07:00
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