/**
 * lib/checkers/prompt-hijack.js — Sprint 15 T2 技能向 checker 4/4
 *
 * 提示词劫持扫描（Q3 探查结论：agint-quality-sdk 的 staticCheck 需 PromptManifest
 * 形态、对 SKILL.md 不适用，但其注入模式扫描部分直接适用 → 内联实现为第四族）。
 *
 * 扫描 SKILL.md body（技能即提示词文档，被注入风险真实存在）：
 *   - system:/assistant: 角色劫持（blocker）
 *   - <|im_start|>/<|im_end|>/<|endoftext|> 控制 token（blocker）
 *   - "ignore previous/above instructions" 指令覆盖（blocker）
 *   - 反引号内 $(...) shell 逃逸（warn）
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const HIJACK_PATTERNS = [
  { code: 'HIJACK_SYSTEM_ROLE', severity: 'blocker', re: /\bsystem\s*:\s*/i },
  { code: 'HIJACK_ASSISTANT_ROLE', severity: 'blocker', re: /\bassistant\s*:\s*/i },
  { code: 'HIJACK_CONTROL_TOKEN', severity: 'blocker', re: /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/i },
  { code: 'HIJACK_IGNORE_PREV', severity: 'blocker', re: /ignore\s+(?:previous|above)\s+instructions?/i },
  { code: 'HIJACK_SHELL_ESCAPE', severity: 'warn', re: /`[^`]*\$\(/i },
];

export async function checkPromptHijack({ pluginDir }) {
  const findings = [];
  const skillPath = resolve(pluginDir, 'SKILL.md');
  if (!existsSync(skillPath)) return findings; // 缺文件由 skill-format 报
  let text;
  try { text = readFileSync(skillPath, 'utf8'); } catch { return findings; }
  // 只扫 body（frontmatter 之后的正文），frontmatter 里的 description 也参与
  const bodyStart = text.indexOf('\n---', 4);
  const body = bodyStart === -1 ? text : text.slice(bodyStart + 4);
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { code, severity, re } of HIJACK_PATTERNS) {
      if (re.test(line)) {
        findings.push({
          family: 'prompt-hijack',
          severity,
          code,
          message: `提示词劫持模式 [${code}] line ${i + 1}: ${line.trim().slice(0, 120)}`,
          location: skillPath,
        });
      }
    }
  }
  return findings;
}
