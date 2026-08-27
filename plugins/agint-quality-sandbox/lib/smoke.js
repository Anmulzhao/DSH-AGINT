/**
 * agint-quality-sandbox/lib/smoke.js — plugin 冒烟测试脚本模板
 *
 * 在沙箱里 spawn 执行 plugin 验证步骤：
 *   1. dynamic import plugin lib/index.js（验证 ESM 解析）
 *   2. 验证 package.json 存在 + 含 name/main/type:module
 *   3. 验证 exports 含 Config/apply/inject/name
 *   4. 验证 lib/index.js 不依赖 sandbox 外面的网络（粗略 grep）
 *
 * 沙箱执行约束（由 agint-quality-sandbox service 包装）：
 *   - sandbox_permissions: workspace-write（plugin 自己的目录可读）
 *   - timeout: 30s
 *   - memory: 512MB
 *   - 网络隔离（bwrap --unshare-net 或 sandbox-exec deny network*）
 *
 * 退出码：
 *   0 = pass
 *   1 = smoke 失败（plugin 结构问题）
 *   2 = 环境错误（plugin 不存在 / import 失败）
 *   3 = 超时
 *
 * 运行方式（生产 dsh 启动后）：
 *   $ dsh web  # 启动 dsh，加载 agint-quality-sandbox + dsh-sandbox-local
 *   # 然后通过 agint.qualitySandbox.runSmoke({ target: { path: '...' } })
 *
 * 沙箱外运行（仅检查结构，不走真沙箱）：
 *   node lib/smoke.js <plugin-path>
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run smoke checks against a plugin at `pluginPath`.
 * Returns { ok, checks: [{ name, ok, detail }], reason? }.
 *
 * Designed to be called from inside a sandbox (spawn child process) but
 * also works as a standalone CLI for dev/CI use.
 *
 * @param {string} pluginPath - absolute path to plugin directory
 */
export async function runSmoke(pluginPath) {
  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  // Check 1: plugin 目录存在
  if (!existsSync(pluginPath)) {
    fail('plugin-exists', `plugin path does not exist: ${pluginPath}`);
    return { ok: false, checks, reason: 'plugin-not-found' };
  }
  pass('plugin-exists', pluginPath);

  // Check 2: package.json 存在且合法
  const pkgPath = resolve(pluginPath, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package-json-exists', `missing package.json at ${pkgPath}`);
    return { ok: false, checks, reason: 'package-json-missing' };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pass('package-json-parses', JSON.stringify({ name: pkg.name, main: pkg.main, type: pkg.type }).slice(0, 60));
  } catch (e) {
    fail('package-json-parses', e.message);
    return { ok: false, checks, reason: 'package-json-invalid' };
  }

  // Check 3: package.json type: module（AGINT plugin 必须 ESM）
  if (pkg.type !== 'module') {
    fail('package-json-esm', `package.json type="${pkg.type ?? 'missing'}" but AGINT plugins require "module"`);
  } else {
    pass('package-json-esm', 'type: module');
  }

  // Check 4: main 指向存在的文件
  const mainPath = resolve(pluginPath, pkg.main ?? 'lib/index.js');
  if (!existsSync(mainPath)) {
    fail('main-file-exists', `main file does not exist: ${mainPath}`);
  } else {
    pass('main-file-exists', mainPath);
  }

  // Check 5: dynamic import plugin lib（验证 ESM 解析 + 导出形状）
  try {
    const mod = await import(`file://${mainPath}`);
    const required = ['Config', 'apply', 'inject', 'name'];
    const missing = required.filter((k) => !(k in mod));
    if (missing.length > 0) {
      fail('plugin-exports', `missing exports: ${missing.join(', ')}`);
    } else {
      pass('plugin-exports', required.join(','));
    }
  } catch (e) {
    fail('plugin-import', `cannot dynamic import: ${e.message}`);
    return { ok: false, checks, reason: 'plugin-import-failed' };
  }

  // Check 6: 不依赖外部网络（粗略 grep plugin lib/*.js 里的 fetch/axios/dns）
  const libDir = resolve(pluginPath, 'lib');
  if (existsSync(libDir)) {
    try {
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(libDir).filter((f) => f.endsWith('.js'));
      const networkPatterns = [
        /\bfetch\s*\(/,
        /\baxios\./,
        /\bnode-fetch\b/,
        /\bgot\s*\(/,
        /\bhttps?\.request\s*\(/,
        /\bdns\s*\.\s*(lookup|resolve)/,
      ];
      const hits = [];
      for (const f of files) {
        const text = readFileSync(resolve(libDir, f), 'utf8');
        for (const pat of networkPatterns) {
          if (pat.test(text)) hits.push(`${f}:${pat.source}`);
        }
      }
      if (hits.length > 0) {
        fail('no-external-network', `plugin lib/ contains network calls: ${hits.slice(0, 3).join(', ')}`);
      } else {
        pass('no-external-network', `${files.length} files scanned`);
      }
    } catch (e) {
      fail('no-external-network', `scan failed: ${e.message}`);
    }
  } else {
    pass('no-external-network', 'no lib/ dir to scan');
  }

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks, reason: allOk ? undefined : 'smoke-failed' };
}

// CLI 入口：node lib/smoke.js <plugin-path>
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node lib/smoke.js <plugin-path>');
    process.exit(2);
  }
  const absoluteTarget = resolve(target);
  const result = await runSmoke(absoluteTarget);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
