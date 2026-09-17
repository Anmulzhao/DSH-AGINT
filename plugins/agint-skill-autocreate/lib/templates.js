/**
 * agint-skill-autocreate: templates — 内置技能模板库（设计稿 §7）。
 *
 * 6 个模板：shell-automation / file-processing / api-calling /
 * report-generation / code-lint / git-workflow。
 * 提案生成时按工具序列选匹配模板；无匹配 → 不生成候选（宁缺毋滥）。
 *
 * ── 2026-09-09 修复：模板工具名与生产真实工具名错配 ──────────────────────
 * 模板 requiredTools 写的是设计稿里的抽象名（terminal / file_read /
 * file_write），而生产 tool-stats 记录的是宿主真实工具名
 * （pwsh / read / write / edit / glob / grep / ssh_exec …）。两者零交集，
 * 导致 `selectTemplate()` 在**全部真实模式上恒返回 null** —— 即 [5] 提案
 * 生成环节 100% 落空，链路即使过了 [4] 也产不出候选。
 *
 * 修法：加一层「工具名归一化」（TOOL_CANONICAL_MAP），匹配前先把真实工具名
 * 映射到模板语义名。渲染（renderBody）仍用原始工具名，保留信息。
 */

/** 真实工具名 → 模板语义工具名（未列出的原样返回） */
export const TOOL_CANONICAL_MAP = Object.freeze({
  // terminal 语义：执行 shell / 脚本 / 远程命令
  terminal: 'terminal', pwsh: 'terminal', bash: 'terminal', sh: 'terminal',
  ssh_exec: 'terminal', ssh_upload: 'terminal',
  // file_read 语义：读文件 / 找文件 / 搜内容
  file_read: 'file_read', read: 'file_read', glob: 'file_read', grep: 'file_read',
  read_image: 'file_read', ssh_list: 'file_read',
  // file_write 语义：写文件 / 改文件
  file_write: 'file_write', write: 'file_write', edit: 'file_write',
});

/** 工具名归一化（单工具） */
export function canonicalTool(tool) {
  return TOOL_CANONICAL_MAP[String(tool ?? '')] ?? String(tool ?? '');
}

/** 工具序列归一化（去重后的语义工具集） */
export function canonicalToolSet(toolSequence) {
  return new Set((toolSequence ?? []).map(canonicalTool).filter(Boolean));
}

export const TEMPLATES = Object.freeze([
  {
    templateId: 'shell-automation',
    description: '重复性 shell 命令/脚本执行',
    requiredTools: ['terminal'],
    optionalTools: [],
    parameterExtractionRules: [
      { from: 'terminal.command', to: 'command_pattern' },
    ],
  },
  {
    templateId: 'file-processing',
    description: '批量文件处理（格式转换/内容替换/重命名）',
    requiredTools: ['file_read', 'file_write'],
    optionalTools: ['terminal'],
    parameterExtractionRules: [
      { from: 'file_read.path', to: 'input_pattern' },
      { from: 'file_write.path', to: 'output_pattern' },
    ],
  },
  {
    templateId: 'api-calling',
    description: '重复性 API 调用（数据获取/提交/同步）',
    requiredTools: ['terminal', 'file_write'],
    optionalTools: ['file_read'],
    parameterExtractionRules: [
      { from: 'terminal.command', to: 'endpoint_pattern' },
      { from: 'file_write.path', to: 'output_path' },
    ],
  },
  {
    templateId: 'report-generation',
    description: '周期性报告生成（数据汇总+格式化+输出）',
    requiredTools: ['file_read', 'terminal', 'file_write'],
    optionalTools: [],
    parameterExtractionRules: [
      { from: 'file_read.path', to: 'data_source' },
      { from: 'file_write.path', to: 'report_path' },
    ],
  },
  {
    templateId: 'code-lint',
    description: '代码检查/格式化/静态分析',
    requiredTools: ['terminal', 'file_read'],
    optionalTools: ['file_write'],
    parameterExtractionRules: [
      { from: 'terminal.command', to: 'lint_command' },
      { from: 'file_read.path', to: 'target_pattern' },
    ],
  },
  {
    templateId: 'git-workflow',
    description: '重复性 git 操作（分支创建/提交/PR）',
    requiredTools: ['terminal'],
    optionalTools: ['file_read'],
    parameterExtractionRules: [
      { from: 'terminal.command', to: 'git_command_pattern' },
    ],
  },
]);

/**
 * 按工具序列选模板。
 * 评分：序列去重后覆盖 requiredTools 的比例（全集含 optionalTools）。
 * 返回 { template, score } 或 null（覆盖率 <1 的 required 不收——
 * 模板缺必需工具说明任务形态不符，Sprint 14 宁缺毋滥）。
 *
 * 匹配前先做工具名归一化（见文件头注释），否则真实工具名永远匹配不上。
 */
export function selectTemplate(toolSequence) {
  const tools = canonicalToolSet(toolSequence);
  if (!tools.size) return null;
  let best = null;
  for (const t of TEMPLATES) {
    const required = new Set(t.requiredTools);
    const covered = [...required].filter((x) => tools.has(x)).length;
    if (covered < required.size) continue; // 必需工具不全 → 不匹配
    const relevant = [...required, ...t.optionalTools];
    const noise = [...tools].filter((x) => !relevant.includes(x)).length;
    const score = +(covered / required.size) - noise * 0.1;
    if (!best || score > best.score) best = { template: t, score: +score.toFixed(2) };
  }
  return best;
}

/**
 * 用模式特征填充模板 → SKILL.md 草稿 body。
 * 设计稿 §7.2 bodyTemplate 结构：适用场景 / 前置条件 / 步骤 / 注意事项。
 * 步骤由工具序列推导（每个工具一步，同工具合并）。
 *
 * ── 2026-09-17 Phase 2 改造（质量门方案 §2 A2/A3）────────────────────────
 * ① 步骤行**不再追加**「确认输出符合预期后再进入下一步」。原文案是纯复述：
 *    它对每一步都成立、对任何任务都成立 → 零信息量，且正好命中 A3 判据
 *    `tool-recap-only`（「调用 <工具名>…确认输出符合预期」占比 > 50%）。
 *    改为直接给「调用 <工具>：<真实参数值>」——短、带具体值、可执行。
 * ② 新增 `opts.semanticMarkdown`（由 semantic-window.renderSemanticSections
 *    产出）：把会话文本窗口里**真实出现过**的 WHY / 坑 原样搬进正文。
 *    为空则不渲染该段——**绝不拿固定话术凑字数**。
 */
export function renderBody(pattern, template, opts = {}) {
  const seq = [...new Set(pattern.toolSequence)];
  const steps = seq.map((tool, i) => {
    const args = pattern.sampleArgs?.[tool] ?? {};
    const hint = firstMeaningfulValue(args);
    return hint
      ? `${i + 1}. 调用 ${tool}：${hint}`
      : `${i + 1}. 调用 ${tool}`;
  });
  const semantic = String(opts.semanticMarkdown ?? '').trim();
  const parts = [
    '## 适用场景',
    pattern.description,
    '',
    '## 前置条件',
    `- 工具可用：${seq.join('、')}`,
    '- 运行环境与历史任务实例一致（同工作目录/同权限）',
    '',
  ];
  if (semantic) parts.push(semantic, '');
  parts.push(
    '## 步骤',
    ...steps,
    '',
    '## 注意事项',
    '- 本技能由系统从重复任务模式自动生成（经 D-QAF 评估 + 灰度发布）。',
    '- 首次使用如结果异常，停止并反馈，不要盲目重试。',
    '- 涉及写操作时先确认目标路径，避免覆盖非预期文件。',
  );
  return parts.join('\n');
}

// ── A2/A3 共用判据：正文里是否存在「具体值」 ───────────────────────────────
//
// 判据外部化：字符串可判定、纯函数可单测，不让生成者自评。
//
// ⚠️ 2026-09-17 实测修正：质量门方案 §2 原版正则含 `--?[a-z][\w-]{2,}`，
// 本意匹配 CLI 选项（`--force` / `-v`），但它同样匹配**任意 kebab-case
// 标识符**——实测 104 个真实 pattern 里有 8 个被它误判放行，例如
//   `{"skill":{"name":"plugin-preflight"}}`  （技能名，不是具体值）
//   `{"id":"skill-autocreate-aggregate"}`   （id 值，不是具体值）
// 收紧为「CLI 选项必须处于行首/空白/引号/括号之后」后误判归零。
export const CONCRETE_RE = /(?:\b[A-Za-z]:\\[^\s"']+|\/(?:[\w.-]+\/){2,}|\b[\w.-]+\.(?:md|json|js|mjs|ts|py|yml|yaml|sh|ps1|toml)\b|https?:\/\/[^\s"']+|(?:^|[\s"'(=])--?[a-z][\w-]{1,}(?=[\s"'`,)]|$)|\bexit code\s+\d+|\b(?:ENOENT|EACCES|EPERM|EADDRINUSE|ECONNREFUSED)\b|`[^`]{4,}`)/m;

/**
 * 模式里是否存在至少一个「具体值」（真实命令/路径/端点/错误串）。
 *
 * @param {object} pattern   task_pattern 业务字段
 * @param {string} [extraBlob] 附加证据文本（Phase 2：本地语义窗口里抽到的
 *   具体值）。不传时只看 `sampleArgs` —— 与质量门方案 §2 A2 原判据一致。
 */
export function hasConcreteValue(pattern, extraBlob = '') {
  const blob = `${JSON.stringify(pattern?.sampleArgs ?? {})} ${extraBlob ?? ''}`;
  return CONCRETE_RE.test(blob);
}

function firstMeaningfulValue(args) {
  for (const v of Object.values(args ?? {})) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return null;
}

/** frontmatter triggers：从参数 key / 工具名提取 2-3 个触发短语 */
export function extractTriggers(pattern) {
  const triggers = new Set();
  const desc = pattern.description ?? '';
  if (desc) triggers.add(desc.split('（')[0].slice(0, 30));
  for (const [tool, args] of Object.entries(pattern.sampleArgs ?? {})) {
    for (const k of Object.keys(args ?? {})) {
      if (triggers.size < 3) triggers.add(`${tool} ${k}`);
    }
  }
  return [...triggers].slice(0, 3);
}
