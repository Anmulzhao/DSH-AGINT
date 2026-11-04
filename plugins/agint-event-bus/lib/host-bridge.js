/**
 * host-bridge.js — 宿主事件 → 总线信号（B1，2026-11-02）
 *
 * WHY：为什么需要它
 * ----------------
 * AGINT 自称「事件总线驱动的自进化系统」，但 v0.24.0 的盘点显示：宿主给 82 个事件，
 * 我们只接了 6 个，全是工具流水线与会话。**进化闭环最该看的两类信号一条没接**：
 *
 *   1. `domain/changed` —— 24 个 storage 域里任何一个被写，宿主都在**持久化确认之后**
 *      发一条（"emitted once per write strictly after the backend acknowledged durability"）。
 *      而 AGINT 的派生状态（面板、self-model 快照）只能靠全量重扫或 cron 兜。
 *   2. `workflow/end` —— preset 已经挂了 dsh-tool-workflow / dsh-workflow-ptc，
 *      但工作流跑过什么，总线上一片空白 ⇒ trajectory / 进化记忆无法留档。
 *
 * 设计约束（先立规矩，再写代码）
 * ----------------------------
 * H1 **绝不阻塞宿主。** `domain/changed` 是同步 emit，且处在写路径的尾部 ——
 *    listener 里任何 await 都会把存储写入拖成 O(总线投递)。所以发布一律
 *    fire-and-forget（`Promise.resolve().then`），不 return 任何 Promise。
 *
 * H2 **绝不把异常抛回宿主。** 同上：一个 publish 失败不该让某次域写入失败。
 *    抛错一律吞掉并计数（`eventBus.hostBridgeFailed`），与 delivery 层的
 *    「单订阅者异常不能击穿 publish」是同一条纪律的下一层。
 *
 * H3 **白名单，不做全量。** 24 个域里有 5 个是高频写（event_bus / metrics /
 *    input_gateway / cron / restart），全接会把总线淹掉、把 events 表撑爆。
 *    只接「系统实质状态变了」的那 7 个（见 DOMAIN_WHITELIST）。
 *    ⚠️ 这不是省事，是判据：一条 `agint_tool_stats` 写入不是进化信号，
 *    一条 `agint_evolve` 提案状态变更才是。
 *
 * H4 **不带 value。** `DomainChangedPut` 带 `value`，那可能是整行数据（含长文本）。
 *    接进总线只需知道「哪个域哪张表哪个 key 变了」—— 要看内容的下游自己去读，
 *    这是「事实与结论分离」在传输层的一次具体落实（事实 = 变了；内容 = 自取）。
 *
 * H5 **可关。** config 允许 `hostBridge: false` 整体关掉 —— 一旦发现某域洪水，
 *    不必改代码、只需改配置重启。
 *
 * 不做什么
 * --------
 * - 不做节流。节流会让计数失真（metrics 侧正是靠计数看「哪天突然停写」）。
 *   用白名单控制量级，比用节流掩盖量级更诚实。
 * - 不做判读。宿主事件是**事实**，桥接只做格式转换。要不要因此做某事，
 *   由订阅者（metrics 计数 / 未来的 self-model）各自决定。
 */

/** 只接这些域：它们的写入代表「系统的实质状态变了」 */
export const DOMAIN_WHITELIST = Object.freeze([
  'agint_curriculum',   // 自主课程：挑战生成 / 结果
  'agint_evolve',       // 提案台账：状态机推进
  'agint_evolution',    // 进化记忆：账本
  'agint_mount',        // 变更编排：三段式事务
  'agint_population',   // 种群：promote / cull / rollback
  'agint_rules',        // 规则门禁：deny 增删
  'agint_self_model',   // 能力自我认知：快照校准
]);

/** 桥接产出的 topic。命名沿用 `input.signal.<频道>.<类型>`，与 C2/C3/C4/C5 同构。 */
export const HOST_TOPICS = Object.freeze({
  DOMAIN_CHANGED: 'input.signal.host.domain-changed',
  WORKFLOW_END: 'input.signal.host.workflow-end',
  // ── 2026-11-03 扩容（W1 / W4）────────────────────────────────────────
  // 这四条补的是 2026-11-01 盘点里「接的位置太窄」的另一半：
  // 原来 6 个订阅点里 4 个是工具流水线、2 个是会话，**多 Agent 行为 / 技能变更 /
  // 目标变更 / 工作流过程**这四类一条都没接。
  WORKFLOW_PHASE: 'input.signal.host.workflow-phase',
  SUBAGENT_START: 'input.signal.host.subagent-start',
  SUBAGENT_END: 'input.signal.host.subagent-end',
  SKILLS_CHANGE: 'input.signal.host.skills-change',
  GOAL_CHANGED: 'input.signal.host.goal-changed',
  GOAL_ACTIVATION_CHANGED: 'input.signal.host.goal-activation-changed',
});

/*
 * ⚠️ 下面两处 publish 的 topic 刻意写**字面量**，不引用 HOST_TOPICS。
 * 原因（与 eventCounters 里那条教训同形）：
 *   `bin/verify-event-topics.mjs` 靠 `/topic\s*:\s*['"]…['"]/` 逐行扫源码，
 *   写成 `topic: HOST_TOPICS.X` 对它是**不可见**的 —— 于是两条新主题会成为
 *   「清单外的野 topic」，门禁照样报绿。字面量在门禁看得见的位置，
 *   比省一处重复更重要；常量与字面量的一致性由 test/host-bridge.test.mjs 钉死。
 */

/**
 * 把宿主事件桥到总线。
 *
 * @param {object} ctx        cordis 上下文（只需 ctx.on）
 * @param {object} deps
 * @param {(input:object)=>Promise<object>} deps.publish  bus.publish(ctx, input)
 * @param {(key:string, delta:number)=>void} [deps.metrics] 计数出口（软依赖）
 * @returns {() => void} dispose：注销全部宿主监听
 */
export function attachHostBridge(ctx, { publish, metrics } = {}) {
  const disposers = [];
  /** 软计数：metrics 缺席不影响桥接 */
  const inc = (key) => {
    try { metrics?.(key, 1); } catch { /* 计数器出错不许影响桥接 */ }
  };

  /**
   * H1 + H2 落实点：同步返回、异步投递、异常吞掉并计数。
   * 刻意不给返回值 —— 调用方（宿主 emit）不该有任何机会 await 它。
   */
  const publishDetached = (input) => {
    if (typeof publish !== 'function') return;
    Promise.resolve()
      .then(() => publish(input))
      .then((r) => { if (r && r.accepted === false) inc('eventBus.hostBridgeRejected'); })
      .catch(() => inc('eventBus.hostBridgeFailed'));
  };

  if (typeof ctx?.on !== 'function') return () => {};

  // ── 1. domain/changed：存储域写入（持久化确认之后）──
  // 签名：'domain/changed'(change: DomainChanged) —— DomainChangedBase = { domain, table, key }
  //
  // ⚠️ `ignoredSeen` + 采样：2026-11-02 首次部署后实测，**1 分钟 332 次**非白名单写入
  // （约 5.5 次/秒）。若每次都 inc 就写一行 metric，等于给 metrics 表灌进每天 40 万行 ——
  // 「为了可观测而压垮观测表」。所以：
  //   · 白名单命中（有业务价值、本身低频）→ 全量计数；
  //   · 被过滤（只用来证明「订阅活着」，没有业务价值）→ **首次 + 每 100 次**计一次。
  // 采样会让这个数字失真，但它要回答的问题是「桥接到底订阅上没有」，不是「忽略了多少条」。
  let ignoredSeen = 0;
  disposers.push(ctx.on('domain/changed', (change) => {
    try {
      const domain = String(change?.domain ?? '');
      if (!DOMAIN_WHITELIST.includes(domain)) {
        // ⚠️ 这一行不是装饰，是**可观测性的必要条件**。
        // 没有它，"桥接没订阅上" 与 "订阅上了但全部被白名单过滤" 在外部**完全同形**
        // （都是 changed=0、总线无新 topic）。2026-11-02 首次部署后我就撞上了这个歧义：
        // 启动后确有一次域写入（agint_memory_provider，不在白名单），但无法证明桥接在工作。
        // 计数 ignored > 0 而 changed = 0 ⇒ 订阅正常、只是没命中白名单；
        // 两个都是 0 ⇒ 压根没订阅上。**不允许让这两件事长得一样。**
        ignoredSeen += 1;
        if (ignoredSeen === 1 || ignoredSeen % 100 === 0) {
          inc('eventBus.hostDomainIgnored');
        }
        return;
      }
      inc('eventBus.hostDomainChanged');
      publishDetached({
        topic: 'input.signal.host.domain-changed', // 字面量：门禁要扫得到（见上方注释）
        source: 'agint-event-bus',
        payload: {
          hostEvent: 'domain/changed',
          domain,
          table: String(change?.table ?? ''),
          key: String(change?.key ?? ''),
          operation: String(change?.operation ?? ''),
        },
      });
    } catch {
      // 连 payload 构造都失败：说明宿主换了契约形状。计数后静默，绝不向上抛。
      inc('eventBus.hostBridgeThrow');
    }
  }));

  // ── 2. workflow/end：一次工作流运行结束（任何 stopReason）──
  // 签名：'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo)
  //   WorkflowRunInfo   = { id, meta: { name, description, ... } }
  //   WorkflowResultInfo = { stopReason: 'completed'|'cancelled'|'error', error?, agentsStarted }
  disposers.push(ctx.on('workflow/end', (info, result) => {
    try {
      inc('eventBus.hostWorkflowEnd');
      publishDetached({
        topic: 'input.signal.host.workflow-end', // 字面量：门禁要扫得到（见上方注释）
        source: 'agint-event-bus',
        payload: {
          hostEvent: 'workflow/end',
          workflowId: String(info?.id ?? ''),
          name: String(info?.meta?.name ?? ''),
          stopReason: String(result?.stopReason ?? ''),
          // 错误串截断：总线 payload 进 events 表，长栈会把单条记录撑大
          error: result?.error ? String(result.error).slice(0, 200) : null,
          agentsStarted: Number(result?.agentsStarted ?? 0),
        },
      });
    } catch {
      inc('eventBus.hostBridgeThrow');
    }
  }));

  // ── 3. workflow/phase：一次工作流运行中的相位推进 ──────────────────────
  // 签名：'workflow/phase'(info: WorkflowRunInfo, title: string)
  // 为什么补（W4）：只接 `workflow/end` 拿得到「跑完了」，拿不到「卡在哪一相」。
  // trajectory 要的是过程，不是结局 —— 没有相位序列，一次失败的工作流在
  // 训练数据里只剩一行 stopReason:'error'，等于把最有信息量的部分扔了。
  //
  // ⚠️ H3 例外说明：这条**不设白名单也不节流**，因为 phase 的条数由工作流脚本
  //    自己决定（一个脚本通常 3~8 相），不是宿主写的频率。如果哪天有人写出
  //    200 相的脚本，会在这里看见（`eventBus.hostWorkflowPhase` 计数飙升），
  //    到时候再谈限额 —— 但**不要**预先节流，相位丢失比相位过多更难查。
  disposers.push(ctx.on('workflow/phase', (info, title) => {
    try {
      inc('eventBus.hostWorkflowPhase');
      publishDetached({
        topic: 'input.signal.host.workflow-phase', // 字面量：门禁要扫得到
        source: 'agint-event-bus',
        payload: {
          hostEvent: 'workflow/phase',
          workflowId: String(info?.id ?? ''),
          name: String(info?.meta?.name ?? ''),
          // 相位标题截断到 100：它是人写的自由文本，可能带长说明
          phase: String(title ?? '').slice(0, 100),
        },
      });
    } catch {
      inc('eventBus.hostBridgeThrow');
    }
  }));

  // ── 4. subagent/start + subagent/end：子代理生命周期（W1）────────────────
  // 签名（实测 dsh-subagent/lib/index.js:197 / :200）：
  //   'subagent/start'(identity: SubagentIdentity, parent: Agent)
  //   'subagent/end'(  { ...identity, stopReason, lastAssistantMessage? }, parent: Agent)
  //   SubagentIdentity = { runId, provider: string, id: childId, local: boolean }
  //
  // 为什么接：P8 多 Agent 进化**没有数据**。现在 subagent 跑了什么、用哪个 provider、
  // 成没成、是不是本地，进化层一概不知 —— 而这正是「哪些子代理值得派」的唯一依据。
  //
  // ⚠️ H4 落实点：`lastAssistantMessage` 是**子代理的完整输出**，可能是几千字。
  //    总线 payload 要进 events 表，所以这里只留长度，正文不进 payload。
  //    要看内容的订阅者自己去 session 里读 —— 事实（跑完了、多长）与内容分离。
  const subagentIdentityPayload = (identity, hostEvent) => ({
    hostEvent,
    runId: String(identity?.runId ?? ''),
    provider: String(identity?.provider ?? ''),
    childId: String(identity?.id ?? ''),
    local: identity?.local === true,
  });

  disposers.push(ctx.on('subagent/start', (identity) => {
    try {
      inc('eventBus.hostSubagentStart');
      publishDetached({
        topic: 'input.signal.host.subagent-start', // 字面量：门禁要扫得到
        source: 'agint-event-bus',
        payload: subagentIdentityPayload(identity, 'subagent/start'),
      });
    } catch {
      inc('eventBus.hostBridgeThrow');
    }
  }));

  disposers.push(ctx.on('subagent/end', (identity) => {
    try {
      inc('eventBus.hostSubagentEnd');
      const message = identity?.lastAssistantMessage;
      publishDetached({
        topic: 'input.signal.host.subagent-end', // 字面量：门禁要扫得到
        source: 'agint-event-bus',
        payload: {
          ...subagentIdentityPayload(identity, 'subagent/end'),
          // stopReason 是宿主判定的终态（completed / aborted / error / max-tokens），
          // 不是子代理自述 —— 这正是「成功判定要有外证」在子代理层的落点
          stopReason: String(identity?.stopReason ?? ''),
          // 只记长度不记正文（H4）
          messageLength: typeof message === 'string' ? message.length : 0,
        },
      });
    } catch {
      inc('eventBus.hostBridgeThrow');
    }
  }));

  // ── 5. skills/change：技能目录变更（W2）──────────────────────────────
  // 签名：'skills/change'() —— **无参数**（dsh-skill/lib/index.js:404，dispatch("emit", ["skills/change"])）
  // ⚠️ 无参数意味着拿不到「哪个技能变了」。这不是缺陷，是宿主的契约：
  //    它只保证「目录变了」，具体 diff 要自己去读 skills 服务。
  //    ⇒ payload 里**不要**编造 skillName 字段，只记一条事实。下游（curator）
  //      自己做增量扫描并 diff，别指望这个事件携带变更内容。
  disposers.push(ctx.on('skills/change', () => {
    try {
      inc('eventBus.hostSkillsChange');
      publishDetached({
        topic: 'input.signal.host.skills-change', // 字面量：门禁要扫得到
        source: 'agint-event-bus',
        payload: {
          hostEvent: 'skills/change',
          // 显式写 null 而不是省略：下游能区分「事件没带」与「字段名写错」
          skillName: null,
        },
      });
    } catch {
      inc('eventBus.hostBridgeThrow');
    }
  }));

  // ── 6. goal/changed + goal/activation-changed：目标变更（W3）─────────────
  // 签名（dsh-goal/lib/index.js:798 / :877）：
  //   'goal/changed'(payload: { agent, change: { operation, ref, goal? } })   ← scoped by agent
  //   'goal/activation-changed'(payload: { sessionId, goal?: { id, revision, activation } })
  //
  // 为什么接：agint-curriculum 现在自推课程，与老板真正在追的目标没关系。
  // 目标变了，课程队列该跟着变 —— 这是「课程对齐真实目标」的唯一输入。
  //
  // ⚠️ 两条事件**作用域不同**：goal/changed 是 agent 级的（挂某个 agent 上），
  //    activation-changed 是 session 级的。别把两者当同一件事的两种写法。
  disposers.push(ctx.on('goal/changed', (payload) => {
    try {
      inc('eventBus.hostGoalChanged');
      const change = payload?.change;
      publishDetached({
        topic: 'input.signal.host.goal-changed', // 字面量：门禁要扫得到
        source: 'agint-event-bus',
        payload: {
          hostEvent: 'goal/changed',
          operation: String(change?.operation ?? ''),
          goalId: String(change?.ref?.id ?? change?.goal?.id ?? ''),
          // goal 是整份目标视图（含 phases 等），H4：摘字段不整份带
          revision: change?.goal?.revision === undefined ? null : Number(change.goal.revision),
          activation: change?.goal?.activation === undefined ? null : String(change.goal.activation),
        },
      });
    } catch {
      inc('eventBus.hostBridgeThrow');
    }
  }));

  disposers.push(ctx.on('goal/activation-changed', (payload) => {
    try {
      inc('eventBus.hostGoalActivationChanged');
      publishDetached({
        topic: 'input.signal.host.goal-activation-changed', // 字面量：门禁要扫得到
        source: 'agint-event-bus',
        payload: {
          hostEvent: 'goal/activation-changed',
          sessionId: String(payload?.sessionId ?? ''),
          goalId: String(payload?.goal?.id ?? ''),
          revision: payload?.goal?.revision === undefined ? null : Number(payload.goal.revision),
          activation: payload?.goal?.activation === undefined ? null : String(payload.goal.activation),
        },
      });
    } catch {
      inc('eventBus.hostBridgeThrow');
    }
  }));

  return () => {
    for (const d of disposers.splice(0)) {
      try { if (typeof d === 'function') d(); } catch { /* ignore */ }
    }
  };
}
