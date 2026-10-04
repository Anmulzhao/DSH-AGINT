/**
 * lib/model-scope.js — 技能「模型归属」字段的定义、判据与渲染
 *
 * ── 为什么有这个模块（2026-10-03 老板拍板）──────────────────────────────
 * 老板判断：「每个模型的特点和盲区不一样，用不同模型出错点也不一样。
 * 以后根据经验教训生成的技能要区分是哪个模型的。」
 *
 * 这条判断对本插件意味着什么，取证如下：
 *   - 技能是**从真实执行痕迹里长出来的**（tool 序列 + 会话文本窗口），
 *     而这些痕迹全部产生自某一个模型 → 技能的适用性天然带模型前提。
 *   - 不同模型的盲区不同 ⇒ 同一套步骤在 A 模型上省事、在 B 模型上可能反而
 *     多踩坑（它本来就不需要这一步、或它自己会用更好的办法）。
 *   - 所以「已验证适用的模型」和「未验证模型上的风险」**必须写进技能本身**，
 *     否则下一个模型读到的就是一条**没有适用前提**的通用断言。
 *
 * ── 边界（K51 自进化默认：不新增门禁，只做标注）────────────────────────
 * 本模块**只标注，不拦截**。技能好不好用仍由既有五道门（A1 特异性 / A2 具体值 /
 * A3 信息量 / successRate / quality-static）判。
 * 为什么不加「模型归属缺失就拒收」的门：模型信息在 v3 会话与 tool-stats 源里
 * 本来就取不到（见 agint-session-extract.extractModels 的 unknown 分支），
 * 一旦升级成门，会把**所有旧来源的候选全部拒掉**——用一个字段的缺失去否决
 * 整条技能，代价远大于收益。标注 + 显式 unknown 足够：读技能的人能看到
 * 「来源模型未知」这句话，这与「静默留白」有本质区别。
 *
 * ── 一处判据一个所有者（Hermes「同一教训只有一条」）──────────────────
 * 渲染（renderModelSection）与判据（buildModelScope）都在本文件，
 * 别在 proposer/templates/evaluator 里另写一份模型字符串拼装。
 *
 * 纯函数，无 I/O，全部可单测。
 */

import { extractModels } from '../../agint-session-extract/index.js';

/** 判据族名（与 semantics 的 `skill-semantics`、authoring 的 `skill-authoring` 并列，不混用） */
export const MODEL_SCOPE_FAMILY = 'skill-model-scope';

// ── 判据登记表 ──────────────────────────────────────────────────────────

/**
 * 判据登记表：**code → 标准**（标准即那条判据「合格长什么样」）。
 *
 * 形态说明：本表**刻意不含 severity 列** —— 全部条目恒为 warn，
 * 「本族不设 blocker」这条纪律改由下面那行显式断言守住。
 * 早先版本写成 `[code, severity, 标准]` 三元组，结果 severity 位上放的是标准
 * 全文（`RuleSeverity` 取到的就是那句话），findings 的 severity 字段整个被污染
 * 成一段中文——而 `allFindings.filter(f => f.severity === 'blocker')` 恰好
 * 不受影响，于是**测试全绿、行为全错**。这就是为什么下面有断言。
 */
export const MODEL_SCOPE_RULES = Object.freeze([
  ['model-scope-unknown-source', '来源模型未知（会话日志无模型字段，多见于 v3 会话或 tool-stats 源）——按「适用性未经任何模型验证」对待'],
  ['model-scope-unverified-transfer', '技能在多于一个模型上被观察到，但尚未区分「哪些模型验证过哪些步骤」。跨模型复用前先按「未在目标模型上验证」对待'],
  ['model-section-missing-in-body', 'frontmatter 标了模型归属但正文没有「## 适用模型」段——读者加载正文时看不到适用前提'],
]);

/** 本族唯一档位。改这个文件的人若想加 blocker，先读文件头「边界」。 */
export const MODEL_SCOPE_SEVERITY = 'warn';

const RULE_SEVERITY = Object.fromEntries(
  MODEL_SCOPE_RULES.map(([code]) => [code, MODEL_SCOPE_SEVERITY]),
);

// ── 常量 ────────────────────────────────────────────────────────────────

/** 模型名/厂商名的合法字符（frontmatter 与正文都要能安全落盘） */
const MODEL_TOKEN_RE = /^[\w.@:/+-]{1,80}$/;

/** 正文「适用模型」段里，模型清单最多列几个（超出只给占比最高的几个） */
export const MODELS_DISPLAY_MAX = 4;

/** 模型列表的展示口径：低于这个占比的模型不单列（写进 manifest 的完整列表） */
export const MODELS_DISPLAY_MIN_SHARE = 0.05;

// ── 判据 + 构造 ─────────────────────────────────────────────────────────

function safeToken(v) {
  const s = String(v ?? '').trim();
  return MODEL_TOKEN_RE.test(s) ? s : '';
}

/**
 * 由会话事件列表构造「模型归属」对象（纯函数）。
 *
 * @param {object[]} events 会话事件（loadSession 的输出）
 * @returns {{status: 'known'|'unknown', models: Array<{provider,model,share,dominant}>,
 *            providers: string[], dominant: object|null,
 *            verifiedOn: string[], unverifiedOn: string[]}}
 *   - status='unknown' → 一条模型都没取到（**诚实缺失，不猜**）
 *   - verifiedOn   = 已验证适用（= 实际观察到经验的模型）
 *   - unverifiedOn = 已识别但**未验证**（本插件当前恒为空数组——见下方说明）
 *
 * ⚠️ unverifiedOn 为什么恒空：本插件只能观察「模型 A 犯过什么错」，
 * 观察不到「模型 B 在这条技能上会出什么错」。凭空列 B 叫**编造**。
 * 真正该写进 unverifiedOn 的是「宿主当前存在但本条技能未见其产生痕迹的模型」，
 * 而插件拿不到宿主模型清单（那是运行时配置，不是日志事实）⇒ 宁可空着，
 * 交由正文的风险提示句说明「在未列出的模型上按未验证对待」。
 */
export function buildModelScope(events) {
  const { models: raw, providers, unknown } = extractModels(events);
  if (unknown || raw.length === 0) {
    return {
      status: 'unknown',
      models: [],
      providers: [],
      dominant: null,
      verifiedOn: [],
      unverifiedOn: [],
    };
  }
  const total = raw.reduce((s, m) => s + m.messages, 0) || 1;
  const models = raw.map((m) => {
    const provider = safeToken(m.provider);
    const model = safeToken(m.model);
    return {
      provider,
      model,
      share: +(m.messages / total).toFixed(4),
      dominant: m.messages === raw[0].messages,
      messages: m.messages,
    };
  }).filter((m) => m.provider || m.model);

  const dominant = models.find((m) => m.dominant) ?? null;
  const verifiedOn = models
    .filter((m) => m.share >= MODELS_DISPLAY_MIN_SHARE)
    .map((m) => (m.model && m.provider ? `${m.provider}/${m.model}` : (m.model || m.provider)));
  return {
    status: 'known',
    models,
    providers,
    dominant,
    verifiedOn,
    unverifiedOn: [],
  };
}

/**
 * 合并两个模型归属（消息数加权并集）。
 *
 * 语义：
 *   - 任一侧不是 known/非空 → 返回另一侧（**任一来源缺证据就不谎称已知**，
 *     与「缺数据就不猜」一致）；
 *   - 按 provider/model 聚合消息数，share 重算，dominant = 消息数最多者。
 *
 * 用途：跨会话聚合（一个任务来自多个会话）与 pattern 增量更新都会用到。
 * 合并规则的所有权在本函数——**别在 aggregator/detector 里另写一份并集逻辑**，
 * 那正是「同一教训两条实现」的起点。
 */
export function mergeModelScope(prev, next) {
  const usable = (s) => s && typeof s === 'object' && s.status === 'known'
    && Array.isArray(s.models) && s.models.length > 0;
  if (!usable(prev)) return usable(next) ? next : (next ?? prev ?? null);
  if (!usable(next)) return prev;
  const tally = new Map();
  for (const src of [prev, next]) {
    for (const m of src.models) {
      const k = `${m.provider ?? ''}\u0000${m.model ?? ''}`;
      const cur = tally.get(k);
      const n = Number.isFinite(m.messages) ? m.messages : 0;
      if (cur) cur.messages += n;
      else tally.set(k, { provider: m.provider ?? '', model: m.model ?? '', messages: n });
    }
  }
  const list = [...tally.values()].sort((a, b) => b.messages - a.messages);
  const total = list.reduce((s, m) => s + m.messages, 0) || 1;
  const max = list[0]?.messages ?? 0;
  return {
    status: 'known',
    models: list.map((m) => ({
      provider: m.provider,
      model: m.model,
      messages: m.messages,
      share: +(m.messages / total).toFixed(4),
      dominant: m.messages === max,
    })),
    providers: [...new Set(list.map((m) => m.provider).filter(Boolean))],
    dominant: list[0] ? { provider: list[0].provider, model: list[0].model, dominant: true } : null,
    verifiedOn: [],
    unverifiedOn: [],
  };
}

/** 空归属（会话无模型字段 / 根本没拿到事件时用；**显式标 unknown，不留白**） */
export function unknownModelScope() {
  return buildModelScope([]);
}

/** 归一化任意来源的 scope 形态（缺字段补 unknown，防 zod strip 后成空对象） */
export function normalizeModelScope(scope) {
  if (!scope || typeof scope !== 'object') return unknownModelScope();
  if (scope.status !== 'known') return unknownModelScope();
  const models = Array.isArray(scope.models) ? scope.models : [];
  // ⚠️ status='known' 但一个模型都没有 = **数据自相矛盾**。这里必须落到
  // unknown，否则渲染层会输出「## 适用模型」标题下没有任何条目 —— 一个
  // 空章节比没有章节更糟（读者以为有归属，其实没有）。
  if (models.length === 0) return unknownModelScope();
  const dominant = (Array.isArray(scope.dominant) ? scope.dominant[0] : scope.dominant) ?? null;
  return {
    status: 'known',
    models: models.map((m) => ({
      provider: safeToken(m?.provider),
      model: safeToken(m?.model),
      share: Number.isFinite(m?.share) ? m.share : null,
      dominant: m?.dominant === true,
      messages: Number.isFinite(m?.messages) ? m.messages : null,
    })),
    providers: Array.isArray(scope.providers) ? scope.providers.map(safeToken).filter(Boolean) : [],
    dominant: dominant && typeof dominant === 'object'
      ? { provider: safeToken(dominant.provider), model: safeToken(dominant.model), dominant: true }
      : null,
    verifiedOn: Array.isArray(scope.verifiedOn) ? scope.verifiedOn.filter(Boolean) : [],
    unverifiedOn: Array.isArray(scope.unverifiedOn) ? scope.unverifiedOn.filter(Boolean) : [],
  };
}

/**
 * 审计/日志用的紧凑摘要（2026-10-03）。
 *
 * 为什么不让审计直接存完整 scope：完整形态带 models[] 与 share，一批 pattern
 * 的审计行会明显变胖，而审计的用途是「事后回答是哪个模型」，不需要占比小数。
 * 未知时**显式写 status:'unknown' + 空数组**（不留白——留白会被读成「没这项」）。
 */
export function summarizeModelScope(scope) {
  const s = normalizeModelScope(scope);
  if (s.status === 'unknown') {
    return { status: 'unknown', models: [], dominant: null };
  }
  return {
    status: 'known',
    models: s.models.map((m) => ({ provider: m.provider, model: m.model, share: m.share })),
    dominant: s.dominant ? { provider: s.dominant.provider, model: s.dominant.model } : null,
  };
}

// ── 渲染 ────────────────────────────────────────────────────────────────

/**
 * 模型标签（纯展示）。
 *
 * ⚠️ `safeToken` 是**白名单**（只放行 `[\w.@:/+-]`）：任何含换行、`:`、`#`、
 * 引号等字符的模型名都会被剥成空串。这样做换来一条硬保证 ——
 * **注入不到 YAML**，因为危险字符在到达 yamlScalar 之前就已经没了
 * （staging.js 的 yamlScalar 是第二道防线，不是唯一一道）。
 * 代价：provider 与 model 同时为空时会渲染成「未标注模型」。这不是 bug，
 * 是「证据在但两个标识都被剥掉了」的诚实说法，不许静默丢弃整条记录。
 */
function modelLabel(m) {
  const provider = safeToken(m?.provider);
  const model = safeToken(m?.model);
  if (provider && model) return `${provider}/${model}`;
  return model || provider || '未标注模型';
}

/** frontmatter 专用标签：**不用**兜底文案（那里不该出现「未标注模型」）。 */
function modelLabelStrict(m) {
  const provider = safeToken(m?.provider);
  const model = safeToken(m?.model);
  if (provider && model) return `${provider}/${model}`;
  return model || provider;
}

/**
 * frontmatter 里的模型字段（结构化；宿主只读 name/description，其余字段被忽略，
 * 取证：dsh-skill-filesystem `parseSkillFile` 只挑 name/description/whenToUse/
 * metadata/两个 invocation 布尔 ⇒ 额外字段**不会**导致技能被忽略）。
 *
 * 形态选择：模型清单既写 `models`（数组，给机器读）又写 `verified-on`
 * （字符串，给人和 grep 读）。两个都要——只有数组的话 `grep verified` 搜不到。
 */
export function renderModelFrontmatter(scope) {
  const s = normalizeModelScope(scope);
  if (s.status === 'unknown') {
    return {
      'model-scope': 'unknown',
      'verified-on': [],
      'verified-on-note': '来源会话无模型字段（v3 会话或 tool-stats 源）。按「适用性未经任何模型验证」对待。',
    };
  }
  const labels = s.models.map(modelLabelStrict).filter(Boolean);
  // labels 空 = 有模型记录但两个标识都被 safeToken 剥空（全是危险字符）。
  // 此时写 `model-scope: observed` + 空清单 = 「说观察到了，却一个都列不出」，
  // 自相矛盾。按 unknown 处理更诚实。
  if (labels.length === 0) {
    return {
      'model-scope': 'unknown',
      'verified-on': [],
      'verified-on-note': '模型标识含不可用字符，已全部剔除。按「适用性未经任何模型验证」对待。',
    };
  }
  return {
    'model-scope': 'observed',
    'verified-on': labels,
    'verified-on-note': labels.length > 1
      ? `经验在 ${labels.length} 个模型上被观察到；未列出的模型按「未验证」对待。`
      : '经验仅在下列模型上被观察到；其他模型按「未验证」对待。',
  };
}

/**
 * 正文里的「适用模型」段（纯函数；**无内容则返回空串**，宁缺毋滥）。
 *
 * 写法上的两个刻意选择：
 *  ① 主体（步骤/为什么/避坑）保持跨模型可迁移 —— 本段是**附加**说明，
 *     不是把技能锁死在某个模型上（老板要求：保留通用性与可复用）。
 *  ② 风险提示写成可执行的判断（"先跑一次小样本对照"），
 *     不写"可能不适用"这类无信息量的免责话术。
 */
export function renderModelSection(scope) {
  const s = normalizeModelScope(scope);
  const lines = ['## 适用模型', ''];

  if (s.status === 'unknown') {
    lines.push(
      '- 来源会话日志无模型字段，**无法确定这条技能是在哪个模型上积累的**'
      + '（常见于 v3 格式会话，或数据来自 tool-stats 而非会话日志）。',
      '- 按「适用性未经任何模型验证」对待：首次使用先小样本试跑，别直接套用到批量任务。',
      '',
    );
    return lines.join('\n');
  }

  const labeled = s.models
    .map((m) => ({ m, label: modelLabelStrict(m), share: Number.isFinite(m.share) ? `（占记录 ${(m.share * 100).toFixed(0)}%）` : '' }))
    .filter((x) => x.label);
  // 与 renderModelFrontmatter 同口径：全被剥空就不列，改按未知处理
  if (labeled.length === 0) {
    lines.push(
      '- 模型标识含不可用字符，已全部剔除，**无法确定这段经验来自哪个模型**。',
      '- 按「适用性未经任何模型验证」对待：首次使用先小样本试跑。',
      '',
    );
    return lines.join('\n');
  }
  const shown = labeled.slice(0, MODELS_DISPLAY_MAX);
  for (const x of shown) lines.push(`- ${x.label}${x.share}`);
  lines.push('');

  if (labeled.length > shown.length) {
    lines.push(
      `- 另有 ${labeled.length - shown.length} 个模型出现在同一批记录里（占比低于 `
      + `${(MODELS_DISPLAY_MIN_SHARE * 100).toFixed(0)}%，未单列）；完整清单见 manifest.json 的 modelScope。`,
      '',
    );
  }

  lines.push(
    '**跨模型复用注意**：',
    '',
    '- 上面的模型是这段经验的**来源**，不是本技能的唯一可用对象。'
    + '步骤本身是通用的，不同模型都应能照做。',
    `- 不同模型的盲区不同：来源模型没犯的错，换个模型可能反而会犯`
    + `（多这一步、或它自己会用更直接的办法）。`,
    '- 在**未列出的模型**上使用前，先拿一个小样本任务对照跑一次；'
    + '若结果明显更差，说明那条步骤对该模型是冗余的，可按其惯用做法改写本段。',
    '',
  );
  return lines.join('\n');
}

// ── 判据（warn only） ───────────────────────────────────────────────────

function finding(code, message, location) {
  return { family: MODEL_SCOPE_FAMILY, severity: RULE_SEVERITY[code] ?? 'warn', code, message, location };
}

/**
 * 模型归属判据。**永不返回 blocker**（见文件头「边界」）。
 *
 * @param {object} args
 * @param {object} [args.scope]     模型归属对象（frontmatter.modelScope / 已构造的）
 * @param {string} [args.body]     技能正文
 * @param {object} [args.draft]    技能草稿（scope 缺省时从这里取）
 * @returns {Array<{family,severity,code,message,location}>}
 */
export function checkModelScope({ scope, body = '', draft = null } = {}) {
  const raw = scope ?? draft?.frontmatter?.modelScope ?? draft?.modelScope;
  const s = normalizeModelScope(raw);
  const findings = [];

  // 字段整个不存在（手工草稿 / 存量候选）vs 存在但取不到值（v3 会话、
  // tool-stats 源）——**两件事，不是一条**：前者是"没这个维度"（不该报警），
  // 后者是"有维度但取不到证据"（该报，否则适用范围不明这件事不可见）。
  // 注意 renderSkillMd 同样按 `!== null` 才写 frontmatter，两处口径一致。
  if (raw === undefined || raw === null) return findings;

  if (s.status === 'unknown') {
    findings.push(finding('model-scope-unknown-source',
      '技能的来源模型未知——本条经验没有在任何特定模型上被验证过。'
      + '不影响发布，但使用者必须知道「适用前提未知」；补模型归属的方法见 renderModelSection 的 unknown 分支',
      'frontmatter.modelScope'));
    return findings;
  }

  if (s.models.length > 1) {
    findings.push(finding('model-scope-unverified-transfer',
      `这段经验在 ${s.models.length} 个模型上被观察到（${s.models.map(modelLabel).join('、')}），`
      + '但没有区分「哪些模型验证过哪些步骤」。跨模型复用前，按「未在目标模型上验证」对待：'
      + '先小样本对照跑一次',
      'frontmatter.modelScope.verifiedOn'));
  }

  const text = String(body ?? '');
  if (text && !text.includes('## 适用模型')) {
    findings.push(finding('model-section-missing-in-body',
      'frontmatter 已标注模型归属，但正文没有「## 适用模型」段——'
      + 'frontmatter 只在技能被选中时可见，正文才是执行者实际读到的东西。适用前提必须写进正文',
      'body'));
  }

  return findings;
}

/** 只取 warn（与 semantics/authoring 的 blockersOf 同形态；本族无 blocker） */
export function modelScopeWarningsOf(findings) {
  return (findings ?? []).filter((f) => f?.severity === 'warn');
}