/**
 * lib/checkers/skill-format.js — Sprint 15 T2 技能向 checker 1/4
 *
 * SKILL.md 格式准入（设计稿 §5.3，blocker）：
 *   - 文件必须存在（staging 物化产物）
 *   - frontmatter 必填：name / description / triggers / tools
 *   - name 命名规范：小写字母开头，小写字母/数字/连字符，3-50 字符
 *   - body 非空
 *
 * 解析器按 SKILL.md 约定（--- frontmatter --- body）做最小 YAML 子集解析：
 *   key: value            → 标量
 *   key:                  → 列表（下一行起 "- item"）
 * 不做完整 YAML（不引外部依赖）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SKILL_FORMAT_NAME_RE = /^[a-z][a-z0-9-]{2,49}$/;

function parseFrontmatter(text) {
  // 首行必须是 ---，第二个 --- 之前是 frontmatter
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  const block = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^[\r\n]+/, '');
  const fields = {};
  let currentKey = null;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^(\s*)-[ \t]+(.+)$/);
    if (listMatch) {
      if (currentKey) {
        fields[currentKey].push(listMatch[2].replace(/^['"]|['"]$/g, ''));
      }
      continue;
    }
    const kv = line.match(/^([a-zA-Z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1];
    const val = kv[2].trim().replace(/^['"]|['"]$/g, '');
    if (val === '') {
      fields[currentKey] = [];
    } else {
      fields[currentKey] = val;
    }
  }
  return { fields, body };
}

export async function checkSkillFormat({ pluginDir, profile }) {
  const findings = [];
  const skillPath = resolve(pluginDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    findings.push({
      family: 'skill-format',
      severity: 'blocker',
      message: 'SKILL.md not found（staging 物化缺失）',
      location: skillPath,
    });
    return findings;
  }
  let text;
  try {
    text = readFileSync(skillPath, 'utf8');
  } catch (e) {
    findings.push({ family: 'skill-format', severity: 'blocker', message: `SKILL.md read error: ${e.message}`, location: skillPath });
    return findings;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    findings.push({ family: 'skill-format', severity: 'blocker', message: 'SKILL.md 缺 frontmatter 块（须以 --- 开头且有闭合 ---）', location: skillPath });
    return findings;
  }
  const { fields, body } = parsed;

  for (const required of ['name', 'description', 'triggers', 'tools']) {
    const v = fields[required];
    const ok = Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
    if (!ok) {
      findings.push({ family: 'skill-format', severity: 'blocker', message: `frontmatter 缺必填字段: ${required}`, location: skillPath });
    }
  }

  if (typeof fields.name === 'string' && fields.name && !SKILL_FORMAT_NAME_RE.test(fields.name.trim())) {
    findings.push({
      family: 'skill-format',
      severity: 'blocker',
      message: `skill name 不合规范（须小写字母开头 / 小写字母数字连字符 / 3-50 字符）: "${fields.name}"`,
      location: skillPath,
    });
  }

  if (!body || !body.trim()) {
    findings.push({ family: 'skill-format', severity: 'blocker', message: 'SKILL.md body 为空', location: skillPath });
  }

  return findings;
}
