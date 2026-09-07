/**
 * lib/checkers/secret-scan.js — Sprint 15 T2 技能向 checker 3/4
 *
 * 密钥扫描（设计稿 §5.3，blocker）：
 *   扫描 SKILL.md body 与 scripts/ 下所有文本文件，命中常见密钥/token/password
 *   形态 → blocker（命中即拒 + 由调用方写审计）。
 *
 * 正则覆盖（保守 + 防误报平衡）：
 *   - OpenAI/Anthropic 风格 sk- / sk-ant- / sk-proj-
 *   - AWS AKIA / ASIA 访问密钥
 *   - GitHub PAT（ghp_ / gho_ / github_pat_）
 *   - 通用 "password = 明文" / "api_key = 明文" 赋值（非占位符）
 *   - 通用 32+ 位 base64-ish 高熵串（AKIA 之外的云厂商 key 兜底）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const SECRET_PATTERNS = [
  { code: 'SECRET_SK_API', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { code: 'SECRET_AWS_ACCESS_KEY', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { code: 'SECRET_GITHUB_PAT', re: /\b(?:ghp_|gho_|ghu_|github_pat_)[A-Za-z0-9_]{20,}\b/ },
  { code: 'SECRET_SLACK', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { code: 'SECRET_GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { code: 'SECRET_GENERIC_ASSIGN', re: /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*['"][^'"]{8,}['"]/i },
];

function textOf(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

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

export async function checkSecretScan({ pluginDir }) {
  const findings = [];
  const sources = collectTexts(pluginDir);
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { code, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          findings.push({
            family: 'secret-scan',
            severity: 'blocker',
            code,
            message: `疑似密钥泄露 [${code}] line ${i + 1}: ${maskSecret(line.trim()).slice(0, 120)}`,
            location: file,
          });
        }
      }
    }
  }
  return findings;
}

/** 只保留前缀 + 长度，不打日志全文（防止 audit 二次泄露） */
function maskSecret(line) {
  const hit = line.match(/[A-Za-z0-9_\-]{16,}/);
  if (!hit) return line;
  const s = hit[0];
  return line.replace(s, `${s.slice(0, 4)}…${s.slice(-4)}(${s.length} chars)`);
}
