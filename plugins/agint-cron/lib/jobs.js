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
 *   ledger-anchor   Mon 10:15  Evolution Ledger 外部锚定（git commit，⛔ 不 push）
 *   evolution-cycle Tue 07:00  闭环引擎驱动（复盘之后第一波）
 *   baseline-regression-suite Tue 09:30 mount 通道 baseline 状态
 *   curriculum-weekly Thu 09:30 自主课程：边界探测 → 待练域生成挑战
 *   skill-graph-weekly Fri 09:30 技能图谱周更
 *   oracle-daily    daily 09:00 美谕晨报
 *   oracle-monthly  每月 1 日 10:00 美谕月报
 *   diagnosis-watchdog 每 30min 诊断域看门狗（表占用率 / 频率熔断是否被咬）
 *   input-gateway-watchdog daily 06:00 输入网关四通道采集活性看门狗（补网关自带调度器的盲区）
 *   memory-provider-health daily 08:30 记忆 provider 定期健康检查（阶段 3）
 *   spec-index-refresh 每月 1 日 10:30 协议索引只读巡检（Phase-3 轨道 C）
 *   evolution-reconcile Tue 08:00 闭环取数三方对账（evolution-cycle 之后；Phase -1.1）
 *   outcome-measure   Tue 10:15 进化实测对账：双态跑改动面测试子集量 actualDelta（Phase 1.1 支点 1b）
 *
 * 排期硬约束（由 test/schedule-layout.test.mjs 强制）：
 *   ① 任意两个 job 不得落在同一分钟（含 daily × weekly 交叉）
 *   ② 相邻触发间隔 ≥15 分钟；LLM 密集型之间 ≥30 分钟
 *   ③ curator-weekly 必须早于 evolve-review（周复盘要吃本周策展报告）
 */

import { parseCron, nextFire, lastFire } from './cron.js';
import { auditSpecIndex } from './spec-index-audit.js';
import { auditEvolutionReconcile } from './evolution-reconcile-audit.js';

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
    id: 'ledger-anchor',
    name: 'Ledger 外部锚定',
    // Mon 10:15：排在 evolve-review(07:30) 与 wiki-lint(09:30) 之后、且与
    // oracle-monthly(每月 1 日 10:00) 留足 15 分钟 —— 由 schedule-layout 门禁校验。
    schedule: '15 10 * * 1', // Mon 10:15
    description: '把 evolution_ledger 链头写入 docs 锚点文件并本地提交（§4.4.2；⛔ 不 push）',
    action: async (services) => {
      const evo = services['agint.evolution'];
      if (!evo?.ledger?.anchor) throw new Error('ledger-anchor: agint.evolution.ledger.anchor not available');
      const result = await evo.ledger.anchor();
      // 空链是正常状态（还没有进化入链），不算失败；其余 anchored:false 都要出声。
      if (!result.anchored && result.code !== 'LEDGER_EMPTY') {
        throw new Error(`ledger-anchor: 锚定未完成（${result.code}）${result.detail ? ` —— ${result.detail}` : ''}`);
      }
      return result;
    },
  },
  {
    id: 'frozen-anchor',
    name: 'Frozen 基准集锚定',
    // Mon 10:30：紧随 ledger-anchor(10:15)，语义相邻（都是「把仓库侧事实锚进宿主存储」）。
    // 排期门禁 test/schedule-layout.test.mjs 实测该位满足 ≥15 分间隔（原则②）。
    //
    // ⛔⛔ 为什么必须有这个 job（2026-10-04 取证）：
    //   `agint.evolution.recordFrozenSet` 只能**在宿主内**调 —— dsh 把整个存储域读进内存、
    //   每次 put 用内存态整体重写文件（last-write-wins），独立进程直写会被静默覆盖。
    //   而宿主侧**没有任何现成入口**能调它（已穷举）：
    //     · `/api/` RPC 通道：404（那是 platform 层，宿主服务不走它）
    //     · `agint-evolution-memory/lib/tools.js`：11 个工具全是 log/failure/template 族，
    //       **没有 frozen 工具**（preset 只挂了它，等于没挂）
    //   ⇒ cron job 的 `action(services)` 是唯一在宿主内执行的入口
    //   （先例：ledger-anchor 调 `agint.evolution.ledger.anchor`）。
    schedule: '30 10 * * 1', // Mon 10:30
    description: '读仓库侧 tiering 清单，入账一条 Frozen 基准集快照（只增不改）',
    action: async (services) => {
      const evo = services['agint.evolution'];
      if (!evo?.recordFrozenSet) throw new Error('frozen-anchor: agint.evolution.recordFrozenSet not available');
      // ⛔ repoRoot 未配时必须**显式失败**，不能静默跳过 ——
      //   「没配」与「没有变更」是两件事，混起来等于入账 job 看着成功其实没干活。
      const repoRoot = services['agint.repoRoot'];
      if (!repoRoot) {
        throw new Error('frozen-anchor: agint.repoRoot 未配置（cordis.patch.yml 的 agint-cron 行'
          + ' 需给 repoRoot）—— 无法读仓库侧清单，拒不入账');
      }

      // 聚合 hash 与名单**从仓库侧算**（唯一真源在 eval/；部署位没有 eval/）。
      // 复用 anchor-frozen-set.mjs 的判据层，避免「job 里的算法」与「脚本里的算法」两套口径。
      const { computeFrozenEntry } = await import('./frozen-anchor-core.js');
      const entry = await computeFrozenEntry({ repoRoot });

      // 已入账过同一份快照 ⇒ 不重复写（record() 对同 setId 会抛 frozen-set-already-exists，
      // 而 setId 含毫秒时间戳 ⇒ 每次 cron 跑都是新 id ⇒ 会在表里堆重复行）。
      const list = typeof evo.listFrozenSets === 'function' ? await evo.listFrozenSets() : null;
      if (Array.isArray(list)) {
        const dup = list.find((e) => e?.frozenAggregateHash === entry.frozenAggregateHash);
        if (dup) {
          return { recorded: false, reason: 'already-anchored', setId: dup.setId, ...entry };
        }
      }

      const written = await evo.recordFrozenSet({ ...entry, source: 'cron/frozen-anchor' });
      return { recorded: true, setId: written?.setId ?? null, ...entry };
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
      // 2026-10-05（老板裁定第 3 项）：告警分两级。
      //   warnings = 提示（逼近 80% / 熔断被咬）⇒ 只记不抛，job 仍算成功。
      //   criticals = 故障（表已满 = 守门失效）⇒ 抛，让调度层记failed。
      // 此前两级混在 `alerts` 里一起抛 ⇒ 纯观测任务因「逼近上限」被记 failed，污染 cron 状态。
      const warnings = [];
      const criticals = [];
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
          criticals.push(`CRITICAL ${table} 表已满 ${used}/${cap}（守门本应已拦住新写入 ⇒ 守门失效）`);
        } else if (ratio >= WARN_RATIO) {
          warnings.push(`WARN ${table} 表逼近上限 ${used}/${cap}（${Math.round(ratio * 100)}%）`);
        }
      }

      if (Number.isFinite(guard.max) && guard.max > 0) {
        if (Number(guard.trips) > 0) {
          warnings.push(
            `WARN report() 频率熔断已被咬 ${guard.trips} 次（window ${guard.windowMs}ms / max ${guard.max}）` +
            ' —— 存在短窗口高频调用 report 的驱动方，去看日志里的「调用方栈」',
          );
        }
        if (Number(guard.recent) > guard.max * 0.5) {
          warnings.push(`WARN 近 ${guard.windowMs}ms 内 report 调用 ${guard.recent} 次（上限 ${guard.max}）`);
        }
      }

      const summary = {
        usage,
        reportRateGuard: guard,
        checkedAt: new Date().toISOString(),
        warningCount: warnings.length,
        criticalCount: criticals.length,
      };
      if (warnings.length) {
        // WARN 只记不抛（2026-10-05 老板裁定第 3 项）。
        // 理由：watchdog 是**纯观测任务**，「逼近上限 80%」是提示不是故障；
        // 抛错会让调度层把本job 记成 failed，污染 cron 状态并掩盖真正的 CRITICAL。
        console.warn('[agint-cron:diagnosis-watchdog] ' + warnings.join(' ｜ ') + '\n  指标 ' + JSON.stringify(summary));
      }
      // 只有 CRITICAL 才抛：表已满 = 守门失效，是真故障，必须让调度层知道。
      if (criticals.length) {
        console.warn('[agint-cron:diagnosis-watchdog] ' + criticals.join(' ｜ ') + '\n  指标 ' + JSON.stringify(summary));
        throw new Error('diagnosis-watchdog: ' + criticals.join(' ｜ '));
      }
      return { alert: warnings.length > 0, ...summary };
    },
  },
  {
    // 多源输入网关看门狗（2026-10-09 新增）。
    //
    // 为什么必须有它：agint-input-gateway 的采集走**插件自带调度器**
    // （gateway.js:101 startScheduler 的 setInterval），**不经过 agint-cron** ——
    // 所以 cron 列表里根本看不到这四条采集线。2026-10-09 实测：4 个 Channel
    // 里 3 个 lastFetch=never、4 个 signalsEmitted 全 0，而没有任何监控会报警，
    // 外部输入整条链路静默空转了一周还没人知道。
    //
    // 本 job 自身的设计前提（看门狗不能是 silent-zero）：
    //   getStatus() 返回 0 个通道 ⇒ 判 CRITICAL「探针失明」，**不能**当成
    //   「0 问题 = 健康」。2026-09-29 agint-input-gateway 5 个检测器里 4 个恒返回 0
    //   却报 ok=true，正是静默失明 —— 全绿比没监控更坏。
    id: 'input-gateway-watchdog',
    name: '输入网关看门狗',
    // daily 06:00：在 C4(03:30) 采集之后；与相邻 05:45 / 06:15 各隔 15 分钟
    // （满足 test/schedule-layout.test.mjs 原则② 的 `gap < 15` 判据）。
    schedule: '0 6 * * *',
    description: '巡检输入网关四通道采集活性：静默失效 / 反复报错 / 从未采集 / 空转零信号；探针失明即 CRITICAL（daily 06:00）',
    action: async (services) => {
      const gw = services['agint.inputGateway'];
      if (!gw || typeof gw.getStatus !== 'function') {
        return { skipped: true, reason: 'agint.inputGateway not available' };
      }
      const st = await gw.getStatus();

      // ── 探针自检 ──
      const channels = Array.isArray(st?.channels) ? st.channels : [];
      if (channels.length === 0) {
        throw new Error(
          'input-gateway-watchdog: getStatus() 返回 0 个通道 —— 探针失明，' +
          '不能判定为健康（网关未挂载 / 初始化失败 / 状态结构变更）'
        );
      }

      // 各 Channel 的设计周期。源：agint-input-gateway/lib/schema.js 的
      // C2_CRON='0 2 * * 0'、C3_CRON='0 4 * * 0'、C4_CRON='30 3 * * *'、
      // C5_CRON='0 5 * * 0'。网关改名/改频率时这里要同步改。
      const PERIOD_MS = {
        'self-observation': 7 * 86400_000,
        'external-git': 7 * 86400_000,
        adversarial: 1 * 86400_000,
        'cross-agent': 7 * 86400_000,
      };
      const STALE_FACTOR = 2.5;           // 超过 2.5 倍周期才判静默失效
      const GRACE_MS = 6 * 3600_000;      // 再加 6h 宽限，避开刚过点的抖动
      const ERR_BURST = 3;                 // 累计报错达此数判故障

      const now = Date.now();
      const warnings = [];
      const criticals = [];
      const perChannel = [];

      for (const c of channels) {
        const id = c.channelId;
        const k = c.counters ?? {};
        const period = PERIOD_MS[id] ?? 0;
        // lastFetchAt 是 ISO 字符串或 null（storage.js:44 z.string().nullable()），
        // 不是 epoch 数字 —— 用 Number() 会得到 NaN，让 A 判据永不触发。
        const parsed = c.lastFetchAt ? Date.parse(c.lastFetchAt) : NaN;
        const lastMs = Number.isFinite(parsed) ? parsed : 0;

        const row = {
          channelId: id,
          type: c.channelType,
          enabled: c.enabled !== false,
          fetchCount: k.fetchCount ?? 0,
          emitted: k.signalsEmitted ?? 0,
          filtered: k.signalsFiltered ?? 0,
          errors: k.errorCount ?? 0,
          staleHours: lastMs ? Math.round((now - lastMs) / 3600_000) : null,
        };

        if (c.enabled === false) {
          row.verdict = 'disabled';
          perChannel.push(row);
          continue;
        }

        // 通道有两种产信号的方式，判据不能混用：
        //   ① immediate-emit（adversarial）：订阅事件，到达即投 ingestImmediate，
        //      fetch() 是**空 drain**（agint-input-gateway/lib/channels/adversarial.js:200
        //      明写「空 drain（心跳保留）」）⇒ counters.signalsEmitted 恒为 0 是**设计如此**。
        //   ② fetch 产出（self-observation / external-git / cross-agent）：信号在 fetch 里产出。
        // 拿①的 counters 去套②的空转判据，会把「上游没发事件」误报成「采集器失明」——
        // 这正是 check-soundness 说的：一个看似在校验、实则判错依据的门禁，比没有更坏。
        // 正确依据在 health() 里（preflight v0.5：检测器须自报活跃子源）。
        const h = c.health ?? {};
        const immediate = h.mode === 'immediate-emit';

        if (immediate && (h.status === 'degraded' || h.initError)) {
          // E. 订阅压根没建起来（比「没事件」更严重：收不到）
          criticals.push(
            `CRITICAL ${id} 事件订阅未建立：status=${h.status ?? 'unknown'}` +
            (h.initError ? ` initError=${h.initError}` : '')
          );
          row.verdict = 'CRITICAL:notSubscribed';
        } else if (Number(h.ingestFailed ?? 0) > 0) {
          // F. 订阅正常但即投失败
          warnings.push(`WARN ${id} 即投失败 ${h.ingestFailed} 次（订阅在，落地失败）`);
          row.verdict = 'WARN:ingestFailed';
        } else if (immediate) {
          // ① 即投模式：唯一可信的产出判据是 health().ingestedSignals
          const activeDetectors = Object.entries(h.detectors ?? {})
            .filter(([, v]) => v?.active).length;
          if (Number(h.ingestedSignals ?? 0) === 0) {
            warnings.push(
              `WARN ${id} 订阅正常（${activeDetectors} 个检测器 active）但本 boot 未收到任何事件` +
              ' —— 查上游是否真的 publish 了订阅主题'
            );
            row.verdict = 'WARN:noEvent';
          } else {
            row.verdict = 'ok';
          }
        } else if (lastMs && period && now - lastMs > period * STALE_FACTOR + GRACE_MS) {
          // A. 曾经跑过，之后再没跑 —— 采集线静默失效
          criticals.push(
            `CRITICAL ${id} 静默失效：上次采集在 ${row.staleHours} 小时前` +
            `（设计周期 ${period / 86400_000} 天，已超 ${STALE_FACTOR} 倍 + 6h 宽限）`
          );
          row.verdict = 'CRITICAL:stale';
        } else if (Number(k.errorCount ?? 0) >= ERR_BURST) {
          // B. 反复报错
          criticals.push(
            `CRITICAL ${id} 采集报错累计 ${k.errorCount} 次（最近：${c.lastError ?? '未记录'}）`
          );
          row.verdict = 'CRITICAL:errors';
        } else if (Number(k.fetchCount ?? 0) === 0) {
          // C. 从未采集。WARN 不抛：周频 Channel 刚上线属正常，抛了会污染 cron 状态
          warnings.push(`WARN ${id} 已启用但从未采集（fetchCount=0），确认网关调度器是否在跑`);
          row.verdict = 'WARN:neverFetched';
        } else if (Number(k.signalsEmitted ?? 0) === 0 && Number(k.signalsFiltered ?? 0) === 0) {
          // D. 空转：跑了 N 次，产出与过滤都是 0 ⇒ 采集器很可能整个瞎了
          warnings.push(
            `WARN ${id} 采集 ${k.fetchCount} 次但 signalsEmitted 与 signalsFiltered 均为 0` +
            ' —— 空转，疑似采集器失明（对照 2026-09-29 的静默失明事故）'
          );
          row.verdict = 'WARN:idle';
        } else {
          row.verdict = 'ok';
        }
        perChannel.push(row);
      }

      const summary = {
        channelCount: channels.length,
        perChannel,
        checkedAt: new Date(now).toISOString(),
        warningCount: warnings.length,
        criticalCount: criticals.length,
      };
      if (warnings.length) {
        // WARN 只记不抛（与 diagnosis-watchdog 同策略，2026-10-05 老板裁定）：
        // 纯观测任务的提示不该被调度层记成 failed，否则真正的 CRITICAL 会被淹没。
        console.warn('[agint-cron:input-gateway-watchdog] ' + warnings.join(' ｜ ') + '\n  指标 ' + JSON.stringify(summary));
      }
      if (criticals.length) {
        console.warn('[agint-cron:input-gateway-watchdog] ' + criticals.join(' ｜ ') + '\n  指标 ' + JSON.stringify(summary));
        throw new Error('input-gateway-watchdog: ' + criticals.join(' ｜ '));
      }
      return { alert: warnings.length > 0, ...summary };
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
    // Phase -1.1 收口：每期 evolution-cycle 后跑三方对账（取数口径统一）。
    // 排期 Tue 08:00 = evolution-cycle(Tue 07:00) 之后 1h，与 daily 08:30 留 30min，
    // 由 schedule-layout 门禁校验。判据复用 bin/reconcile-evolution-stats.mjs（单一源，
    // 见 lib/evolution-reconcile-audit.js）。只读不写盘；skipped ≠ ok（部署位无 bin/）。
    id: 'evolution-reconcile',
    name: '闭环取数对账',
    schedule: '0 8 * * 2', // Tue 08:00
    description: 'evolution-cycle 后按 event_bus→population→preimage→mutator 交叉对账，有报告性差异(R1/R2)抛错出声（Phase -1.1）',
    action: async (services) => {
      const repoRoot = services['agint.repoRoot'];
      const r = await auditEvolutionReconcile({ repoRoot });
      if (r.status === 'skipped') {
        return { skipped: true, reason: r.reason, job: 'evolution-reconcile' };
      }
      const c = r.result.counts;
      if (r.status === 'diff') {
        const d = r.result.diffs;
        throw new Error(
          `evolution-reconcile: 闭环取数报告性差异 R1=${d.R1_committedNotInPopulation.length} ` +
            `R2=${d.R2_committedMissingPreimage.length}（committed=${c.eventBusCommitted} / population=${c.populationVariants} / mutator=${c.mutatorCommits}）\n` +
            d.R2_committedMissingPreimage
              .map((x) => `  ⛔ 有 commit 无 preimage（不可回滚）: ${x.proposalId} → ${x.preimagePath}`)
              .join('\n'),
        );
      }
      // 返回 { report } → summarizeResult 把 report.counts 写进 cron 健康摘要。
      return { status: 'ok', report: r.result };
    },
  },
  {
    // Phase 1.1 支点 1b / R1′：给 1a 锁掉的预测补上对面那半 —— 实测的 actualDelta。
    //
    // 判据全在 `agint-evolution-driver/lib/outcome-measurer.js`（部署包无 bin/，
    // 见经验教训 §3.13）。本 job 只是薄壳：唤服务、把"需要人看"的情况出声报红。
    //
    // 时机：Tue 10:15。① 紧跟 evolution-cycle(Tue 07:00) 与 evolution-reconcile
    //   (Tue 08:00) 之后 —— 链上条目、对账都已完成，改动还在盘上（driver 不做 git
    //   commit，工作区没被后续提交冲掉）；② 与 09:30 baseline-regression-suite
    //   留 45 分钟（原则②），⛔ 不可取 10:00 / 10:30 —— 每月 1 日恰逢周二时那是
    //   oracle-monthly / spec-index-refresh 的固定位（原则① 同分钟撞车）。
    // 成本：一次测量 = 2× 子集耗时。子集是"改动面筛出来的测试"，实测插件级 <5 秒；
    //   一轮最多 DEFAULT_OUTCOME_LIMIT=5 条 ⇒ 排得进周窗口。
    // ⚠️ 不加进 HEAVY 集合：本 job 零 LLM 调用（只 spawn `node --test`），
    //   原则②b 的 30 分钟是给 LLM 密集任务留的。
    id: 'outcome-measure',
    name: '进化实测对账',
    schedule: '15 10 * * 2', // Tue 10:15
    description: '按改动面筛测试子集，双态跑（改后 / preimage 改前）量出 actualDelta 落 prediction_outcomes（weekly，零 LLM）',
    action: async (services) => {
      const driver = services['agint.evolutionDriver'];
      if (!driver || typeof driver.measureOutcomes !== 'function') {
        return { skipped: true, reason: 'agint.evolutionDriver.measureOutcomes not mounted' };
      }
      const out = await driver.measureOutcomes({});
      // 出声条件有两类，都不许静默过一周：
      //   ① 复原护栏未核过（临时换文件没干净收尾，源码树可能仍处基线态）；
      //   ② 归档校验发现篡改（锁重算对不上，或链上写着预测而锁行没了 = 删证据）。
      // ②是安全事件：`contract_locks` 既不可覆盖也不可删除，缺一行就有一段历史失去见证。
      const attention = (out.results ?? []).filter((r) => r.needsAttention === true);
      const tampered = out.audit?.tampered ?? [];
      const orphans = out.audit?.orphanPredictions ?? [];
      const problems = [];
      if (attention.length > 0) {
        problems.push(`复原护栏未核 ${attention.length} 条：`
          + attention.map((r) => `${r.contractId}(${r.status}) → ${r.changedPath ?? '?'}`).join('; '));
      }
      if (tampered.length > 0) {
        problems.push(`⛔ 锁重算对不上 ${tampered.length} 条：`
          + tampered.map((v) => `${v.contractId}(${v.status})`).join('; ')
          + ' —— 这些 Contract 不计入任何统计（设计 §2.4.2）');
      }
      if (orphans.length > 0) {
        problems.push(`⛔ 链上有预测而锁行缺失 ${orphans.length} 条：`
          + orphans.map((o) => `${o.contractId}(seq=${o.seq ?? '?'})`).join('; '));
      }
      if (problems.length > 0) throw new Error(`outcome-measure: ${problems.join(' / ')}`);
      // `report` 走 cron 的自动搬运（只认 scanned / counts）；
      // `summary` 是约定式通道（`summarizeResult` 原样搬进 lastResultSummary）。
      // ⛔ 只写 report 会丢数：measurable / attempted / deferred / auditChecked
      //   在 cron_state 里读不到，重启后与"根本没跑"无法区分（2026-10-03 实跑踩到）。
      return {
        status: out.ok ? 'ok' : 'skipped',
        summary: {
          scanned: out.scanned ?? 0,
          measurable: out.measurable ?? 0,
          attempted: out.attempted ?? 0,
          deferred: out.deferred ?? 0,
          counts: out.counts ?? {},
          auditChecked: out.audit?.checked ?? 0,
          auditStatus: out.audit?.status ?? null,
        },
        report: {
          scanned: out.scanned ?? 0,
          measurable: out.measurable ?? 0,
          attempted: out.attempted ?? 0,
          deferred: out.deferred ?? 0,
          counts: out.counts ?? {},
          repoRoot: out.repoRoot ?? null,
          auditChecked: out.audit?.checked ?? 0,
          auditCounts: out.audit?.counts ?? {},
        },
      };
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
  {
    // P1-1 阶段 3（2026-10-01）：记忆 Provider 定期健康检查。
    //
    // 与「降级」是两件事：降级是**调用失败时**的护栏（阶段 2，实时），本 job 是
    // **没人调用时**也能发现 provider 悄悄不可用（周期性）。
    // ⚠️ 只告警不处置：连续未通过达阈值只发 memory.provider-unhealthy 事件 +
    // 一条 audit_log，切不切 provider 由人工决定（§9.3 自我评估禁止）。
    //
    // 排期：daily 08:30 —— ① 08:00 是 oracle-weekly（周一）固定位，09:00 是
    // oracle-daily 固定位，08:30 是两者之间唯一的空档；② 赶在老板在线前产出，
    // 白天会话开始时就能看到「外部 provider 还活着吗」。
    // 轻量（配置/凭证级校验，provider 实现 healthCheck() 才做真实探活），
    // 不进 HEAVY 集合。
    id: 'memory-provider-health',
    name: '记忆 Provider 健康检查',
    schedule: '30 8 * * *', // daily 08:30
    description: '巡检已注册记忆 provider 并落 health_checks（只告警，不自动切换）',
    action: async (services) => {
      const mp = services['agint.memoryProvider'];
      if (!mp) return { skipped: true, reason: 'agint.memoryProvider not mounted' };
      const r = await mp.runHealthCheck({ trigger: 'cron' });
      if (!r.enabled) return { skipped: true, reason: r.reason };
      return {
        checkedAt: r.checkedAt,
        total: r.total,
        healthy: r.healthy,
        unhealthy: r.unhealthy,
        skipped: r.skipped,
        error: r.error,
        activeProvider: r.activeProvider,
        // 连续未通过次数（>0 即告警中）；不在这里做任何处置动作
        unhealthyStreaks: r.unhealthyStreaks,
        providers: (r.results ?? []).map((x) => ({
          providerName: x.providerName,
          result: x.result,
          networkProbed: x.networkProbed,
          durationMs: x.durationMs,
          consecutiveFailures: x.consecutiveFailures,
        })),
      };
    },
  },
  {
    // Phase-3 轨道 C（2026-10-03）：协议索引月度巡检。
    //
    // 目的：INDEX.json 由 `node bin/build-spec-index.mjs` 在开发机生成并随
    // review 走；规范文件改了而索引没重生成时，`--check` 会红，但**没人会想起来跑**
    // —— 这正是 §0.1 反复出事的那类「静默漂移」。本 job 每月把它顶到台面上。
    //
    // ⛔ **只读**：审计不写盘（lib/spec-index-audit.js 头部有形态论证）。
    //   索引是仓库资产，改它要过 review，不能由宿主进程单方面决定。
    //
    // ⛔ **soft-skip 而不是抛错**：判据不可用（部署位没有 docs/、生成器缺失）
    //   属于「能力不在这一层」，不是「本次巡检失败」。抛错会在 cron 健康里
    //   留一条永久红色，而那条红色不指向任何可修的东西 —— 那是噪声，不是信号。
    //   ⚠️ 但 skip 必须写清**缺哪一项**（K134：能力不可用 vs 实现有 bug 要能分开）。
    //
    // ⚠️ 真正有漂移时**抛错**：那是要人修的，红色是对的。
    //
    // 排期：每月 1 日 10:30。
    //   ⛔ 设计稿建议的是 09:30 —— **不可用**。09:30 已被 4 个周任务占满
    //   （wiki-lint / baseline-regression-suite / curriculum-weekly / skill-graph-weekly），
    //   而 dom=1 会落在任意星期几 ⇒ 每月必撞一次。schedule-layout 门禁会拦下它。
    //   10:30 的理由：① 全窗口唯一空闲的半点（10:00 是 oracle-monthly）；
    //   ② 距 oracle-monthly 30 分钟，够它先跑完；③ 不占周一上午链路。
    id: 'spec-index-refresh',
    name: '协议索引月度巡检',
    schedule: '30 10 1 * *', // 每月 1 日 10:30
    description: '只读审计 docs/specs/INDEX.json 与磁盘规范是否漂移；漂移抛错，判据不可用则显式 skip（不写盘）',
    action: async (services) => {
      const repoRoot = services['agint.repoRoot'];
      const r = await auditSpecIndex({ repoRoot });
      if (r.status === 'skipped') {
        return { skipped: true, reason: r.reason, job: 'spec-index-refresh' };
      }
      if (r.status === 'drift') {
        // 抛错让 cron 健康记录留下明确失败。修法写进消息里，省一次查文档。
        throw new Error(
          `spec-index-refresh: 协议索引漂移 ${r.errors.length} 处` +
            ` —— 修法：跑 \`node bin/build-spec-index.mjs\` 重新生成后提交。\n` +
            r.errors.map((e) => `  - ${e}`).join('\n'),
        );
      }
      return {
        status: 'ok',
        specCount: r.specCount,
        pendingCount: r.pendingCount,
        untracked: r.untracked,
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