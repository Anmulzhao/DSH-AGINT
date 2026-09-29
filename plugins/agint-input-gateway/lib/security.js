/**
 * agint-input-gateway — security 模块（v0.3.0）。
 *
 * 外部信号 prompt injection 门禁：对进入 gateway 的外部信号
 * （EXTERNAL / ADVERSARIAL / CROSS_AGENT 通道）做注入模式检测。
 *
 * 定位与策略：
 *   - 默认降级（action=flag）：命中信号附加 security 元数据后放行——
 *     不阻断主路径，让下游（agent / dream / 周报）看到"这条信号可疑"。
 *   - 显式配置 action=drop 才丢弃命中信号（kill-switch：drop 默认关）。
 *   - 规则集是"宁宽勿严"的复核信号，不是定罪：命中只代表文本模式可疑，
 *     最终判断留给调用方（外部信号本来就该被怀疑）。
 *
 * 命中即标记的理由（2026-09-29 落地）：
 *   C3/C4/C5 三类通道把外部世界/对抗/跨 Agent 内容灌入总线，
 *   prompt injection 是这类内容的首要威胁面；把检测做成 gateway 内
 *   强制步骤（不依赖下游自觉），命中附加审计信息，防"注入进记忆"。
 */

// ── 规则集 ────────────────────────────────────────────────────────────────
// 每条规则 = 正则 + 标签。正则覆盖中英文常见注入模式。
// 注意：这些正则只匹配"指令控制转移"的文本模式，不是普通闲聊。

const INJECTION_PATTERNS = Object.freeze([
  {
    id: 'hijack-ignore-en',
    label: '指令劫持(英): ignore previous/all instructions',
    re: /ignore\s+(all|previous|above|prior|everything)\b[\s\S]{0,60}(instructions?|commands?|rules?|prompts?|guidelines?|constraints?|directives?)/i,
  },
  {
    id: 'hijack-ignore-zh',
    label: '指令劫持(中): 忽略之前指令',
    re: /忽略(前面|之前|以上|所有|过去的|上面)[\s\S]{0,24}(指令|指示|要求|规则|提示|限制|设定|guidelines)/,
  },
  {
    id: 'override-en',
    label: '覆盖指令(英): disregard/override/bypass',
    re: /(disregard|override|bypass)\b[\s\S]{0,30}(previous|above|all|the\s+system|safety|security|rules|instructions|prompts?)\b/i,
  },
  {
    id: 'override-zh',
    label: '覆盖指令(中): 无视/绕过系统规则',
    re: /(无视|不要(管|理|遵守|遵循|理会)|绕过|推翻)[\s\S]{0,16}(之前|上面|上面所有|系统|安全|规则|限制|设定|指令)/,
  },
  {
    id: 'identity-hijack-en',
    label: '身份劫持(英): 扮演/假装你是',
    re: /(pretend\s+(to\s+be|you\s+are)|you\s+are\s+now\b|from\s+now\s+on\s+you(\s+are|'re)\b|as\s+an\s+AI\b)/i,
  },
  {
    id: 'identity-hijack-zh',
    label: '身份劫持(中): 扮演/你是',
    re: /(从现在起你是|你现在(要|必须|得|需要)?是|请(你)?扮演|你(要|必须|得)记住你(是|叫)|你就(是|当)我的|你不再是)/,
  },
  {
    id: 'system-prompt-probe',
    label: '系统提示词探测/泄露诱导',
    re: /(system\s+prompt|系统提示词|系统提示语|你的(底层|内部|系统|内置)(提示词|指令|设定|配置)|print\s+(your\s+)?(system\s+)?prompt|reveal\s+(your\s+)?(system\s+)?instructions|泄露|说出你的)/i,
  },
  {
    id: 'forged-tags',
    label: '伪造消息标签(<system>/<user>/[INST])',
    re: /<\s*(\/?)\s*(system|user|assistant|developer)(\s+role)?\s*>|\[\s*(system|user|assistant|INST)\s*\]/i,
  },
  {
    id: 'urgent-scam',
    label: '紧急施压话术(需人工复核)',
    re: /(urgent|immediately|right now|紧急|立刻|马上|必须现在)[\s\S]{0,20}(act|respond|do|执行|处理|回复|照做)/i,
  },
]);

/** 对一段文本做注入检测 → { verdict, matches } */
export function checkExternalText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { verdict: 'clean', matches: [] };
  }
  const matches = [];
  for (const rule of INJECTION_PATTERNS) {
    if (rule.re.test(text)) {
      matches.push({ ruleId: rule.id, label: rule.label });
    }
  }
  return { verdict: matches.length > 0 ? 'flagged' : 'clean', matches };
}

// ── payload → 文本（浅递归收集 string 值，截断防止超大 payload）───────────
const MAX_SCAN_BYTES = 16 * 1024;

function collectStrings(value, out, budget) {
  if (budget.used >= MAX_SCAN_BYTES) return;
  if (typeof value === 'string') {
    const take = value.slice(0, MAX_SCAN_BYTES - budget.used);
    out.push(take);
    budget.used += take.length;
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, budget);
  }
}

/** 对信号做注入检测：payload 中所有字符串拼接后跑规则集 */
export function checkSignal(signal) {
  const payload = signal?.payload ?? {};
  const parts = [];
  const budget = { used: 0 };
  collectStrings(payload, parts, budget);
  const text = parts.join('\n');
  const result = checkExternalText(text);
  // 无 payload 文本 → 视为 clean（不误报结构性问题）
  if (!text.trim()) return { verdict: 'clean', matches: [] };
  return result;
}

/** security 模块状态出口 */
export function getSecurityRules() {
  return INJECTION_PATTERNS.map(({ id, label }) => ({ id, label }));
}
