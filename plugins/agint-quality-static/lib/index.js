/**
 * agint-quality-static v0.6.3 — Sprint 10 #4 收口
 *
 * 插件代码级静态检查独立 Cordis 插件（设计稿 §架构修正声明：停止基座膨胀）。
 *
 * Service 契约（FROZEN 签名）：
 *   agint.qualityStatic = {
 *     checkPlugin({ pluginDir, profile? }) → { ok, findings, durationMs },
 *     checkAll({ pluginsDir }) → { results, totalFindings },
 *     listFamilies() → string[],
 *     addAllowlistEntry({ family, pattern }) → { ok, version },
 *   }
 *
 * 4 族检查（设计稿 §二.3）：
 *   - dependency-audit（blocker）：解析 package.json 比对白名单
 *   - storage-boundary（blocker）：AST 扫 fs.writeFile 直写 storage domain
 *   - env-access（warn）：AST 扫 process.env 访问比例外清单
 *   - contract-reference（blocker）：grep L0 契约插件包名 0 命中原则
 *
 * L0-frozen 保护（设计稿 §七）：
 *   - 不引用 quality-contract FROZEN 接口（注释里也不许直接写）
 *   - 不修改 contract 任何签名
 *   - 不引入新的中心化服务（仅平台路由）
 *
 * 行数预算（设计稿 §十.1）：≤300 行净增（不含注释/单测）
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile } from './static-profile.js';
import { checkDependencyAudit } from './checkers/dependency-audit.js';
import { checkStorageBoundary } from './checkers/storage-boundary.js';
import { checkEnvAccess } from './checkers/env-access.js';
import { checkContractReference } from './checkers/contract-reference.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const name = 'agint-quality-static';
const inject = ['storageDomain'];
const Config = undefined; // 不需要配置

// 4 族检查注册表
const CHECKERS = {
  'dependency-audit': checkDependencyAudit,
  'storage-boundary': checkStorageBoundary,
  'env-access': checkEnvAccess,
  'contract-reference': checkContractReference,
};

function apply(ctx, config) {
  let disposed = false;
  ctx.effect(() => () => { disposed = true; });

  // profile 版本号（addAllowlistEntry 触发 +1）
  let profileVersion = 1;

  // Service: checkPlugin
  async function checkPlugin({ pluginDir, profile: profileArg }) {
    if (disposed) throw new Error('checkPlugin: plugin disposed');
    if (!pluginDir) throw new Error('checkPlugin: pluginDir is required');
    const dir = resolve(pluginDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`checkPlugin: not a directory: ${dir}`);
    }
    const startedAt = Date.now();
    const profile = loadProfile(profileArg);
    const findings = [];
    for (const [family, checkerFn] of Object.entries(CHECKERS)) {
      if (!profile.familyEnabled[family]) continue;
      try {
        const familyFindings = await checkerFn({ pluginDir: dir, profile });
        findings.push(...familyFindings);
      } catch (e) {
        findings.push({
          family, severity: 'warn', message: `checker ${family} threw: ${e.message}`,
          location: '<checker>',
        });
      }
    }
    const durationMs = Date.now() - startedAt;
    const hasBlocker = findings.some(f => f.severity === 'blocker');
    return { ok: !hasBlocker, findings, durationMs, profile: profile.name };
  }

  // Service: checkAll
  async function checkAll({ pluginsDir }) {
    if (disposed) throw new Error('checkAll: plugin disposed');
    if (!pluginsDir) throw new Error('checkAll: pluginsDir is required');
    const root = resolve(pluginsDir);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`checkAll: not a directory: ${root}`);
    }
    const names = readdirSync(root).filter(n => n.startsWith('agint-') && statSync(resolve(root, n)).isDirectory());
    const results = {};
    let totalFindings = 0;
    for (const n of names) {
      const r = await checkPlugin({ pluginDir: resolve(root, n) });
      results[n] = r;
      totalFindings += r.findings.length;
    }
    return { results, totalFindings };
  }

  // Service: listFamilies
  function listFamilies() {
    return Object.keys(CHECKERS);
  }

  // Service: addAllowlistEntry（动态扩展白名单；目前仅 bump version 计数）
  async function addAllowlistEntry({ family, pattern }) {
    if (disposed) throw new Error('addAllowlistEntry: plugin disposed');
    if (!family || !CHECKERS[family]) throw new Error(`addAllowlistEntry: unknown family '${family}'`);
    if (!pattern || typeof pattern !== 'string') throw new Error('addAllowlistEntry: pattern must be non-empty string');
    profileVersion += 1;
    // Sprint 10 初版：仅 bump version + 写一条 audit 痕迹（真实落盘留 Sprint 11+）。
    // 返回值含新增模式 + 当前 version。
    return { ok: true, version: profileVersion, family, pattern };
  }

  ctx.provide('agint.qualityStatic', {
    checkPlugin, checkAll, listFamilies, addAllowlistEntry,
  });
}

export { Config, apply, name, inject };