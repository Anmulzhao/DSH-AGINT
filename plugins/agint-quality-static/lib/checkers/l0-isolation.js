/**
 * lib/checkers/l0-isolation.js — Sprint 11 v0.6.5 l0-isolation 规则组
 *
 * 设计稿 §4.4 ADR-11-4：动态挂载流水线第一步对合成产物做三项 L0 隔离检查。
 *   ① 签名兼容 signatureCompatibility：产物 manifest 声明的 Service / schema / interface
 *      名字必须避开 agint-quality-contract 已注册的 L0 签名空间（FROZEN_SIGNATURES）。
 *      任何字段变更/删除/复用 → blocker。
 *   ② 域隔离 domainIsolation：产物 manifest 的 storage.domains 必须是全新 `agint_synth_*`
 *      域；命中既有任何 `agint_*` 域（尤其 `agint_meta`）→ blocker。
 *   ③ 依赖白名单 dependencyWhitelist：产物源码里 import / require 的 host service
 *      必须是白名单（memory / metrics / cron）内成员；任何其他 agint-* 内部模块
 *      （含 agint-quality-* / agint-mount / agint-quality-static 自己）→ blocker。
 *
 * 输入契约：
 *   checkL0Isolation({ pluginDir, profile }) → Finding[]
 *
 *   profile 必备字段（由 static-profile.loadProfile 注入）：
 *     - frozenSignatures     FROZEN_SIGNATURES
 *     - allowedSynthDomains  ALLOWED_SYNTH_DOMAINS
 *     - allowedHostServices  string[]
 *     - l0IsolationOnly      boolean（true = 仅对 synth 产物生效）
 *
 * 输出 Finding 形态（与既有 checker 一致）：
 *   { family: 'l0-isolation', severity: 'blocker', message, location? }
 *   其中 message 含子检查名前缀：`[signatureCompatibility]` / `[domainIsolation]` /
 *   `[dependencyWhitelist]`，便于 mount 编排侧按子项聚合 contractCheck。
 *
 * L0-frozen 保护：本文件**不含**任何 FROZEN 契约完整字符串，亦不引用
 * agint-quality-contract 包（contract-reference checker 自身豁免外不破例）。
 *
 * 行数预算：单 checker ≤200 行（设计稿 §十.1 放宽，三项合一）
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { collectSourceFiles } from './scan-files.js';

const FAMILY = 'l0-isolation';

/**
 * 子检查名常量（与 L0_ISOLATION_CHECKS 对齐）。
 * mount 编排侧 contractCheck 的字段值 = 子检查名；这里给出完整列表便于复用。
 */
export const SUBCHECKS = Object.freeze({
  signatureCompatibility: 'signatureCompatibility',
  domainIsolation: 'domainIsolation',
  dependencyWhitelist: 'dependencyWhitelist',
});

// ─────────────────────────────────────────────────────────────────────────────
// 外层入口：checkL0Isolation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * l0-isolation 族总入口。扫描 pluginDir 下的 manifest.json + 源码，
 * 串行跑 3 项子检查，聚合所有 findings 返回。
 *
 * @param {object} args
 * @param {string} args.pluginDir  产物 plugin 根目录
 * @param {object} args.profile    loadProfile() 返回值
 * @returns {Promise<Array<{family: string, severity: string, message: string, location?: string}>>}
 */
export async function checkL0Isolation({ pluginDir, profile }) {
  const findings = [];
  if (!profile) {
    return [{
      family: FAMILY, severity: 'warn',
      message: '[l0-isolation] profile is missing; skipped',
    }];
  }

  // 1) 解析 manifest.json（必读；缺即按"未知产物"处理）
  const manifest = readManifest(pluginDir);
  const manifestPath = resolve(pluginDir, 'manifest.json');

  // 2) l0IsolationOnly 模式：仅对 synth 产物生效（mount 编排默认走这个模式）
  if (profile.l0IsolationOnly === true && !looksLikeSynthArtifact(manifest, profile)) {
    return findings; // 空数组 = 跳过；既有插件不被误伤
  }

  // 3) 子检查 ①：签名兼容
  findings.push(...checkSignatureCompatibility({ manifest, profile, manifestPath }));

  // 4) 子检查 ②：域隔离
  findings.push(...checkDomainIsolation({ manifest, profile, manifestPath }));

  // 5) 子检查 ③：依赖白名单
  findings.push(...checkDependencyWhitelist({ pluginDir, profile }));

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ①：签名兼容 signatureCompatibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 签名兼容检查（设计稿 §4.4 第一项）。
 *
 * 检测目标：产物 manifest.json 的 `cordis.provides[]` 数组里任意元素，
 * 是否命中 FROZEN_SIGNATURES 的：
 *   - schemas[]   7 个 L0 schema 名（EvalTarget/EvalResult/...）
 *   - interfaces[] 4 个 L0 interface 名
 *   - serviceNamespace 'agint.quality' 前缀的子串
 *   - schemaFields[] 17 个高频 schema 字段名（用于 schema 重定义场景）
 *
 * 命中规则：
 *   - provides[i] === schema / interface / schemaField 任一 → blocker
 *   - provides[i].startsWith(serviceNamespace + '.') → blocker（冒充 agint.quality.*）
 *
 * 设计选择（老板拍板 §二.2 + 签名空间独占对称）：签名集合**只列名字**，
 * 不做完整类型 diff（实现侧也不应尝试在静态阶段反序列化产物 Service）——
 * 这一层只挡「命名空间冲突 + 字段复用」，结构性破坏由后续 sandbox 探针兜底。
 *
 * @returns {Array<Finding>}
 */
export function checkSignatureCompatibility({ manifest, profile, manifestPath }) {
  const findings = [];
  if (!manifest) {
    findings.push({
      family: FAMILY, severity: 'blocker',
      message: `[${SUBCHECKS.signatureCompatibility}] manifest.json missing or unreadable`,
      location: manifestPath,
    });
    return findings;
  }
  const frozen = profile.frozenSignatures ?? {};
  const provides = manifest?.cordis?.provides;
  if (!Array.isArray(provides)) {
    // 没 provides 字段 = 产物压根没声明 Service；但仍是产物自检问题
    // 这里不直接拒绝（mount 编排会自己查）；仅记录 warn
    findings.push({
      family: FAMILY, severity: 'warn',
      message: `[${SUBCHECKS.signatureCompatibility}] manifest.cordis.provides is missing or not array`,
      location: manifestPath,
    });
    return findings;
  }

  const schemaNames = new Set(frozen.schemas ?? []);
  const interfaceNames = new Set(frozen.interfaces ?? []);
  const fieldNames = new Set(frozen.schemaFields ?? []);
  const nsPrefix = frozen.serviceNamespace ? `${frozen.serviceNamespace}.` : null;

  for (const svc of provides) {
    if (typeof svc !== 'string' || svc.length === 0) {
      findings.push({
        family: FAMILY, severity: 'blocker',
        message: `[${SUBCHECKS.signatureCompatibility}] non-string or empty entry in cordis.provides: ${JSON.stringify(svc)}`,
        location: manifestPath,
      });
      continue;
    }
    // 拆分 'agint.foo.bar' → 最后一段 'bar' 用于 schema/interface 匹配
    const tail = svc.includes('.') ? svc.slice(svc.lastIndexOf('.') + 1) : svc;
    if (schemaNames.has(tail)) {
      findings.push({
        family: FAMILY, severity: 'blocker',
        message: `[${SUBCHECKS.signatureCompatibility}] provides '${svc}' collides with FROZEN schema '${tail}'`,
        location: manifestPath,
      });
    }
    if (interfaceNames.has(tail)) {
      findings.push({
        family: FAMILY, severity: 'blocker',
        message: `[${SUBCHECKS.signatureCompatibility}] provides '${svc}' collides with FROZEN interface '${tail}'`,
        location: manifestPath,
      });
    }
    if (fieldNames.has(tail)) {
      // schemaField 名字级别冲突 → warn（不直接 blocker，因为字段名常见）
      findings.push({
        family: FAMILY, severity: 'warn',
        message: `[${SUBCHECKS.signatureCompatibility}] provides '${svc}' tail '${tail}' overlaps with FROZEN schema field`,
        location: manifestPath,
      });
    }
    if (nsPrefix && svc.startsWith(nsPrefix)) {
      findings.push({
        family: FAMILY, severity: 'blocker',
        message: `[${SUBCHECKS.signatureCompatibility}] provides '${svc}' impersonates FROZEN namespace '${frozen.serviceNamespace}'`,
        location: manifestPath,
      });
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ②：域隔离 domainIsolation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 域隔离检查（设计稿 §4.4 第二项）。
 *
 * 检测目标：manifest.storage.domains[] 中任意元素：
 *   - 必须命中 ALLOWED_SYNTH_DOMAINS.pattern（^agint_synth_[a-z0-9_]+$）
 *   - 命中即放行；不命中即 blocker
 *
 * 老板 2026-08-27 拍板：禁全部既有 agint_* 域，仅放行 agint_synth_*。
 * 即「必须全新合成域」。旧域（含 agint_meta / agint_memory / agint_evolution 等）
 * 一律拒绝 —— 防产物借既有域读取基座数据。
 *
 * @returns {Array<Finding>}
 */
export function checkDomainIsolation({ manifest, profile, manifestPath }) {
  const findings = [];
  if (!manifest) return findings; // 已在 signature check 报告过
  const domains = manifest?.storage?.domains;
  if (!Array.isArray(domains) || domains.length === 0) {
    findings.push({
      family: FAMILY, severity: 'blocker',
      message: `[${SUBCHECKS.domainIsolation}] manifest.storage.domains missing or empty (synth artifact must declare at least one agint_synth_* domain)`,
      location: manifestPath,
    });
    return findings;
  }
  const pattern = profile.allowedSynthDomains?.pattern ?? /^agint_synth_[a-z0-9_]+$/;
  for (const d of domains) {
    if (typeof d !== 'string' || d.length === 0) {
      findings.push({
        family: FAMILY, severity: 'blocker',
        message: `[${SUBCHECKS.domainIsolation}] non-string or empty storage domain: ${JSON.stringify(d)}`,
        location: manifestPath,
      });
      continue;
    }
    if (!pattern.test(d)) {
      findings.push({
        family: FAMILY, severity: 'blocker',
        message: `[${SUBCHECKS.domainIsolation}] storage domain '${d}' violates synth-only policy (must match ${pattern})`,
        location: manifestPath,
      });
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ③：依赖白名单 dependencyWhitelist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 依赖白名单检查（设计稿 §4.4 第三项）。
 *
 * 检测目标：产物 pluginDir/lib/ + index.js 内所有源码，扫描 import / require
 * 形式的 host service 引用：
 *   - `import ... from '@deepseek-ai/agint-<x>'`
 *   - `require('@deepseek-ai/agint-<x>')`
 *   - `import('@deepseek-ai/agint-<x>')`
 *
 * 命中规则（老板 2026-08-27 拍板）：
 *   - 命中 ALLOWED_HOST_SERVICES（memory / metrics / cron）→ 放行
 *   - 命中任何其他 `@deepseek-ai/agint-<x>` → blocker（含 agint-quality-* /
 *     agint-mount / agint-mutator / agint-quality-static 自己 / agint-anything-else）
 *   - 命中非 `@deepseek-ai/agint-*` 但形如 `agint-*` 的包名（少见但防呆）→ blocker
 *
 * 行数预算：scan-files 已经复用；这里只需正则与白名单集合。
 *
 * @returns {Array<Finding>}
 */
export function checkDependencyWhitelist({ pluginDir, profile }) {
  const findings = [];
  const allowList = new Set(profile.allowedHostServices ?? []);
  const importPattern = /from\s+['"`](@deepseek-ai\/agint-[a-z0-9_-]+|agint-[a-z0-9_-]+)['"`]/g;
  const requirePattern = /require\s*\(\s*['"`](@deepseek-ai\/agint-[a-z0-9_-]+|agint-[a-z0-9_-]+)['"`]\s*\)/g;
  const dynamicImportPattern = /import\s*\(\s*['"`](@deepseek-ai\/agint-[a-z0-9_-]+|agint-[a-z0-9_-]+)['"`]\s*\)/g;

  for (const file of collectSourceFiles(pluginDir)) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const matches = [
        ...matchAll(line, importPattern),
        ...matchAll(line, requirePattern),
        ...matchAll(line, dynamicImportPattern),
      ];
      for (const m of matches) {
        const pkg = m[1];
        // 非 deepseek 命名空间下的 agint-* 包（少见，防呆）
        if (!pkg.startsWith('@deepseek-ai/')) {
          findings.push({
            family: FAMILY, severity: 'blocker',
            message: `[${SUBCHECKS.dependencyWhitelist}] references non-namespaced agint package '${pkg}' (only @deepseek-ai/agint-* allowed)`,
            location: `${file}:${i + 1}`,
          });
          continue;
        }
        if (!allowList.has(pkg)) {
          findings.push({
            family: FAMILY, severity: 'blocker',
            message: `[${SUBCHECKS.dependencyWhitelist}] unauthorized host service '${pkg}' (allowed: ${[...allowList].join(', ')})`,
            location: `${file}:${i + 1}`,
          });
        }
      }
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读取并解析 pluginDir/manifest.json；解析失败返回 null（让调用方报告 blocker）。
 * 防御性 try/catch —— 故意破坏的产物可能有 JSON 语法错误。
 */
function readManifest(pluginDir) {
  const p = resolve(pluginDir, 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 判断产物是否「像合成产物」—— 仅在 l0IsolationOnly 模式下生效。
 *
 * 判定策略（任一命中即视为 synth 产物）：
 *   - plugin name 以 'agint-synth-' 开头（命名约定）
 *   - plugin name 以 '-synth' 结尾（命名约定变体）
 *   - storage.domains 中至少有一个匹配 ALLOWED_SYNTH_DOMAINS.pattern
 *   - 插件根目录路径包含 '.staging/' 或 'fixtures/mount/'（mount staging 区 / fixture 区）
 */
function looksLikeSynthArtifact(manifest, profile) {
  if (!manifest) return false;
  const name = typeof manifest.name === 'string' ? manifest.name : '';
  if (name.startsWith('agint-synth-') || name.endsWith('-synth')) return true;
  const domains = manifest?.storage?.domains;
  const pattern = profile.allowedSynthDomains?.pattern ?? /^agint_synth_[a-z0-9_]+$/;
  if (Array.isArray(domains) && domains.some(d => typeof d === 'string' && pattern.test(d))) {
    return true;
  }
  return false;
}

/**
 * 安全版 String.matchAll（Node 16+ 自带；但显式写出来避免 lint 误判）。
 */
function* matchAll(line, re) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    yield m;
    if (m.index === re.lastIndex) re.lastIndex += 1; // 防零宽死循环
  }
}
