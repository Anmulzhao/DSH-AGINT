/**
 * agint-quality-sdk/lib/static-check.js — Prompt 静态检查（Sprint 5.1）
 *
 * ## 三类风险
 *   1. 注入风险（injection）：模板里出现未转义的用户输入管道, 例如 "You must say {{ ... | passthrough }}"
 *      简化版: 检测疑似管道符 / 反引号 / <|...|> 控制 token / 任意 'system:' 前缀（system role hijack）
 *   2. 占位符滥用（placeholder-abuse）：
 *      - 使用未声明的占位符（未声明则视为硬编码字符串, 易拼错）
 *      - 占位符拼写错误（用 edit-distance 检测）
 *   3. 模板 / manifest 不一致：
 *      - manifest.regressionTests 数量 < 5（老板拍板 5 条）
 *      - regressionTests.expectedOutputNotContains 数组为空 (无注入兜底)
 *      - manifest.name 不匹配 generated name
 *
 * 输出: { ok, violations: [{ code, severity, message, line?}], warnings, summary }
 *
 * Sprint 5.1 范围: 静态检查三种; 严重程度 advisory/warn/blocker.
 */

import { extractPlaceholders, findUndeclaredUsage } from './template-engine.js';
import { validateManifest } from './schema.js';

/** 注入风险 regex: 任意 prompt injection 模式的非穷尽列表 */
const INJECTION_PATTERNS = [
  // system role hijack
  { pattern: /\bsystem\s*:\s*/i, code: 'INJECTION_SYSTEM_ROLE', severity: 'blocker' },
  // assistant role hijack
  { pattern: /\bassistant\s*:\s*/i, code: 'INJECTION_ASSISTANT_ROLE', severity: 'blocker' },
  // 闭合标签注入
  { pattern: /<\/?system>|<\/?assistant>|<\/?user>/i, code: 'INJECTION_XML_ROLE', severity: 'blocker' },
  // 控制 token (Anthropic / OpenAI 风格)
  { pattern: /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/i, code: 'INJECTION_CONTROL_TOKEN', severity: 'blocker' },
  // passthrough-like piping
  { pattern: /\bpip\s+passthrough\b|\{\{[^}]*\|\s*passthrough[^}]*\}\}/i, code: 'INJECTION_PIPELINE', severity: 'blocker' },
  // 反引号注入（常见于 shell-escape exploits）
  { pattern: /`[^`]*\$\(/i, code: 'INJECTION_SHELL_ESCAPE', severity: 'warn' },
  // ignore previous instructions
  { pattern: /ignore\s+(previous|above)\s+instructions?/i, code: 'INJECTION_IGNORE_PREV', severity: 'blocker' },
  // 你现在是一个... (role override)
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, code: 'INJECTION_ROLE_OVERRIDE', severity: 'warn' },
];

/** 模板/manifest 不一致检查 */
function checkConsistency({ templateText, manifest }) {
  const violations = [];

  const m = validateManifest(manifest);
  if (!m.ok) {
    for (const v of m.violations) {
      violations.push({
        code: 'MANIFEST_INVALID',
        severity: 'blocker',
        message: v,
      });
    }
  }

  // regressionTests ≥ 5
  if (!manifest.regressionTests || manifest.regressionTests.length < 5) {
    violations.push({
      code: 'INSUFFICIENT_REGRESSION_TESTS',
      severity: 'blocker',
      message: `regressionTests count=${manifest.regressionTests?.length ?? 0} < 5 (老板拍板 Phase 4 标准)`,
    });
  }

  // 每个 test 必有 expectedOutputNotContains (注入兜底)
  if (Array.isArray(manifest.regressionTests)) {
    for (const t of manifest.regressionTests) {
      if (!t.expectedOutputNotContains || t.expectedOutputNotContains.length === 0) {
        violations.push({
          code: 'TEST_MISSING_INJECTION_GUARD',
          severity: 'warn',
          message: `regression test "${t.name}" 缺 expectedOutputNotContains`,
        });
      }
    }
  }

  // 占位符使用声明
  const undeclared = findUndeclaredUsage({ templateText, manifest });
  for (const u of undeclared) {
    violations.push({
      code: 'UNDECLARED_PLACEHOLDER_USAGE',
      severity: 'warn',
      message: `placeholder "{{ ${u}.* }}" 使用了 manifest.variables 中未声明的 manifest "${u}"`,
    });
  }

  return violations;
}

/** 占位符拼写检测 (Levenshtein distance 1) */
function checkPlaceholderSpelling({ templateText, manifest }) {
  const violations = [];
  const declared = new Set((manifest.variables ?? []).map((v) => v.name));
  const placeholders = extractPlaceholders(templateText);
  const seenKeys = new Set();

  for (const p of placeholders) {
    if (seenKeys.has(p.manifestName)) continue;
    seenKeys.add(p.manifestName);
    if (declared.has(p.manifestName)) continue;
    // 找最近匹配
    let best = null;
    for (const d of declared) {
      const dist = levenshtein(d, p.manifestName);
      if (dist === 1 && (best === null || dist < levenshtein(best, p.manifestName))) {
        best = d;
      }
    }
    if (best) {
      violations.push({
        code: 'PLACEHOLDER_LIKELY_TYPO',
        severity: 'warn',
        message: `"${p.manifestName}" 看起来像 "${best}" 的拼写 (edit-distance=1)`,
      });
    }
  }
  return violations;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

/** 注入模式扫描 */
function checkInjectionPatterns({ templateText }) {
  const violations = [];
  const lines = templateText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const inj of INJECTION_PATTERNS) {
      if (inj.pattern.test(line)) {
        violations.push({
          code: inj.code,
          severity: inj.severity,
          message: `line ${i + 1}: ${inj.pattern.source}`,
          line: i + 1,
        });
      }
    }
  }
  return violations;
}

/**
 * 主入口: full static check
 *
 * @param {object} args
 * @param {string} args.templateText
 * @param {object} args.manifest
 * @returns {{ ok: boolean, violations: Violation[], warnings: number, blockers: number }}
 */
export function staticCheckPrompt({ templateText, manifest }) {
  const consistency = checkConsistency({ templateText, manifest });
  const typos = checkPlaceholderSpelling({ templateText, manifest });
  const injections = checkInjectionPatterns({ templateText });

  const violations = [...consistency, ...typos, ...injections];
  const blockers = violations.filter((v) => v.severity === 'blocker').length;
  const warnings = violations.filter((v) => v.severity === 'warn').length;
  return {
    ok: blockers === 0,
    violations,
    blockers,
    warnings,
  };
}

/**
 * Convenience: 渲染 + 跑 regression tests 全过
 */
export function runRegressionTests({ templateText, manifest, render } = {}) {
  if (!render) throw new Error('runRegressionTests: render function required (use renderPrompt from template-engine)');
  const results = [];
  for (const t of manifest.regressionTests ?? []) {
    let rendered;
    let passed = false;
    let error = null;
    try {
      rendered = render({ templateText, manifest, values: t.inputs });
    } catch (err) {
      error = err.message;
      results.push({ name: t.name, status: 'error', error });
      continue;
    }
    const containsOk = t.expectedOutputContains.length === 0
      || t.expectedOutputContains.some((s) => rendered.includes(s));
    const notContainsOk = t.expectedOutputNotContains.every((s) => !rendered.includes(s));
    passed = containsOk && notContainsOk;
    results.push({
      name: t.name,
      status: passed ? 'pass' : 'fail',
      detail: passed ? null : `containsOk=${containsOk} notContainsOk=${notContainsOk}`,
    });
  }
  return results;
}
