// plugins/agint-cron/lib/spec-index-audit.js —— 协议索引只读审计
//
// 用途：cron 的 spec-index-refresh job 每月跑一次，回答一个问题——
//   「docs/specs/INDEX.json 还和磁盘上的规范文件一致吗？」
//
// ⛔ **只读，不写盘**（形态决定，Phase-3 计划 §4.2 轨道 C）：
//   索引是**仓库资产**，由 `node bin/build-spec-index.mjs` 在开发机上生成、
//   随 code review 走。cron 在宿主进程里跑，宿主不是仓库的工作副本 ——
//   在那里改 INDEX.json 等于绕过 review 直接改仓库内容。
//   所以本 job 只**发现漂移并出声**，修复动作由人做。
//
// ⛔ **部署位没有 docs/**（实测 2026-10-03）：
//   bundle 部署位 `$DSH_HOME/profiles/web/node_modules/@agint/host/`
//   只有 `cordis.patch.yml` / `package.json` / `plugins/`，**没有 docs/ 也没有 bin/**。
//   ⇒ 常驻宿主上这个 job 大概率 soft-skip。这不是「实现有 bug」，是「能力不在这一层」
//     —— 两类必须能区分（K134），所以 skip 时必须写清**缺哪一项**。
//
// 判据来源：复用 `bin/build-spec-index.mjs` 导出的 `validateIndex`，
//   **不自造第二份判据**（两份校验器必然分叉，K110/K133 同源）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 索引文件相对仓库根的位置。 */
export const INDEX_REL = join('docs', 'specs', 'INDEX.json');

/** 生成器相对仓库根的位置（审计判据的来源）。 */
export const GENERATOR_REL = join('bin', 'build-spec-index.mjs');

/**
 * 「不是规范」的磁盘文件白名单 —— 从生成器 import，不在本文件复写一份。
 *
 * ⛔ 为什么不写死：生成器与一致性门禁已经踩过「两份白名单分叉」的坑
 *   （build-spec-index.mjs:44 注释）。这里再写第三份就是重犯。
 *   生成器未导出时返回 null，调用方据此把「无法审计」与「审计通过」区分开。
 */
async function loadGenerator(repoRoot) {
  const genPath = join(repoRoot, GENERATOR_REL);
  if (!existsSync(genPath)) {
    return { ok: false, reason: `GENERATOR_MISSING: ${GENERATOR_REL} 不存在` };
  }
  let mod;
  try {
    // 动态 import：仓库路径在运行时才确定，静态 import 会在模块加载期就炸。
    mod = await import(pathToFileURL(genPath).href);
  } catch (error) {
    return { ok: false, reason: `GENERATOR_UNLOADABLE: ${error.message}` };
  }
  if (typeof mod.validateIndex !== 'function' || typeof mod.validateSchemaHashDrift !== 'function') {
    // ⛔ 不猜、不退化：生成器没导出这两个判据就是「判据不可用」，
    //   此时若返回「通过」就是**假防线**（查不出漂移的检查等于没有检查）。
    //   ⭐ 2026-10-03 实测：validateIndex 原本**不含** schemaHash 漂移检查
    //   （那段只写在 main() 的 --check 分支里），只调它会一路绿灯。
    //   两份判据都必须在，才算「审计 = --check 的等价物」。
    return {
      ok: false,
      reason: 'GENERATOR_NO_VALIDATE: validateIndex / validateSchemaHashDrift 未导出，判据不可用',
    };
  }
  return { ok: true, mod };
}

/** 列出 docs/specs/ 下应被索引的实体文件。 */
function listSpecFiles(specsDir, nonSpecFiles) {
  if (!existsSync(specsDir)) return null;
  return readdirSync(specsDir)
    .filter((f) => /\.(md|json)$/.test(f) && !nonSpecFiles.has(f))
    .sort();
}

/**
 * 审计协议索引。
 *
 * @param {object} deps
 * @param {string} deps.repoRoot  AGINT 仓库根（绝对路径）
 * @param {typeof import('node:fs')} [deps.fs] 注入点（测试用）
 * @returns {Promise<object>} 结构化结果，**永不为 null**
 *
 * 返回形状（三种，调用方必须能区分）：
 *   { status:'skipped', reason }              —— 判据不可用（不是仓库 / 生成器缺失）
 *   { status:'ok', specCount, pendingCount, untracked }  —— 一致
 *   { status:'drift', errors[], specCount }   —— 有漂移（errors 非空）
 */
export async function auditSpecIndex({ repoRoot }) {
  if (!repoRoot) {
    return { status: 'skipped', reason: 'REPO_ROOT_UNKNOWN: 未提供仓库根' };
  }

  const gen = await loadGenerator(repoRoot);
  if (!gen.ok) {
    return { status: 'skipped', reason: gen.reason };
  }

  const specsDir = join(repoRoot, 'docs', 'specs');
  const indexPath = join(specsDir, 'INDEX.json');
  if (!existsSync(indexPath)) {
    return { status: 'skipped', reason: `INDEX_MISSING: ${INDEX_REL} 不存在` };
  }
  if (!gen.mod.NON_SPEC_FILES) {
    return { status: 'skipped', reason: 'WHITELIST_UNAVAILABLE: NON_SPEC_FILES 未导出' };
  }

  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (error) {
    return { status: 'drift', errors: [`INDEX_UNREADABLE: ${error.message}`], specCount: 0 };
  }

  const onDisk = listSpecFiles(specsDir, gen.mod.NON_SPEC_FILES);
  if (onDisk === null) {
    return { status: 'skipped', reason: 'SPECS_DIR_MISSING: docs/specs/ 不存在' };
  }
  if (typeof gen.mod.computeIndex !== 'function') {
    return { status: 'skipped', reason: 'GENERATOR_NO_COMPUTE: computeIndex 未导出，无法重算比对' };
  }

  // ⭐ 与 `--check` 逐字同源：同一份 validateIndex + 同一份 validateSchemaHashDrift。
  //   少任何一份都会让巡检比门禁弱 —— 而巡检比门禁弱等于没有巡检。
  const fresh = gen.mod.computeIndex();
  const errors = [
    ...gen.mod.validateIndex(index, onDisk),
    ...gen.mod.validateSchemaHashDrift(index, fresh),
  ];
  const specCount = (index.specs ?? []).length;
  const pendingCount = (index.pendingSpecs ?? []).length;
  const untracked = onDisk.filter(
    (f) => !(index.specs ?? []).some((s) => (s.files ?? []).includes(f)),
  );

  if (errors.length > 0) {
    return { status: 'drift', errors, specCount, pendingCount, untracked };
  }
  return { status: 'ok', specCount, pendingCount, untracked };
}
