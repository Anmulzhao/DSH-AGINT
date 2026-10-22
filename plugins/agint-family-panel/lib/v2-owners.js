/**
 * v2-owners: 归因表与宿主键名单的**单一事实源**。
 *
 * 为什么单独抽出来（v0.4.0）：
 * 这三张表原本硬编码在 `assets/panel-v2.html` 里（浏览器侧）。新加的「插件档案页」
 * 住在 `lib/client.js`（也是浏览器侧，但另一份文件），两边各抄一份必然漂移 ——
 * 典型症状是同一个 cron 任务在整页视图里归 A 插件、在档案页里归 B 插件，而没有人
 * 知道哪份对。本仓已有同类先例（`probeEventSources` 改为随 payload 下发）。
 *
 * 做法：host 半把表随 `/v2/data` 下发（`payload.owners`），两个前端都从 payload 取。
 * 这里只导出常量与纯函数，不读磁盘、不碰 ctx —— 可被 node 单测直接 import。
 *
 * 已知局限（不装完整）：工具归属按**命名前缀**推断，不是宿主枚举的真值（U4 未证实）。
 * 因此档案页与 Q2 都把这一列标成推断，不冒充实测。
 */

/**
 * 工具名前缀 → 归属插件。顺序有意义：先匹配先赢，长前缀必须排在短前缀之前
 * （`memory_provider_` 在 `memory_` 前，`evolution_ledger` 在 `evolution_` 前）。
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const TOOL_OWNER = Object.freeze([
  ['memory_provider_', 'agint-memory-provider'], ['memory_', 'agint-memory'], ['wiki_', 'agint-wiki'],
  ['rule_', 'agint-rules'], ['cron_', 'agint-cron'], ['job_', 'agint-cron'], ['dream_', 'agint-dream'],
  ['evolve_', 'agint-evolve'], ['metrics_', 'agint-metrics'], ['eventBus_', 'agint-event-bus'],
  ['curator_', 'agint-curator'], ['autocreate_', 'agint-skill-autocreate'], ['selfModel_', 'agint-self-model'],
  ['skillGraph_', 'agint-skill-graph'], ['mutator_', 'agint-mutator'], ['population_', 'agint-population'],
  ['mount_', 'agint-mount'], ['abtest_', 'agint-abtest'], ['diagnosis_', 'agint-diagnosis'], ['diagnose_', 'agint-diagnosis'],
  ['input_gateway_', 'agint-input-gateway'], ['curriculum_', 'agint-curriculum'], ['quality_eval_', 'agint-quality-eval'],
  ['tool_stats_', 'agint-tool-stats'], ['agint_search', 'agint-search'], ['compress_guard_', 'agint-compress-guard'],
  ['restart_', 'agint-restart'], ['evolution_ledger', 'agint-evolution-driver'], ['evolution_', 'agint-evolution-memory'],
  ['recall_store', 'agint-ov-strategy'],
]);

/**
 * cron 任务 id → 归属插件。**没有前缀规律**（`night-dream` / `oracle-daily` 都靠人写），
 * 所以必须是显式表；表里没有的任务在面板上单列「归属待复核」，不猜。
 * @type {Readonly<Record<string,string>>}
 */
export const CRON_OWNER = Object.freeze({
  'prompt-static-check': 'agint-quality-static', 'metrics-collect': 'agint-metrics', 'tool-stats-backfill': 'agint-tool-stats',
  'night-dream': 'agint-dream', 'wiki-lint': 'agint-wiki', 'evolve-review': 'agint-evolve', 'memory-decay': 'agint-memory',
  'skill-autocreate-aggregate': 'agint-skill-autocreate', 'skill-autocreate-release': 'agint-skill-autocreate',
  'skill-autocreate-observe': 'agint-skill-autocreate',
  'skill-graph-weekly': 'agint-skill-graph', 'curriculum-weekly': 'agint-curriculum', 'curator-weekly': 'agint-curator',
  'diagnosis-watchdog': 'agint-diagnosis', 'evolution-cycle': 'agint-evolution-driver', 'oracle-daily': 'agint-aesthetic-oracle',
  'oracle-weekly': 'agint-aesthetic-oracle', 'oracle-monthly': 'agint-aesthetic-oracle',
  'memory-provider-health': 'agint-memory-provider', 'evolution-reconcile': 'agint-evolution-driver',
  'outcome-measure': 'agint-evolution-driver',
});

/**
 * 宿主（dsh）提供的服务键 / 配置键。本仓永远查不到它们的 `ctx.provide`，
 * 所以「无提供方」判据必须排除它们 —— 否则每个消费宿主服务的插件都会被误报。
 *
 * `profileContext`（2026-10-22 补）：本仓 `lib/index.js` 用
 * `ctx.get('profileContext')?.name` 取当前 profile 名，宿主注入，无 provide 行。
 * 它此前被算成「无提供方」候选，让每个读它的插件多背一条假债。
 * @type {ReadonlySet<string>}
 */
export const HOST_KEYS = Object.freeze(new Set([
  'agents', 'subagents', 'skills', 'sandbox', 'approval', 'openvikingMemory',
  'dshHome', 'profilesDir', 'sessionQuery', 'sessionPersistence', 'agentDefaultModel', 'goals', 'layout',
  'profileContext',
]));

/** 工具名 → 归属插件（前缀推断；未命中返回 null）。 */
export function ownerOfTool(toolName) {
  const t = String(toolName ?? '');
  for (const [prefix, owner] of TOOL_OWNER) if (t.startsWith(prefix)) return owner;
  return null;
}

/** 是否为 dsh 宿主键。 */
export function isHostKey(service) {
  const s = String(service ?? '');
  return !s.startsWith('agint.') && HOST_KEYS.has(s);
}

/**
 * 服务 → 提供方插件（父键回退）。
 *
 * cordis 的服务键是**扁平**的：`agint.eventBus.publish` 与 `agint.eventBus` 是两个键。
 * 消费方常取子键，提供方可能只声明父键，所以查不到精确键时逐段退到父键。
 * ⛔ 只在「确有该父键的 provide」时回退 —— 不能凭空造提供方。
 * @param {Record<string,string>} provided - 服务键 → 提供方插件
 * @param {string} service
 * @returns {string|null}
 */
export function providerOfService(provided, service) {
  if (!provided || !service) return null;
  if (provided[service]) return provided[service];
  const parts = String(service).split('.');
  while (parts.length > 2) {
    parts.pop();
    const key = parts.join('.');
    if (provided[key]) return provided[key];
  }
  return null;
}

/** 随 payload 下发的形态（纯数据，前端直接消费）。 */
export function ownersPayload() {
  return {
    tool: TOOL_OWNER.map(([prefix, owner]) => [prefix, owner]),
    cron: { ...CRON_OWNER },
    hostKeys: [...HOST_KEYS],
    note: '工具归属按命名前缀推断（U4 未证实）；cron 归属为显式表，表外任务单列待复核。',
  };
}
