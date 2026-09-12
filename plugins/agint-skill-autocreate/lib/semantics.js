/**
 * lib/semantics.js — 技能草稿的「语义准入」检查（2026-09-13 新增）
 *
 * 来源：P2-2 §六ter **建议 A**（Hermes `_DO_NOT_CAPTURE_BLOCK` 对照）+
 *      **建议 C**（候选命名的类级约束，Hermes `background_review.py:414-418`）。
 *
 * 一句话动机：既有的 4 道发布门 + Phase 1 静态 4 族**只问"危不危险"，
 * 不问"这东西是不是垃圾"**。本模块补的就是后者。
 *
 * **为什么实现在 autocreate 内部，而不是给 agint-quality-static 加新族**：
 *   ① 规则 4 需要 `pattern.successRate`——autocreate 的私有数据；
 *      quality-static 的 checker 只吃 `pluginDir`，拿不到；
 *   ② quality-static 被多方消费，加族会外溢影响面（plugin-check 等）；
 *   ③ 输入本来就是内存里的 `skillDraft` 对象，不必先物化成 SKILL.md 再读回来。
 * 因此这里实现为 evaluator **Phase 1 的第二段检查**：findings 与 quality-static
 * 同格式（{ family, severity, message, code, location }），合并进
 * `phase1.findings` 后统一按 blocker 判定——调用方无需感知有两段。
 *
 * 纯函数，无 I/O，可单测。
 */

import { DEFAULT_MIN_SUCCESS_RATE } from './detector.js';

/** 语义规则族名（A 四条） */
export const SEMANTICS_FAMILY = 'skill-semantics';
/** 命名约束沿用 quality-static 既有族名，不自造第三套 */
export const NAMING_FAMILY = 'skill-format';

// ── 词表（改这里 = 改规则；全部有单测覆盖）──────────────────────────────

/** 规则 1：环境依赖失败特征 */
const ENV_FAILURE_RE = /(command not found|No such file or directory|ModuleNotFoundError|Cannot find module|ENOENT|EACCES|Permission denied|未安装|缺少依赖|未配置|no credentials|credentials not)/i;
/** 规则 1：同段落出现的修复动作 → 说明是"踩坑+解法"，值得留下 */
const ENV_FIX_RE = /(安装|install|npm i|pnpm |yarn add|pip install|配置|export\s|设置|修复|解决|改用|替代|升级|chmod|apt-get|brew|启用|开启)/i;

/** 规则 2：对工具能力的负面断言（X 不能用 / 不支持 / 失效） */
// 工具名允许英文（terminal / git / file_read）与中文（浏览器 / 终端），
// 否则中文正文里的负面断言会整条漏掉。
const NEG_CAPABILITY_RE = /([A-Za-z0-9_\-\.]{2,30}|[\u4e00-\u9fa5]{2,8})\s*(?:工具|命令|插件|模块|tool)?\s*(?:不能用|无法使用|不支持|不可用|已损坏|失效|用不了|不工作|跑不通)/i;
/** 规则 2 豁免：句子里带版本/条件限定 → 是"某版本的确不行"，不是永久断言 */
const QUALIFIER_RE = /(版本|v\d|旧版|旧版本|新版|在.{1,24}(?:下|时|前|后|环境)|当|之前|以后|until|since|<=|>=|临时|暂时|目前|当前|截至)/i;

/** 规则 3：瞬时错误痕迹（错误码 / 堆栈 / 退出码） */
// 错误码走白名单而非「大写字母串」——后者会把 EXAMPLE / ERROR 这类普通词也命中。
const TRANSIENT_ERROR_RE = /(Error:|Traceback|at\s+[\w$.]+\s*\(.*:\d+:\d+\)|exit code\s+\d+|HTTP\s+[45]\d\d|\b(?:ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ETIMEDOUT)\b|\bERR_[A-Z_]+\b|堆栈|崩溃)/;
/** 规则 3：同段落有应对动作 → 说明不是"自愈了就忘了" */
const TRANSIENT_FIX_RE = /(重试|retry|修复|规避|workaround|改用|替代|解决|恢复|回滚)/i;

/** 规则 4：把做法包装成"推荐/最佳实践"的措辞 */
const PRESCRIPTIVE_RE = /(推荐做法|建议流程|最佳实践|推荐流程|标准做法|推荐步骤|首选方案|应当始终|建议始终|always use|best practice|recommended)/i;

/** 建议 C：会话产物式命名 */
const NAME_BAD_PREFIX_RE = /^(fix|debug|hotfix|tmp|temp|todo|wip|test|try)-/i;
const NAME_DATE_RE = /(\d{8}|\d{4}-\d{2}-\d{2}|\d{4}_\d{2}_\d{2})/;
const NAME_ISSUE_RE = /#\d+/;

// ── 文本切分工具 ────────────────────────────────────────────────────────

/** 按空行切段落（规则 1/3 的"同段落"判据） */
function paragraphs(text) {
  return String(text ?? '').split(/\n\s*\n/).filter((p) => p.trim());
}

/** 按句末标点切句（规则 2 的"同句"判据） */
function sentences(text) {
  return String(text ?? '').split(/[。；;\n!?！？]/).filter((s) => s.trim());
}

function finding(family, severity, code, message, location = 'SKILL.md') {
  return { family, severity, code, message, location };
}

/**
 * 语义准入检查主入口。
 *
 * @param {object} args
 * @param {object} args.draft    技能草稿（skillDraft：name / frontmatter / body）
 * @param {object} args.pattern  关联 task_pattern（规则 4 用 successRate）
 * @param {object} args.cfg      effectiveConfig（semantics_check_enabled / min_pattern_success_rate）
 * @returns {Array<{family,severity,code,message,location}>} findings（与 quality-static 同格式）
 */
export function checkSkillSemantics({ draft, pattern = {}, cfg = {} } = {}) {
  // 总开关：默认开（这是防垃圾的门，不是可选增强）；置 false 可整体退回旧行为
  if (cfg.semantics_check_enabled === false) return [];

  const findings = [];
  const body = String(draft?.body ?? '');
  const name = String(draft?.name ?? draft?.frontmatter?.name ?? '');
  const minRate = Number.isFinite(cfg.min_pattern_success_rate)
    ? cfg.min_pattern_success_rate
    : DEFAULT_MIN_SUCCESS_RATE;

  // ── 建议 C：候选命名约束（family: skill-format，blocker）─────────────
  // Hermes 判据："If the proposed name only makes sense for today's task, it's wrong."
  if (name) {
    if (NAME_BAD_PREFIX_RE.test(name)) {
      findings.push(finding(NAMING_FAMILY, 'blocker', 'skill-name-session-artifact',
        `技能名 "${name}" 是会话产物名（命中 fix-/debug-/hotfix-/tmp-/todo-/wip- 等前缀）——只在本次任务语境下说得通，会让技能库碎片化。改成类级名：描述"哪一类问题"，而不是"这次修了什么"`,
        'frontmatter.name'));
    }
    if (NAME_DATE_RE.test(name)) {
      findings.push(finding(NAMING_FAMILY, 'blocker', 'skill-name-date',
        `技能名 "${name}" 含日期——时间点是会话属性，不是知识属性；同一个问题下个月再来一次会又生成一个技能`,
        'frontmatter.name'));
    }
    if (NAME_ISSUE_RE.test(name)) {
      findings.push(finding(NAMING_FAMILY, 'blocker', 'skill-name-issue-ref',
        `技能名 "${name}" 含 issue/PR 编号——编号指向单次事件，不指向可复用的方法`,
        'frontmatter.name'));
    }
  }

  // ── 规则 2：对工具能力的负面断言（blocker）─────────────────────────────
  // Hermes 原文理由：这类话会硬化成模型引用数月的自我拒绝——今天写"浏览器工具
  // 不能用"，三个月后环境早修好了，模型还拿它当挡箭牌。
  for (const s of sentences(body)) {
    const m = NEG_CAPABILITY_RE.exec(s);
    if (m && !QUALIFIER_RE.test(s)) {
      findings.push(finding(SEMANTICS_FAMILY, 'blocker', 'tool-capability-negative-claim',
        `对工具能力的负面断言："${m[0].trim()}"——无版本/条件限定，会被后续会话当成长期事实引用。若确为永久限制，请写明版本或条件（如"v0.8 及以前不支持 X"）；否则删除`));
      break; // 一条足够定位问题
    }
  }

  // ── 规则 1：环境依赖失败，但同段落没有解法（warn）─────────────────────
  // 环境相关的失败只许记**修复方法**，不许记结论（否则换个环境就是错的）。
  for (const p of paragraphs(body)) {
    if (ENV_FAILURE_RE.test(p) && !ENV_FIX_RE.test(p)) {
      findings.push(finding(SEMANTICS_FAMILY, 'warn', 'env-failure-without-fix',
        '正文提到环境依赖失败（缺依赖/未配置/无凭证），但同段落没有给出修复步骤。环境类故障只应沉淀"怎么修"，不应沉淀"它坏了"'));
      break;
    }
  }

  // ── 规则 3：会话内自愈的瞬时错误（warn）───────────────────────────────
  for (const p of paragraphs(body)) {
    if (TRANSIENT_ERROR_RE.test(p) && !TRANSIENT_FIX_RE.test(p)) {
      findings.push(finding(SEMANTICS_FAMILY, 'warn', 'transient-error-without-handling',
        '正文含具体错误码/堆栈，但同段落没有应对动作（重试/规避/修复）。瞬时错误自愈后就忘掉，不该作为经验固化'));
      break;
    }
  }

  // ── 规则 4：未解决的失败不许包装成"推荐流程"（blocker）────────────────
  // 最要命的一条：对应"把失败写成经验"这一最危险的污染模式。
  // 注：检测层（建议 B）已先拦一道，这里是评估层兜底——防检测层漏网或门槛被调松。
  const sr = pattern?.successRate;
  if (PRESCRIPTIVE_RE.test(body) && Number.isFinite(sr) && sr < minRate) {
    findings.push(finding(SEMANTICS_FAMILY, 'blocker', 'failure-dressed-as-best-practice',
      `草稿声称"推荐/最佳实践"，但关联模式成功率仅 ${sr}（< ${minRate}）——未解决的失败不许包装成推荐流程，否则下一个会话会当真照做`));
  }

  return findings;
}

/** 只取 blocker（evaluator 判拒用） */
export function blockersOf(findings) {
  return (findings ?? []).filter((f) => f?.severity === 'blocker');
}
