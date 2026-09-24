/**
 * agint-rules: host service plugin (provides `agint.rules`).
 *
 * HOST plane, single instance: opens the `agint_rules` storage domain once
 * (separate from `agint` / `agint_rules` would collide on `already-open`)
 * and serves every session. Tools consumer lives in the preset.
 *
 * Two Cordis event hooks wire rule enforcement into the live tool flow:
 *   - tools/pre-execute waterfall:
 *       rules with action 'deny' / 'ask'  →  return kind: 'deny'/'ask'
 *       rules with action 'advisory'      →  fall through to next()
 *   - tools/post-execute waterfall:
 *       rules with action 'advisory'      →  attach additionalContexts that
 *                                             tell the model "this matched a
 *                                             rule, please consider X"
 *                                             (this is the design's half-
 *                                             mandatory reminder:  the card
 *                                             appears,  the call is allowed)
 *
 * Per-call audit (matched/hit counters) lives in an in-memory Map so the
 * preset tools can report "advisory rate" / "rule adherence" without
 * touching storage. No persistence: the counter resets on reload,  which
 * matches how metrics are computed fresh each session.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-rules
 *         name: ./plugins/agint-rules/lib/index.js
 */

import { randomUUID } from 'node:crypto';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const name = 'agint-rules';
const inject = ['storageDomain'];

const Config = z.object({}).optional();

// action 'advisory' → only a reminder (post-execute additionalContexts)
// action 'ask'      → pre-execute kind: 'ask' (user prompted for confirmation)
// action 'deny'     → pre-execute kind: 'deny' (hard block,  reserved for
//                     genuinely destructive patterns; approval stack also
//                     handles these but defense in depth is the point)
const ActionSchema = z.enum(['advisory', 'ask', 'deny']);

const ruleSchema = z.object({
  id: z.string().min(1),
  // Which tool name to scope to. '*' = any tool (pattern matches command text).
  tool: z.string().min(1).default('*'),
  // Regular expression source string. Compiled at match time (no need to
  // persist compiled RegExp — JSON-safe).
  pattern: z.string().min(1),
  // Optional flags string,  e.g. 'i' for case-insensitive. Defaults to none.
  flags: z.string().default(''),
  action: ActionSchema,
  level: z.enum(['L1', 'L2', 'L3', 'L4']).default('L2'),
  reason: z.string().min(1),
  enabled: z.boolean().default(true),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
  // ─── D-QAF frozenness 字段 (提案 a6ba79a3) ────────────────────────
  // 决定谁能修改这条规则：L0=人类多签，L1=policy 可撤销(带冷却),
  // L2=Agent 全权(只记日志)。默认 L2-delegable 保证向后兼容。
  // 判定标准：违反后没有任何运行时缓解手段的 → L0。
  frozenness: z.enum(['L0-frozen', 'L1-revocable', 'L2-delegable']).default('L2-delegable'),
  /** 最近一次 frozenness/规则内容变更时间 */
  lastChangedAt: z.string().optional(),
  /** L1 软删除倒计时(ISO 时间戳)，L0/L2 不用 */
  softDeleteDeadline: z.string().optional(),
  // ─── 断言型护栏（epistemic guard, 2026-09-21）───────────────────────
  // 与 pattern 是**互斥的两条匹配通道**：
  //   · pattern  → 正则打在工具参数文本上（动作层：别删这个文件）
  //   · claim    → 匹配面是**文本里的断言形状**（认知层：别说这句话除非你有证据）
  // 二者只有一个允许非空。claim 规则必须声明 claimKind + claimVerbs。
  /** 断言类型：existence=存在性断言 / quantifier=全称量化 / negated-self=否定式自述 */
  claimKind: z.enum(['existence', 'quantifier', 'negated-self']).optional(),
  /** existence 通道的被否定的谓词，如 ['不存在','没有','未挂载','不支持'] */
  claimVerbs: z.array(z.string()).optional(),
  /** 断言必须同时命中的限定词（可选，用于收窄） */
  claimQualifiers: z.array(z.string()).optional(),
  /** 是否为断言通道规则 */
  claim: z.boolean().default(false),
});

const spec = defineDomain({
  name: 'agint_rules',
  version: 1,
  tables: { rule: { valueSchema: ruleSchema } },
});

// Seed rules — fail loud on `rm -rf /`, confirm force pushes,  advise on
// npm publish. Real deployments would load these from a file; this is the
// minimum for the first session.
const seedRules = [
  {
    id: 'bash-rm-rf-root',
    tool: 'bash',
    // Match: rm -rf (with any combo of r/f/R/F flags) followed by EITHER
    //   a bare `/` (possibly followed by `*`) or `~` (with or without slash)
    //   or `$HOME` literal, and the path ENDS there (no further path
    //   components). Negative lookahead `(?!\S)` ensures we don't trigger on
    //   `rm -rf /tmp/build` or `rm -rf /var/log`.
    pattern: '\\brm\\s+-[a-zA-Z]*[rfRF][a-zA-Z]*\\s+(/\\*?\\s*|~/\\s*|~\\s*|\\$HOME\\s*)(?!\\S)',
    flags: 'i',
    action: 'deny',
    level: 'L1',
    reason: '拒绝删除根目录或整个 $HOME 的命令 — 这是不可逆的破坏性操作，请用更精确的路径。',
  },
  {
    id: 'bash-git-push-force-main',
    tool: 'bash',
    pattern: 'git\\s+push\\s+(?:--force(?:\\b|-)|-f\\b)[^|;&]*\\b(?:origin\\s+)?(?:main|master)\\b',
    flags: 'i',
    action: 'ask',
    level: 'L2',
    reason: '强制推送到 main/master 会覆盖远端历史，先确认是受保护的分支。',
  },
  {
    id: 'bash-npm-publish',
    tool: 'bash',
    pattern: '\\bnpm\\s+publish\\b|\\bpnpm\\s+publish\\b|\\byarn\\s+publish\\b',
    flags: '',
    action: 'advisory',
    level: 'L3',
    reason: '发布到 npm 会公开当前包 — 确认版本号、registry、和 dry-run 已经核对。',
  },
  // Sprint 3.3: 禁止删除 evolution-log（ROADMAP §P3 §进化记忆层）
  // DSH 默认把 evolution-log 存在 $DSH_HOME/storages/agint_evolution/evolution_log/
  // (对应 plugins/agint-evolution-memory 的 storage domain 名)。
  // 任何 rm / unlink / rmdir 命中此路径都拒绝。
  // mv / cp / rotate（保留 backup 后删原文件）不被命中（allow）。
  {
    id: 'bash-delete-evolution-log',
    tool: 'bash',
    // Match: rm/unlink/rmdir 命中 $DSH_HOME/storages/agint_evolution/evolution_log/
    // 或 ~/.dsh/storages/agint_evolution/evolution_log/。路径不能含 ..（防 symlink 逃逸）。
    pattern: '\\b(?:rm|unlink|rmdir)\\s+(?:-[a-zA-Z]*\\s+)*[\'"]?\\$DSH_HOME/storages/agint_evolution/evolution_log/[^\'"\\s]+[\'"]?|[\'"]?(?:~\\/\\.dsh|/root/\\.dsh)/storages/agint_evolution/evolution_log/[^\'"\\s]+[\'"]?',
    flags: '',
    action: 'deny',
    level: 'L1',
    frozenness: 'L0-frozen',  // 必须 human multi-sign 才能修改这条规则
    reason: '禁止删除 evolution-log 历史记录 — 这是系统自进化的不可篡改审计日志。如果需要 rotate，请 mv 到 backup 目录（agint-rules 不拦截）。',
  },
];

function compilePattern(rule) {
  // pattern + flags → RegExp. Invalid patterns are dropped silently at match
  // time; lint() surfaces them.
  try {
    return new RegExp(rule.pattern, rule.flags || undefined);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 断言型护栏引擎（epistemic guard）
//
// 起因（2026-09-21 复盘）：本工作区 30+ 条 K 记录里，同一族错误反复出现——
//   ① K30 假设了不存在的接口（5 个事件名全库 grep 命中 0 却写进设计稿）
//   ② K34 把存在的接口判成"自造字段"（反向幻觉，更隐蔽）
//   ③ K33 断言"宿主无 pre-compact 钩子"，实测三样都有
//   ④ K68 拿写入占位值当评分输出，断言"信号数恒 1"
// 共同动作 = **用"看起来对"的推理替代"跑一遍"的验证**。
//
// 这类错误不会当场炸（不像删错文件），所以现有动作层正则护栏一条都拦不到它。
// 引擎的立场：不检查内容真伪（做不到），只检查**断言有没有带证据**。
// 命中 → 记 audit（可观测）；高危 → 注入 advisory 提醒附上取证建议。
//
// ⚠️ 设计铁律：**豁免优先于命中**。误杀正常交流的代价 >> 漏放一条断言。
// ═══════════════════════════════════════════════════════════════════════

/** 证据指纹：命中任一即可豁免（已经取证过的断言不该被拦） */
const EVIDENCE_RE = new RegExp([
  'grep', 'rg\\s', '命中\\s*\\d+', '命中\\s*0', '\\d+\\s*行',
  '行号', '\\.js:\\d+', '\\.mjs:\\d+', ':L\\d+',
  '证据\\s*[:：]', '源码\\s*[:：]', '取证', '实测', '已核对', '已复查',
  'K\\d{2}\\b', '第\\s*\\d+\\s*行',
].join('|'), 'i');

/** 疑问 / 待查语气 → 不是断言，放行 */
const QUESTION_RE = /[?？]|是否|有没有|是否已|是不是|大概|可能|也许|我猜|推测|怀疑|不确定|待确认|需要确认|要确认|先查|待查|还要查/;

/** 任务 / 祈使语气 → 不是断言，放行 */
const TASK_RE = /^(请|帮我|帮忙|麻烦|我们要|我们来|接下来|下一步|任务是|目标是)|请(帮我|你|确认|核|查|看|补|改|写|跑|验证)/;

/** 未取证自述 → 已是诚实表述，放行 */
const HEDGE_RE = /还没查|未查|尚未核|没核实|没有核实|暂未|待取证|没有证据|仅凭印象|凭印象/;

/** 中文否定谓词（existence 通道的默认动词集） */
const NEG_EXISTENCE_VERBS = [
  '不存在', '没有', '未定义', '没定义', '不支持', '不可用', '无法',
  '未挂载', '没挂载', '未接', '没接', '没有接', '不通', '不可见',
  '空转', '从未', '检索不到', '查不到', '找不到', '缺席',
  // 「无」单字是中文技术写作里最高频的否定谓词（"无生产调用者" / "无消费方" /
  // "无数据行"）。实测漏放（2026-09-21 E2E A 组）：只有「没有/不存在」时，
  // 「宿主无 pre-compact 钩子」「runPreCompressCheckpoint 无生产调用者」
  // 两句真实的历史错判**都逃掉了**。补进来。
  '无', '未', '没', '非', '缺',
];

/**
 * ⚠️ 危险宾语豁免（**优先级最高**，任何通道生效前先过这一关）
 *
 * 这些宾语指向的"不存在"是**事实陈述而非可取证断言**：
 *   · 权限   —— "我没有权限"不是我没查，是系统告诉我了（工具会直接报 403）
 *   · 报错/异常 —— 是观测结果
 *   · 时间/计划 —— "还没有到时间"
 *   · 需求/必要/意义 —— 价值判断
 * 实测（2026-09-21 E2E B 组）：不加这条会误杀"我没有权限访问那个目录"。
 *
 * ⚠️ 词表要**窄**：首版把「理由」也放进来，结果"dedupe 吃掉了 83 条，**理由**是
 * 相似度高"这句真断言被豁免了（该句正确结论应是"判据归因错误"）。价值判断类
 * 只保留真正无争议的，宁可漏放"没有必要"，也别放过一条判据错误。
 */
const BENIGN_OBJECT_RE = /权限|授权|许可|报错|错误|异常|时间|计划|安排|必要|需求|办法|意义|资格|机会/;

/** 否定式自述的合法宾语：权限/能力/工具，不是操作行为 → 放行 */
const NEG_SELF_BENIGN_RE = /权限|授权|许可|资格|能力|工具|权限|访问权|账号/;

/** 存在性断言的宾语必须指向技术实体，否则会误杀日常用语 */
const TECH_OBJECT_RE = /源码|代码|接口|函数|方法|类|模块|插件|文件|目录|仓库|字段|事件|服务|钩子|hook|API|命令|工具|行|表|域|依赖|配置|参数|schema|总线|链路|通路|管道|topic|主题|能力|信号|机制|通道|门禁|流程|数据|记录|调用者|调用方|消费方|生产|挂载|订阅|发布/;

/**
 * 全称量化断言：需要「量化词 + 复数宾语 + 封闭信号」三者同时成立。
 *
 * ⚠️ 封闭信号不能用 `已[经]?` —— "对所有正整数都**已经**成立"是数学陈述，
 * 会被误杀（2026-09-21 A/B 测试实测）。
 *
 * 那 `恒/永远/始终` 为什么可以进？因为它们是**断言性副词**（断言时间上无例外），
 * 而 `已经` 是**完成态助词**（不蕴含"无例外"）。实测本仓 KNOWLEDGE.md 的 105 处
 * `已*` 全部是完成态（已修/已完成/已同步/已验证/已排除/已就绪），故保留在
 * CLOSURE 里是安全的——但**必须配合量化词**使用（`信号数恒 1` 会命中，
 * `已经完成` 不会，后者没有量化词）。
 */
const QUANTIFIER_RE = /(全部|所有|全|每[一]?个|任何一个|无一|没有任何|全都|均|皆|一律|统统|完全|恒|永远|始终|从来|一直)/;

/** 全称量化的宾语也应是技术复数实体 */
const QUANT_OBJECT_RE = /条|个|项|类|种|次|候选|记录|规则|插件|技能|事件|文件|函数|测试|用例|信号|条目|会话|job|任务|回声|重复|命中|结果|候选/;

/** 封闭信号：真正表明"无例外"的形态（见上文对「已经」的说明） */
const QUANT_CLOSURE_RE = /[了啦]$|被|一律|均|统统|完全|全部|无一|\d+\s*[条个项类种次]|恒|永远|始终|从来|一直/;

/**
 * 评估单条断言型规则。
 *
 * @param {object} rule  含 claim/claimKind/claimVerbs 的规则对象
 * @param {string} text  待检文本（模型的自然语言输出）
 * @returns {{ruleId:string, claimKind:string, signal:string, reason:string}|null}
 */
export function evaluateEpistemic(rule, text) {
  if (!rule || rule.claim !== true || rule.enabled === false) return null;
  if (typeof text !== 'string' || text.length === 0) return null;

  // ── 豁免层（优先）：命中任一 → 不拦 ──────────────────────────────
  if (EVIDENCE_RE.test(text)) return null;   // 已带证据
  if (BENIGN_OBJECT_RE.test(text)) return null; // 权限/报错/时间等天然不可争议宾语
  if (QUESTION_RE.test(text)) return null;   // 疑问/推测
  if (TASK_RE.test(text)) return null;       // 任务/祈使
  if (HEDGE_RE.test(text)) return null;      // 已声明未取证

  const kind = rule.claimKind || 'existence';
  let signal = null;

  if (kind === 'existence') {
    // 条件/假设句不是断言：「如果接口不存在，我们就换一条路径」
    if (/(如果|若|假如|假设|若是|倘若|一旦)/.test(text)) return null;
    const verbs = (rule.claimVerbs && rule.claimVerbs.length ? rule.claimVerbs : NEG_EXISTENCE_VERBS);
    const hitVerb = verbs.find((v) => text.includes(v));
    if (hitVerb && TECH_OBJECT_RE.test(text)) {
      signal = hitVerb;
    }
  } else if (kind === 'quantifier') {
    if (QUANTIFIER_RE.test(text) && QUANT_OBJECT_RE.test(text)) {
      // 三者齐备才算全称断言：量化词 + 复数宾语 + 封闭信号。
      // 缺封闭信号 = 一般性陈述（"所有 X 都应满足 Y"），不该拦。
      if (QUANT_CLOSURE_RE.test(text)) {
        const m = text.match(QUANTIFIER_RE);
        signal = m ? m[0] : '全称';
      }
    }
  } else if (kind === 'negated-self') {
    // 「我没有删除过任何文件」—— 否定式第一人称自述，无法验证且常是替自己开脱。
    // 但「我没有权限访问 X」的宾语是权限/能力，不是操作 → 不是自证清白，放行。
    const negSelf = /(我|本人|这边)(们)?\s*(没有|从未|从没|并未|未曾|绝没)/;
    const actObj = /删除|移动|修改|改过|写过|执行|运行|创建|提交|推送|覆盖|碰过|接触/;
    if (negSelf.test(text) && actObj.test(text) && !NEG_SELF_BENIGN_RE.test(text)) {
      signal = '否定式自述';
    }
  }

  if (!signal) return null;

  return {
    ruleId: rule.id,
    claimKind: kind,
    signal,
    reason: rule.reason,
  };
}

/** 断言型护栏的内置种子（claim 通道的初始规则集） */
export function epistemicSeedRules() {
  return [
    {
      id: 'epistemic-negated-existence',
      claim: true,
      claimKind: 'existence',
      tool: '*',
      action: 'advisory',
      level: 'L2',
      reason: '这是一句「不存在/没有/不支持」型的存在性断言，但没带取证痕迹。'
        + '请先 grep 源码/查生产存储/实际跑一遍，把命中结果（文件:行号 或 命中 N 行）写进结论；'
        + '或改写成「我还没查」而不是「它不存在」——两者证据强度天差地别。',
      enabled: true,
    },
    {
      id: 'epistemic-quantifier',
      claim: true,
      claimKind: 'quantifier',
      tool: '*',
      action: 'advisory',
      level: 'L2',
      reason: '这是一句全称量化断言（全部/所有/均/无一…），但没带取证痕迹。'
        + '全称命题需要全量清单或计数支撑：给出 N/N 的分母，或改写成「我抽查的 N 条里 M 条…」。',
      enabled: true,
    },
    {
      id: 'epistemic-negated-self',
      claim: true,
      claimKind: 'negated-self',
      tool: '*',
      action: 'advisory',
      level: 'L2',
      reason: '这是一句「我没有做过 X」的否定式自述。这类陈述无法自我验证，'
        + '请改用可核对的形式：给出实际命令与输出（如 git log / 文件清单），让结论可被别人复核。',
      enabled: true,
    },
  ];
}

function argText(name, args) {
  // Convert common arg shapes into a single text blob for regex matching.
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  if (Array.isArray(args)) {
    if (name === 'bash') {
      // bash tool typically takes { command: "..." }
      return (args.command || args.cmd || '').toString();
    }
    return JSON.stringify(args);
  }
  if (typeof args === 'object') {
    if (typeof args.command === 'string') return args.command;
    if (typeof args.cmd === 'string') return args.cmd;
    return JSON.stringify(args);
  }
  return String(args);
}

/**
 * 构造 advisory 注入用的完整 UserMessage。
 *
 * ⚠️ 必须是完整 UserMessage（role + id），**不能**是裸的 {source, content}：
 *   - dsh 契约：`additionalContexts?: UserMessage[]`
 *     （@deepseek-ai/dsh-tools 类型声明，0.1.6-alpha.1 实测 8 处同款）
 *   - dsh 会话回放校验器 assertMessageEventShape
 *     （@deepseek-ai/dsh-session/lib/index.js）对 `user/message` 强制要求
 *     顶层 `id` 为非空字符串、`role` 为 'user'、`source.kind` 为字符串。
 *
 * 事故（2026-09-16）：本插件曾直接注入 `{ source, content }`。写盘路径容忍了它，
 * 但**读回/续接路径**把它判为 `session event at seq N lacks an identified message`
 * ——整个会话被判定 corrupt，会话历史再也打不开。全库扫描确认 14 处同源坏事件、
 * 12 个会话被砖（最早 2026-09-10）。
 *
 * 对齐写法：agint-restart 的 createUserMessage（手写 id，避免引入 dsh-llm 依赖）。
 *
 * @param {string} toolName 触发 advisory 的工具名
 * @param {Array<{ruleId:string, level:string|number, reason:string}>} advisories 首次命中的规则
 * @returns {{role:'user', content:{type:'text',text:string}[], source:{kind:'plugin',plugin:string,form:string}, id:string}}
 */
export function buildAdvisoryMessage(toolName, advisories) {
  const lines = advisories.map((a) => `• [${a.ruleId}] (${a.level}) ${a.reason}`);
  return {
    role: 'user',
    id: randomUUID(),
    // ⚠️ v4 硬契约（K78 / dsh 0.1.7+）：source.kind 必须是 producer-owned 形态
    // `plugin:<name>`。旧写法 kind:'plugin' 被 v4 校验硬拒 ——
    // "format v4 message requires a producer-owned source kind"，注入那一轮直接失败。
    // `plugin` 字段保留（v4 迁移会丢弃它，但 AGINT 测试与审计按它认人）。
    source: { kind: `plugin:${name}`, plugin: name, form: 'advisory' },
    content: [{
      type: 'text',
      text: `agint-rules advisory: tool=${toolName} matched ${advisories.length} rule(s).\n${lines.join('\n')}\n(本会话首次命中，仅提示一次；这是系统规则提醒，不是阻断。后续同规则命中不再重复注入。)`,
    }],
  };
}

/**
 * 构造断言型护栏的 advisory 注入。
 *
 * 与 buildAdvisoryMessage 分开：断言护栏的措辞不是"你违反了规则"，而是
 * "这句话需要证据"——避免模型把它读成指责后开始辩解（那是另一种浪费）。
 *
 * ⚠️ 与 buildAdvisoryMessage 同款硬契约：必须是完整 UserMessage
 * （role + id + content + source），否则会话回放校验器判 corrupt（K44.1）。
 */
export function buildEpistemicMessage(toolName, hits) {
  const lines = hits.map((h) => `• [${h.ruleId}] 触发词「${h.signal}」\n  ${h.reason}`);
  return {
    role: 'user',
    id: randomUUID(),
    source: { kind: `plugin:${name}`, plugin: name, form: 'epistemic-advisory' },
    content: [{
      type: 'text',
      text: `agint-rules 断言型护栏：刚才的 ${toolName} 输出里有 ${hits.length} 处**未取证的断言**。\n`
        + `${lines.join('\n')}\n`
        + `（这是提醒，不影响本次调用。请在下一次需要引用这些结论时补上取证：grep 命中结果 / 生产存储查询 / 实际执行输出。`
        + `若此刻确实还查不了，请把措辞改成「我还没验证」——不要让它以肯定句留在会话里。）`,
    }],
  };
}

/**
 * 从一次工具调用的「参数 + 结果」里抽出可扫描的自然语言文本。
 *
 * 为什么扫这里而不是直接扫模型消息流：post-execute 拿得到的只有 exec 与
 * result，没有"模型接下来会说那句话"的通道。但被护栏拦的断言**必然是在
 * 一次工具调用之后写下的结论**——把它们从工具产物里读出来，能在下一次
 * 模型请求前就完成提醒，属于半影子档（提醒不阻断）。
 *
 * 读不到就返回空串（静默跳过）。**不猜、不编**——这与 K47.1 「eventToText
 * 漏读 data.content 导致人类消息全不可见」是同一类坑的预防性写法。
 *
 * @returns {string} 拼接后的可扫描文本
 */
function extractScannableText(exec, result) {
  const parts = [];
  const push = (v) => { if (typeof v === 'string' && v) parts.push(v); };

  // 1) 调用参数里的自由文本（task / content / message / prompt / query ...）
  const args = exec && exec.arguments;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args)) {
      if (typeof v !== 'string') continue;
      if (/^(task|content|text|message|prompt|query|reason|note|summary|body|description)$/i.test(k)) {
        push(v);
      }
    }
  } else if (typeof args === 'string') {
    push(args);
  }

  // 2) 工具结果里的文本块（result.content: ContentBlock[]）
  const content = result && (result.content || (result.result && result.result.content));
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') push(block.text);
    }
  }

  return parts.join('\n');
}

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  // ctx.effect semantics: callback runs IMMEDIATELY, return value is disposer.
  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
        void d.close().catch(() => {});
        return null;
      }
      domain = d;
      return d;
    },
    (error) => {
      domainError = error;
      return null;
    },
  );

  const table = async () => {
    if (disposed) throw new Error('agint-rules: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-rules: domain unavailable');
    return d.table('rule');
  };

  const nowIso = () => new Date().toISOString();

  // In-memory audit counters. Keyed by rule id → { hits, denies, asks, advisories }.
  const audit = new Map();
  // Reminder dedup: `${ruleId}::${tool}` already injected in this plugin
  // lifetime (i.e. current session). Audit counters still count every hit.
  const reminded = new Set();
  function bump(ruleId, kind) {
    const cur = audit.get(ruleId) ?? { hits: 0, denies: 0, asks: 0, advisories: 0, epistemics: 0 };
    cur.hits += 1;
    if (kind === 'deny') cur.denies += 1;
    else if (kind === 'ask') cur.asks += 1;
    else if (kind === 'advisory') cur.advisories += 1;
    else if (kind === 'epistemic') cur.epistemics += 1;
    audit.set(ruleId, cur);
  }

  const agintRules = {
    async add(input) {
      const t = await table();
      const id = input.id ?? `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const existing = t.get(id);
      const rule = ruleSchema.parse({
        id,
        tool: input.tool ?? '*',
        pattern: input.pattern,
        flags: input.flags ?? '',
        action: input.action,
        level: input.level ?? existing?.level ?? 'L2',
        reason: input.reason,
        enabled: input.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      });
      await t.put(id, rule);
      return { ...rule };
    },

    async remove(id) {
      const t = await table();
      const ok = await t.delete(id);
      if (ok) audit.delete(id);
      return ok;
    },

    async setEnabled(id, enabled) {
      const t = await table();
      const rec = t.get(id);
      if (!rec) return null;
      const updated = { ...rec, enabled: Boolean(enabled), updatedAt: nowIso() };
      await t.put(id, updated);
      return { ...updated };
    },

    async list(filter = {}) {
      const t = await table();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.action && rec.action !== filter.action) continue;
        if (filter.tool && rec.tool !== filter.tool) continue;
        if (filter.enabled !== undefined && rec.enabled !== filter.enabled) continue;
        out.push({ id, ...rec });
      }
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    },

    async get(id) {
      const t = await table();
      const rec = t.get(id);
      return rec ? { ...rec } : null;
    },

    // Evaluate rules against a concrete (tool, args) call. Returns the
    // FIRST deny / ask match (so enforcement is unambiguous) plus all
    // advisory matches (so post-execute can attach them all).
    async check(tool, args, opts = {}) {
      const t = await table();
      const rules = [];
      for (const [, rec] of t.entries()) {
        if (!rec.enabled) continue;
        if (rec.tool !== '*' && rec.tool !== tool) continue;
        rules.push(rec);
      }
      const text = argText(tool, args);
      const deny = [];
      const ask = [];
      const advisory = [];
      const badPatterns = [];
      for (const rec of rules) {
        const re = compilePattern(rec);
        if (re === null) { badPatterns.push(rec.id); continue; }
        if (!re.test(text)) continue;
        if (rec.action === 'deny') deny.push({ ruleId: rec.id, action: rec.action, level: rec.level, reason: rec.reason });
        else if (rec.action === 'ask') ask.push({ ruleId: rec.id, action: rec.action, level: rec.level, reason: rec.reason });
        else if (rec.action === 'advisory') advisory.push({ ruleId: rec.id, action: rec.action, level: rec.level, reason: rec.reason });
      }
      return {
        tool,
        matched: deny.length + ask.length + advisory.length,
        deny,
        ask,
        advisory,
        invalidPatterns: badPatterns,
      };
    },

    // Audit log for the preset tools — which rules fired,  what counts.
    audit() {
      const out = [];
      for (const [id, counts] of audit.entries()) {
        out.push({ ruleId: id, ...counts });
      }
      out.sort((a, b) => b.hits - a.hits);
      const totals = out.reduce(
        (acc, r) => {
          acc.hits += r.hits; acc.denies += r.denies;
          acc.asks += r.asks; acc.advisories += r.advisories;
          acc.epistemics += r.epistemics || 0;
          return acc;
        },
        { hits: 0, denies: 0, asks: 0, advisories: 0, epistemics: 0 },
      );
      return { rules: out, totals };
    },

    // ── 断言型护栏公开接口（2026-09-21）───────────────────────────────
    // 与 check() 平行：check 吃 (tool, args) 走动作层；checkClaims 吃自由文本
    // 走认知层。两者共用同一张规则表的 audit 计数。
    /**
     * @param {string} text 模型输出文本
     * @returns {{hits:Array, checked:number}}
     */
    async checkClaims(text) {
      const t = await table();
      const hits = [];
      for (const [, rec] of t.entries()) {
        if (!rec.claim || !rec.enabled) continue;
        const m = evaluateEpistemic(rec, text);
        if (m) hits.push(m);
      }
      return { hits, checked: t.entries ? [...t.entries()].filter(([, r]) => r.claim).length : 0 };
    },

    /** 把断言型种子写入规则表（幂等：id 已存在则跳过） */
    async seedEpistemic() {
      const t = await table();
      const now = nowIso();
      let added = 0;
      for (const r of epistemicSeedRules()) {
        if (t.get(r.id)) continue;
        // claim 规则没有 pattern 字段；补一个永不命中的占位以保证 schema 通过
        await t.put(r.id, ruleSchema.parse({
          ...r,
          pattern: '(?!)',
          flags: '',
          createdAt: now,
          updatedAt: now,
        }));
        added += 1;
      }
      return { added, total: epistemicSeedRules().length };
    },

    // Lint the rule table for invalid patterns and duplicate-ish rules.
    async lint() {
      const t = await table();
      const issues = [];
      const all = [...t.entries()].map(([id, r]) => ({ id, ...r }));
      for (const r of all) {
        const re = compilePattern(r);
        if (re === null) issues.push({ ruleId: r.id, kind: 'invalid-pattern', detail: r.pattern });
      }
      // Pairwise: same tool + same action + overlapping pattern (rough).
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]; const b = all[j];
          if (a.tool !== b.tool) continue;
          if (a.action !== b.action) continue;
          if (a.enabled !== b.enabled) continue;
          if (a.pattern === b.pattern) {
            issues.push({ ruleId: a.id, kind: 'duplicate-pattern', with: b.id });
          }
        }
      }
      return issues;
    },

    // Seed rules on first boot (when table is empty).
    async seedIfEmpty() {
      const t = await table();
      let any = false;
      for (const _ of t.entries()) { any = true; break; }
      if (any) return { seeded: false, count: 0 };
      const now = nowIso();
      for (const r of seedRules) {
        await t.put(r.id, ruleSchema.parse({ ...r, createdAt: now, updatedAt: now }));
      }
      // 断言型种子单独播种：它们与动作型规则共存，且必须幂等
      // （老装机上表非空，seedIfEmpty 会提前返回 —— 所以另走 seedEpistemic）。
      const ep = await agintRules.seedEpistemic();
      return { seeded: true, count: seedRules.length, epistemic: ep.added };
    },

    // Internal — for boot-level diagnostics only.
    _audit: audit,
  };

  ctx.provide('agint.rules', agintRules);

  // -------- Event hooks: pre-execute (deny / ask) -------------------

  ctx.on('tools/pre-execute', async (exec, next) => {
    const rules = ctx.get('agint.rules');
    if (!rules) return next();
    let result;
    try {
      result = await rules.check(exec.name, exec.arguments);
    } catch {
      return next();
    }
    if (result.deny.length > 0) {
      const top = result.deny[0];
      bump(top.ruleId, 'deny');
      return { kind: 'deny', reason: `agint-rules [${top.ruleId}] ${top.reason}` };
    }
    if (result.ask.length > 0) {
      const top = result.ask[0];
      bump(top.ruleId, 'ask');
      return { kind: 'ask', reason: `agint-rules [${top.ruleId}] ${top.reason}` };
    }
    // Advisory: pass through, post-execute will attach reminders.
    return next();
  });

  // -------- Event hooks: post-execute (advisory additionalContexts) -

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const rules = ctx.get('agint.rules');
    if (!rules) return next();

    // ── 通道 1：动作层 advisory（原有行为，字节级不变）───────────────
    let check;
    try {
      check = await rules.check(exec.name, exec.arguments);
    } catch {
      check = { advisory: [] };
    }

    // Count every match (audit 要的是命中次数), but only *remind* once:
    // reminders are context injection, and re-injecting the same text on
    // every matching call bloats the session (observed 2026-09-10).
    const fresh = [];
    for (const a of check.advisory) {
      bump(a.ruleId, 'advisory');
      const key = `${a.ruleId}::${exec.name}`;
      if (reminded.has(key)) continue;
      reminded.add(key);
      fresh.push(a);
    }

    // ── 通道 2：认知层断言护栏（2026-09-21 新增）─────────────────────
    // 扫描对象 = 本插件所在 agent 平面上即将进入历史的消息文本。
    // ⚠️ 只在我们能明确读到文本时才扫；读不到就静默跳过（不猜、不编）。
    let claimHits = [];
    try {
      const text = extractScannableText(exec, result);
      if (text) {
        const r = await rules.checkClaims(text);
        claimHits = r.hits;
      }
    } catch {
      claimHits = [];
    }
    // 计数照记（可观测 > 可审批）；注入同样做会话级去重，避免刷屏
    const freshClaims = [];
    for (const h of claimHits) {
      bump(h.ruleId, 'epistemic');
      const key = `${h.ruleId}::${exec.name}`;
      if (reminded.has(key)) continue;
      reminded.add(key);
      freshClaims.push(h);
    }

    if (fresh.length === 0 && freshClaims.length === 0) return next();

    const messages = [];
    if (fresh.length > 0) messages.push(buildAdvisoryMessage(exec.name, fresh));
    if (freshClaims.length > 0) messages.push(buildEpistemicMessage(exec.name, freshClaims));

    // 只追加 additionalContexts，不替换 value / content：
    // dsh-tools 的 postExecute 禁止 accept 决策同时带 value 和 content
    // （否则整次工具调用被 TypeError 判失败），且替换会丢掉工具真实结果。
    // message 必须含 id + role:'user'（见 buildAdvisoryMessage 的事故注释）。
    return { kind: 'accept', additionalContexts: messages };
  });
}

export { Config, apply, inject, name };