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

  return () => {
    for (const d of disposers.splice(0)) {
      try { if (typeof d === 'function') d(); } catch { /* ignore */ }
    }
  };
}
