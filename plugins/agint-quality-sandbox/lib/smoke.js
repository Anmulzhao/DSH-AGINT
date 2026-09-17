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

  // —— 技能(skill) 分支：纯 SKILL.md 目录，没有插件结构 ——
  // AGINT 的自动生成技能是 纯 SKILL.md（无 package.json / lib/index.js），
  // 旧 smoke 只认 plugin 契约（要求 lib/index.js + 导出 Config/apply/inject/name），
  // 会对技能天然失败 → 质量门 safety=0 → policy 否决 → 自动技能永远挂不上。
  // 这里识别"有 SKILL.md 且非插件形态"就走技能专用校验，不再误杀。
  const skillMdPath = resolve(pluginPath, 'SKILL.md');
  const hasSkillMd = existsSync(skillMdPath);
  const hasPluginShape = existsSync(resolve(pluginPath, 'package.json')) || existsSync(resolve(pluginPath, 'lib', 'index.js'));
  if (hasSkillMd && !hasPluginShape) {
    return runSkillSmoke(pluginPath, skillMdPath, { pass, fail, checks });
  }

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

/**
 * 技能(skill) 专用冒烟校验：纯 SKILL.md 目录。
 * 校验项（比 plugin 轻，因为技能是文档不是可执行模块）：
 *   S1  SKILL.md 可读
 *   S2  frontmatter（--- YAML ---）合法，且含 name + description 关键字段
 *   S3  无危险操作（rm -rf / curl|sh / sudo / eval( / child_process / fork-bomb 等）
 * 返回 { ok, checks, reason? }，形状与 plugin runSmoke 一致。
 */
async function runSkillSmoke(skillPath, skillMdPath, { pass, fail, checks }) {
  // S1: SKILL.md 可读
  let content;
  try {
    content = readFileSync(skillMdPath, 'utf8');
    pass('skill-md-read', skillMdPath);
  } catch (e) {
    fail('skill-md-read', e.message);
    return { ok: false, checks, reason: 'skill-md-unreadable' };
  }

  // S2: frontmatter 合法 + 关键字段
  const fm = parseFrontmatter(content);
  if (!fm || typeof fm !== 'object') {
    fail('skill-frontmatter', 'missing or malformed "--- YAML ---" block at top of SKILL.md');
    return { ok: false, checks, reason: 'skill-frontmatter-missing' };
  }
  const required = ['name', 'description'];
  const missing = required.filter((k) => !fm[k] || typeof fm[k] !== 'string' || !fm[k].trim());
  if (missing.length > 0) {
    fail('skill-frontmatter-fields', `missing required field(s): ${missing.join(', ')}`);
    return { ok: false, checks, reason: 'skill-frontmatter-fields' };
  }
  pass('skill-frontmatter', `name=${fm.name}`);

  // S3: 无危险操作（粗略 grep 正文里的危险字面）
  const dangerPatterns = [
    /\brm\s+-[rf]+\b/i,            // rm -rf / rm -fr / rm -r
    /\bcurl\b[\s\S]*\|\s*(sh|bash)/i,
    /\bwget\b[\s\S]*\|\s*(sh|bash)/i,
    /\bsudo\b/i,
    /\beval\s*\(/,
    /\bchild_process\b/,
    /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
    /\bprocess\s*\.\s*exit\s*\(/,
    /:\(\)\s*\{[\s\S]*\|\s*:/,     // fork bomb
  ];
  const hits = [];
  for (const pat of dangerPatterns) {
    if (pat.test(content)) hits.push(pat.source);
  }
  if (hits.length > 0) {
    fail('skill-no-dangerous-ops', `dangerous patterns: ${hits.slice(0, 3).join(', ')}`);
    return { ok: false, checks, reason: 'skill-dangerous-ops' };
  }
  pass('skill-no-dangerous-ops', 'no dangerous shell/exec patterns');

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks, reason: allOk ? undefined : 'smoke-failed' };
}

/**
 * 极简 YAML frontmatter 解析：取 SKILL.md 顶部 --- 块里的 key: value。
 * 只支持标量赋值（name/description/tools/triggers 等首行值），足够质量门校验。
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const body = m[1];
  const fm = {};
  for (const line of body.split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return fm;
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
