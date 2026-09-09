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
 */
export function renderBody(pattern, template) {
  const seq = [...new Set(pattern.toolSequence)];
  const steps = seq.map((tool, i) => {
    const args = pattern.sampleArgs?.[tool] ?? {};
    const hint = firstMeaningfulValue(args);
    return `${i + 1}. 调用 ${tool}${hint ? `（参数参考：${hint}）` : ''}，确认输出符合预期后再进入下一步。`;
  });
  return [
    '## 适用场景',
    pattern.description,
    '',
    '## 前置条件',
    `- 工具可用：${seq.join('、')}`,
    '- 运行环境与历史任务实例一致（同工作目录/同权限）',
    '',
    '## 步骤',
    ...steps,
    '',
    '## 注意事项',
    '- 本技能由系统从重复任务模式自动生成（经 D-QAF 评估 + 灰度发布）。',
    '- 首次使用如结果异常，停止并反馈，不要盲目重试。',
    '- 涉及写操作时先确认目标路径，避免覆盖非预期文件。',
  ].join('\n');
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
