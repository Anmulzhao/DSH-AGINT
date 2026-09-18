/**
 * lib/authoring.js — 技能创作标准（authoring standard）的**可执行判据**（2026-09-18 新增）
 *
 * 来源：质量门方案 §3 **方案 B**（P0）——「把 authoring standard 落成可执行测试」。
 * 对照：Hermes `skills/AGENTS.md:24-56`（HARDLINE 创作标准）+
 *       `tests/skills/test_authoring_standards.py`（标准由**测试**强制，不靠自觉）。
 *
 * ── 为什么需要它（与既有三道门的分工，三者正交）─────────────────────────
 *   A1 / 门 5（detector / release-manager） 判「序列里有没有领域工具」→ 拦纯脚手架；
 *   A2 / A3（proposer / semantics）          判「正文有没有信息量」    → 拦空壳正文；
 *   **本模块**                               判「名字与描述能不能被用起来」。
 *
 * 一条技能完全可以**序列含领域工具、正文也扎实，名字却完全不可检索**——
 * 实测 `glob-glob-glob-glob` 正是这种：正文有真知识（多轮 glob 的切分策略、
 * read 抽样上限、`-ErrorAction SilentlyContinue`），但名字是工具序列拼接。
 * 名字与 `frontmatter.description` 是技能被发现的**唯一入口**，
 * 名字不可读 = 技能不可达 = 等于没沉淀。既有三门没有一条在问这件事。
 *
 * ── 一条硬约束（2026-09-18 取证，决定了规则能怎么定）────────────────────
 * 宿主 `@deepseek-ai/dsh-skill/lib/index.js:17`：
 *     const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
 * 且 `dsh-skill-filesystem/lib/index.js:685-686` 在 `isSkillName(name) === false` 时
 * **直接忽略该技能文件**（只打一行 warn）。即：
 *     **技能名只能是 ASCII kebab-case，中文名会被静默丢弃。**
 * 所以「名字要表达中文描述」不能靠改名解决（没有 transliterate 就没有中文名），
 * 只能靠**换命名来源**——本模块只负责把问题**判出来**，不替生成侧做决定。
 *
 * ── 判据的所有权（Hermes「同一教训只有一条」）────────────────────────────
 * 「正文含具体值」这条判据的所有者是 `templates.CONCRETE_RE`（A2/A3 在用），
 * **本模块不重复实现**——B 只测它、不另立一份。重复判据 = 两处阈值迟早不一致。
 *
 * 纯函数，无 I/O，全部字符串可判定（不让生成者自评）。
 */

/** 判据族名（与 semantics 的 `skill-semantics` 并列，不混用） */
export const AUTHORING_FAMILY = 'skill-authoring';

/**
 * description 长度上限（质量门方案 §3：≤ 60 字符）。
 *
 * ⚠️ **实测结论（2026-09-18 全量取证）：这条阈值在真实数据上不构成判别器，
 * 因此只可作 warn 观测，绝不可升级为 blocker。** 实测字符数分布：
 *   自动生成 5 个：60 / 71 / 113 / 118 / 133（最长 133）
 *   人工撰写 6 个：81 / 108 / 130 / 343 / 368 / 407（最长 407，`github-push`）
 * 两簇**完全重叠**——照 ≤60 判，6 个手工技能**全部**违规（`cordis-plugin-development`
 * 368 字符、`github-push` 407 字符都被判红）。也就是说这个 60 是设计稿里拍的数，
 * 从未用数据标定过；一旦当门会拦掉人工撰写的全部技能（100% 误杀）。
 * 若将来要收紧描述，先重新标定阈值，别直接把它从 warn 改成 blocker。
 */
export const DESCRIPTION_MAX = 60;

/** 营销词：Hermes HARDLINE 要求描述写「能做什么」，不写「多厉害」 */
export const MARKETING_RE =
  /(powerful|comprehensive|seamless|advanced|robust|effortless|state-of-the-art|best-in-class|强大|全面|领先|极致|一站式|无缝|高效便捷)/i;

/**
 * 工具链名：`a-b-c-d` 形态且**至少 3 段**（质量门方案 §3 原判据 `^([a-z_]+-){3,}`）。
 *
 * 实测判别力（2026-09-18，skills_root 11 个技能全量）：
 *   自动生成 5 个 → 5/5 命中：`glob-glob-glob-glob`、`pwsh-pwsh-pwsh-pwsh`、
 *     `pwsh-glob-webfetch-webfetch`、`askuserquestion-todowrite-edit-read`、
 *     `agintsearch-pwsh-askuserquestion-pwsh`；
 *   手工撰写 6 个 → 0/6 命中：`plugin-preflight`、`editing-cordis-compositions`
 *     （2 段）、`cordis-plugin-development`（2 段）、`memory-discipline`、
 *     `causal-reasoning`、`github-push`。
 * 即该正则**恰好**把「工具序列拼接」与「类级领域名」分开，不是拍脑袋的阈值。
 */
export const TOOL_CHAIN_NAME_RE = /^([a-z_]+-){3,}/;

/** 宿主技能名的合法形态（取证来源见文件头；本模块自判一份，避免 import 宿主内部包） */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** description 收尾标点（中英文句号/感叹/问号） */
const TERMINATOR_RE = /[。．.!！?？]$/;

/**
 * description 是否只是「工具链复述」。
 *
 * 判据（2026-09-18 用真实数据校准，第一版正则误判已修）：
 *   ① 先剥掉尾部参数括号 `（参数：command/description/…）`——那是机械拼接的固定尾巴；
 *   ② 剩余部分按箭头/标点切词；
 *   ③ **每个词都是纯 ASCII 标识符**（工具名）才判为复述。
 *
 * 第一版写成「出现 ≥2 个箭头就算复述」，会把 `glob-glob-glob-glob` 的描述
 *   `跨多目录广撒网扫文件 → 抽样读全文 → pwsh 快速验证（适用于…）`
 * 也判红——但那句是**有信息量的自然语言**（只是用了箭头做连接）。
 * 改成第 ③ 条后：自动生成的 5 条全命中（描述就是工具序列），
 * 人工撰写的 6 条 0 命中，实测无误杀。
 */
export function isToolChainDescription(description) {
  const d = String(description ?? '').trim();
  if (!d) return false;
  const main = d.replace(/[（(]\s*参数\s*[：:][^）)]*[）)]/g, ' ').trim();
  const words = main.split(/[→\-–>，,、;；:：/|·()（）[\]{}\s]+/).filter(Boolean);
  if (words.length < 2) return false;
  return words.every((w) => /^[a-z0-9_.]+$/i.test(w));
}

/**
 * 判据登记表：code → 一句话标准。
 * 测试会断言「产出过的 code 都在表里」，防「加了判据没写标准」的漂移；
 * 也是本模块对外唯一的标准清单（单一事实源）。
 */
export const AUTHORING_RULES = Object.freeze([
  ['skill-name-missing', 'blocker', '技能必须有名字（frontmatter.name）'],
  ['skill-name-not-ascii', 'blocker', '技能名必须是 ASCII kebab-case（宿主只收这个形态，否则技能被静默忽略）'],
  ['skill-name-tool-chain', 'blocker', '技能名不能是工具序列拼接（`a-b-c-d`）——名字要能看出"这是干什么的一类事"'],
  ['description-missing', 'blocker', '技能必须有 description（宿主靠它决定要不要加载本技能）'],
  ['description-tool-chain', 'warn', 'description 不能只是工具链复述——要写"什么场景该用它"'],
  ['description-too-long', 'warn', `description 不超过 ${DESCRIPTION_MAX} 字符（它是被检索的短摘要，不是正文）`],
  ['description-marketing', 'warn', 'description 不含营销词（写能力，不写"多厉害"）'],
  ['description-no-terminator', 'warn', 'description 以句末标点收尾（半截句子进检索会误导）'],
]);

const RULE_SEVERITY = Object.fromEntries(AUTHORING_RULES.map(([code, sev]) => [code, sev]));

function finding(code, message, location) {
  return {
    family: AUTHORING_FAMILY,
    severity: RULE_SEVERITY[code] ?? 'warn',
    code,
    message,
    location,
  };
}

/** 字符数按 code point 计（避免 emoji/代理对被算成 2） */
export function charCount(value) {
  return [...String(value ?? '')].length;
}

/** 名字是否为工具序列拼接 */
export function isToolChainName(name) {
  return TOOL_CHAIN_NAME_RE.test(String(name ?? ''));
}

/** 技能名是否符合宿主 `SKILL_NAME`（ASCII kebab） */
export function isHostSkillName(name) {
  return SKILL_NAME_RE.test(String(name ?? ''));
}

/**
 * 名字判据。
 * @param {string} name frontmatter.name
 * @returns {Array<{family,severity,code,message,location}>}
 */
export function checkName(name) {
  const n = String(name ?? '').trim();
  if (!n) {
    return [finding('skill-name-missing', '技能名为空——frontmatter 必须给出 name', 'frontmatter.name')];
  }
  const findings = [];
  if (!isHostSkillName(n)) {
    findings.push(finding('skill-name-not-ascii',
      `技能名 "${n}" 不是宿主接受的形态（只收 /^[a-z0-9]+(?:-[a-z0-9]+)*$/ 即 ASCII kebab-case）。`
      + '不合法时 dsh-skill-filesystem 会**静默忽略整个技能文件**（只打一行 warn）——'
      + '文件在磁盘上、技能却永不出现，是最难排查的一类失效', 'frontmatter.name'));
  }
  if (isToolChainName(n)) {
    findings.push(finding('skill-name-tool-chain',
      `技能名 "${n}" 是工具序列拼接（≥3 段 kebab）。它只说明"用了哪些工具"，`
      + '不说明"这是干什么的一类事"——同工具组合的另一个任务会撞同一个名字，'
      + '且模型只能靠名字判断该不该加载本技能。'
      + '根因通常是描述不可 slug 化（如纯中文描述被 ASCII 过滤剥空）后回落成工具序列'
      + '（`proposer.skillName()`），修法是换命名来源，不是改名', 'frontmatter.name'));
  }
  return findings;
}

/**
 * description 判据。
 * @param {string} description frontmatter.description
 */
export function checkDescription(description) {
  const d = String(description ?? '').trim();
  if (!d) {
    return [finding('description-missing',
      'description 为空——宿主用 description 决定"这条技能该不该被加载"，空描述等于技能不可被选中',
      'frontmatter.description')];
  }
  const findings = [];
  if (isToolChainDescription(d)) {
    findings.push(finding('description-tool-chain',
      `description 是工具链复述（"${d.slice(0, 40)}…"）——它只说"按顺序调了哪些工具"，`
      + '没说"什么场景该用它"。模型靠 description 决定要不要加载，'
      + '工具名在工具目录里已经有了，写在描述里等于零信息量', 'frontmatter.description'));
  }
  if (charCount(d) > DESCRIPTION_MAX) {
    findings.push(finding('description-too-long',
      `description 长 ${charCount(d)} 字符（> ${DESCRIPTION_MAX}）——描述是被检索的短摘要，`
      + '不是正文。过长会让它在技能列表里失去区分度（且部分宿主会对摘要做截断）',
      'frontmatter.description'));
  }
  const marketing = d.match(MARKETING_RE);
  if (marketing) {
    findings.push(finding('description-marketing',
      `description 含营销词 "${marketing[0]}"——描述写"能做什么"，不写"多厉害"。`
      + '营销词对"该不该加载这条技能"这个判断没有任何贡献', 'frontmatter.description'));
  }
  if (!TERMINATOR_RE.test(d)) {
    findings.push(finding('description-no-terminator',
      `description 未以句末标点收尾（当前结尾："${d.slice(-12)}"）——半截句子被当作技能摘要展示会误导`,
      'frontmatter.description'));
  }
  return findings;
}

/**
 * 创作标准总入口（与 `checkSkillSemantics` 同签名形态：吃 draft，吐 findings）。
 *
 * ⚠️ 本函数只判**名字与描述**。正文判据的所有者是 semantics（A3）——
 * 需要「正文含具体值」时请调 `templates.CONCRETE_RE` / `semantics.checkSkillSemantics`，
 * 不要在别处再实现一份（Hermes：同一教训只有一条）。
 *
 * @param {object} args
 * @param {object} args.draft 技能草稿（name / description / frontmatter）
 * @returns {Array<{family,severity,code,message,location}>}
 */
export function checkSkillAuthoring({ draft } = {}) {
  const name = draft?.name ?? draft?.frontmatter?.name ?? '';
  const description = draft?.description ?? draft?.frontmatter?.description ?? '';
  return [...checkName(name), ...checkDescription(description)];
}

/** 只取 blocker（与 semantics.blockersOf 同语义；本模块自带一份以免反向依赖） */
export function authoringBlockersOf(findings) {
  return (findings ?? []).filter((f) => f?.severity === 'blocker');
}
