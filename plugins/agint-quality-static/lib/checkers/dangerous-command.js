/**
 * lib/checkers/dangerous-command.js — Sprint 15 T2 技能向 checker 2/4
 *
 * 危险命令拦截（设计稿 §5.3，blocker）：
 *   扫描 SKILL.md body 与 scripts/ 下所有文本文件，命中
 *   profile.dangerousBlocklist（默认 terminal:rm -rf / terminal:dd）→ blocker。
 *
 * 默认块列表与 skill-autocreate ConfigSchema.dangerous_tools_blocklist 保持一致
 * （['terminal:rm -rf', 'terminal:dd']）；调用方可经 profileOverrides 覆盖。
 *
 * 匹配策略：把 "terminal:rm -rf" 拆成 shell 语义子串（rm -rf / rm -fr / rm --recursive
 * 等归一化到 rm -rf），对 body 做宽松匹配——宁可误报不可漏报（安全 > 效率）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** 默认块列表 → 展开的正则（Sprint 15 内置，与 skill-autocreate 配置同源） */
export const DEFAULT_DANGEROUS_PATTERNS = [
  { label: 'terminal:rm -rf', re: /\brm\s+-(?:r\s*f|rf|fr|f\s*r)\b|\brm\s+--recursive/ },
  { label: 'terminal:dd', re: /\bdd\s+if=|\bdd\s+of=/ },
  { label: 'terminal:mkfs', re: /\bmkfs(?:\.\w+)?\b/ },
  { label: 'terminal:shutdown', re: /\bshutdown\s+-[a-z]|\bpoweroff\b/ },
];

function buildPatterns(blocklist) {
  const out = [...DEFAULT_DANGEROUS_PATTERNS];
  if (Array.isArray(blocklist)) {
    for (const entry of blocklist) {
      if (typeof entry !== 'string' || !entry) continue;
      // 支持 "terminal:rm -rf" 与裸命令两种形态
      const cmd = entry.includes(':') ? entry.split(':').slice(1).join(':').trim() : entry.trim();
      if (!cmd) continue;
      const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out.push({ label: entry, re: new RegExp(`\\b${escaped.replace(/\\ /g, '\\s+')}`) });
    }
  }
  return out;
}

function textOf(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 收集目录下所有文本文件内容（SKILL.md + scripts/* 递归） */
function collectTexts(dir) {
  const out = [];
  const skillPath = resolve(dir, 'SKILL.md');
  if (existsSync(skillPath)) out.push({ file: skillPath, text: textOf(skillPath) });
  const scriptsDir = resolve(dir, 'scripts');
  if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = resolve(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push({ file: p, text: textOf(p) });
      }
    };
    walk(scriptsDir);
  }
  return out;
}

export async function checkDangerousCommand({ pluginDir, profile }) {
  const findings = [];
  const patterns = buildPatterns(profile.dangerousBlocklist);
  const sources = collectTexts(pluginDir);
  if (sources.length === 0) {
    findings.push({ family: 'dangerous-command', severity: 'blocker', message: '无可扫描内容（SKILL.md 缺失）', location: pluginDir });
    return findings;
  }
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { label, re } of patterns) {
        if (re.test(line)) {
          findings.push({
            family: 'dangerous-command',
            severity: 'blocker',
            message: `危险命令命中 [${label}] line ${i + 1}: ${line.trim().slice(0, 120)}`,
            location: file,
          });
        }
      }
    }
  }
  return findings;
}
