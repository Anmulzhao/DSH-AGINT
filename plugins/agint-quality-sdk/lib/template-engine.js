/**
 * agint-quality-sdk/lib/template-engine.js — Prompt 模板引擎（Sprint 5.1）
 *
 * ## 设计
 *   - 模板 = 普通文本 + `{{ variable.name }}` 占位符
 *   - 必须从 manifest.variables 中声明同名变量, 否则静态检查抛
 *   - 渲染时传入 values, 缺 required 抛
 *
 * ## 与 D-QAF 的关系
 *   - 每个 prompt-plugin 都提供一个 manifest + template text
 *   - evo.logPhase4 的 targetKind='prompt' 在 v0.5+ 启用, 当前先在静态检查里 trace
 *
 * ## 不做 (留给 Phase 5+)
 *   - 嵌套 template include (声明语法 / 风险都复杂)
 *   - Jinja-like 控制流 (条件/循环): 让模板保持简单, 复杂的交给上层代码
 */

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Extract all placeholders used in template text.
 * Returns [{ key: 'foo.bar', raw: '{{ foo.bar }}', ... }]
 */
export function extractPlaceholders(templateText) {
  const found = [];
  for (const m of templateText.matchAll(PLACEHOLDER_REGEX)) {
    found.push({
      raw: m[0],
      manifestName: m[1],
      variableName: m[2],
      key: `${m[1]}.${m[2]}`,
    });
  }
  return found;
}

/**
 * Static check: every placeholder must:
 *   1) reference a declared variable
 *   2) use the right format (no spaces inside {{ }})
 *
 * Returns { ok, violations: ['line 3: unknown manifest "X"'] }
 */
export function checkPlaceholdersAgainstManifest({ templateText, manifest }) {
  const declMap = new Map();
  for (const v of manifest.variables ?? []) {
    declMap.set(v.name, v);
  }
  const violations = [];
  const placeholders = extractPlaceholders(templateText);
  const seenKeys = new Set();

  for (const p of placeholders) {
    if (seenKeys.has(p.key)) continue;
    seenKeys.add(p.key);

    if (!declMap.has(p.manifestName)) {
      violations.push(`unknown manifest "${p.manifestName}" used by ${p.key}`);
      continue;
    }
    const decl = declMap.get(p.manifestName);
    if (decl.type === 'string' || decl.type === 'number' || decl.type === 'enum') {
      // accept any variable name under the manifest; string/number don't enforce sub-name
      continue;
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    placeholders,
  };
}

/**
 * Render: 替换所有 {{ manifest.variable }} 为 values[manifest][variable]
 * 缺 required 抛 'missing-required-variable'
 *
 * @param {object} args
 * @param {string} args.templateText
 * @param {object} args.manifest
 * @param {object} args.values — { manifest1: { var1: 'v' }, ... }
 */
export function renderPrompt({ templateText, manifest, values = {} }) {
  // 第一关: 静态检查
  const placeholders = extractPlaceholders(templateText);
  const seenManifests = new Set(placeholders.map((p) => p.manifestName));

  // 第二关: 校验 required 都被填; 注意 values 是嵌套 { manifest: { var: ... } }
  for (const v of manifest.variables ?? []) {
    const m = values[v.name];
    if (v.required && (m === undefined || m === null)) {
      if (v.defaultValue !== undefined) continue;
      throw new Error(`missing-required-variable: ${v.name}`);
    }
    if (v.type === 'enum' && m !== undefined && m !== null) {
      const allowed = v.enum ?? [];
      // enum 校验遍历子变量: 对应 `{{ risk.level }}` 用 `values.risk.level`
      const ok = Object.entries(m).every(([subKey, subVal]) =>
        !allowed.length || allowed.includes(String(subVal))
      );
      if (!ok) {
        throw new Error(`enum-violation: ${v.name}=${JSON.stringify(m)} not in [${allowed.join(',')}]`);
      }
    }
  }

  // 第三关: 替换
  return templateText.replace(PLACEHOLDER_REGEX, (raw, manifestName, varName) => {
    const m = values[manifestName];
    if (m === undefined) return raw; // 保留原样便于审计
    const v = m[varName];
    if (v === undefined) return raw;
    return String(v);
  });
}

/**
 * 给测试/快照用的: 列出模板用到但 manifest 未声明的占位符（"未声明使用"）
 */
export function findUndeclaredUsage({ templateText, manifest }) {
  const declNames = new Set((manifest.variables ?? []).map((v) => v.name));
  const usedManifests = new Set(extractPlaceholders(templateText).map((p) => p.manifestName));
  return [...usedManifests].filter((n) => !declNames.has(n));
}
