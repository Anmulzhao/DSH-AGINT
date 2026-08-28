/**
 * agint-mount — cordis.patch.yml 两段式 commit（spike 决策）
 *
 * 硬要求：
 *   1) 写 patch.yml 前先 atomic backup `.bak-<timestamp>`
 *   2) HMR apply 成功后再删 .bak-*
 *   3) HMR apply 失败 → agint-mount 自己从 backup 恢复 YAML + dispose 新 entry
 *
 * 设计：
 *   - 不引入新文件锁机制；用 atomic rename（write tmp → rename）保证 YAML 文件本身不损坏
 *   - backup 与新 patch 同样走 atomic rename；避免 fsync 失效场景
 *   - 调用方负责 await `settle`（监听 HMR 心跳）→ 成功则 cleanup，失败则 restore
 *
 * 不修改 dsh loader；不引入 dsh.profilesDir Service。
 */
import { rename, writeFile, readFile, unlink, copyFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { backupPathFor } from './paths.js';

/**
 * 在写 patch.yml 之前调用。
 * - 读原 patch.yml（如不存在则视为空）
 * - atomic 备份到 `.bak-<timestamp>`
 * - 返回 backup 路径（settle 成功后用于 cleanup；失败时用于 restore）
 */
export async function backupPatch(patchPath: string, when: Date = new Date()): Promise<string> {
  const bak = backupPathFor(patchPath, when);
  await copyFile(patchPath, bak);
  return bak;
}

/**
 * 写新 patch.yml（atomic）。
 * 流程：写 `${patchPath}.tmp` → rename 到 patchPath
 * 失败抛错；调用方应进入 restore。
 */
export async function writePatchAtomic(patchPath: string, content: string): Promise<void> {
  const tmp = `${patchPath}.tmp-${Date.now()}`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, patchPath);
}

/**
 * 从 backup 恢复 patch.yml（失败兜底）。
 * HMR apply 失败 / mount.rollback 触发时调用。
 */
export async function restorePatch(patchPath: string, backupPath: string): Promise<void> {
  await copyFile(backupPath, patchPath);
}

/** cleanup：HMR apply 成功后删除 backup（永不删失败前的） */
export async function cleanupBackup(backupPath: string): Promise<void> {
  try { await unlink(backupPath); }
  catch { /* 文件可能已被人工清理；忽略 */ }
}

/**
 * 生成新 patch.yml 内容：在末尾追加一行 `- id: <id>`。
 * 不做 yaml 库依赖（避免 zod/yaml 多版本冲突），纯字符串拼接。
 * 输入：现有文件全文 + 新 row 字符串（如 `  - id: agint-foo\n    name: ...\n    config: {}`）。
 */
export function appendRow(originalYaml: string, newRow: string): string {
  const sep = originalYaml.endsWith('\n') ? '' : '\n';
  return `${originalYaml}${sep}\n# mounted by agint-mount\n${newRow}\n`;
}

/**
 * 从 patch.yml 中移除一行 `- id: <id>`（用于 rollback 时同步清理）。
 * 简单字符串匹配；要求 id 行无前导空格外其它内容。
 */
export function removeRow(originalYaml: string, id: string): string {
  const lines = originalYaml.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^\s*-?\s*id:\s*([\w.-]+)/);
    if (m && m[1] === id) {
      // 吞掉这一行 + 后面紧跟的 name/config（直到下一个 - id 或文件尾）
      i += 1;
      while (i < lines.length && !/^\s*-?\s*id:/.test(lines[i])) i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

/**
 * 构造 patch row 字符串。CLI 形态与既有的 - id:/name:/config: 保持一致。
 */
export function formatRow(id: string, mainRelPath: string, configJson: string = '{}'): string {
  return `- id: ${id}\n  name: ${mainRelPath}\n  config: ${configJson}`;
}
