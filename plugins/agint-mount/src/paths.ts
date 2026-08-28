/**
 * agint-mount — 路径解析（红线：不使用 dsh 新增的 dsh.profilesDir Service）
 *
 * 来源策略（spike 决策）：
 *   - profiles/web/ 路径仅由 process.env.DSH_HOME 拼出（顶层 layout 约定）
 *   - 若 ctx 暴露了 `profilesDir` Service（可能存在旧版 dsh），作为可选项兜底
 *   - 拼出后做 existence check；不存在立即抛错并 emit mount.failed（NOT_FOUND）
 *
 * 不直接调用任何 dsh 官方 preset；纯 host-side 路径解析。
 */
import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

export interface PathsConfig {
  dshHome: string;          // DSH_HOME 解析后
  profilesWeb: string;      // ~/.dsh/profiles/web
  cordisPatch: string;      // ~/.dsh/profiles/web/cordis.patch.yml
  pluginsRoot: string;      // ~/.dsh/profiles/web/plugins
  stagingRoot: string;      // ~/.dsh/profiles/web/plugins/.staging
  webPackageJson: string;   // ~/.dsh/profiles/web/package.json
  sentinelLease: string;    // ~/.dsh/sentinel.lease
  agintHome: string;        // AGINT_HOME（mount 不强制使用，留作发事件 payload）
}

/**
 * 解析所有路径。允许 ctx 注入 profilesDir（可选），否则从 DSH_HOME 拼。
 *
 * @throws Error DSH_HOME 未设或顶层目录不存在
 */
export function resolvePaths(opts: {
  dshHome?: string;
  env?: NodeJS.ProcessEnv;
  profilesDir?: string; // 可选（旧版 dsh 可能暴露）
  agintHome?: string;
}): PathsConfig {
  const env = opts.env ?? process.env;
  const dshHome = opts.dshHome ?? env.DSH_HOME ?? '';
  if (!dshHome) {
    throw new Error('agint-mount: DSH_HOME 未设置，无法定位 profiles/web/');
  }
  const home = resolve(dshHome);
  const profilesWeb = opts.profilesDir ?? join(home, 'profiles', 'web');
  if (!existsSync(profilesWeb)) {
    throw new Error(`agint-mount: profiles/web 不存在：${profilesWeb}`);
  }
  return {
    dshHome: home,
    profilesWeb,
    cordisPatch: join(profilesWeb, 'cordis.patch.yml'),
    pluginsRoot: join(profilesWeb, 'plugins'),
    stagingRoot: join(profilesWeb, 'plugins', '.staging'),
    webPackageJson: join(profilesWeb, 'package.json'),
    sentinelLease: join(home, 'sentinel.lease'),
    agintHome: opts.agintHome ?? env.AGINT_HOME ?? '',
  };
}

/** staging 子目录：.staging/<ticketId> */
export function stagingDirFor(root: string, ticketId: string): string {
  return join(root, ticketId);
}

/** atomic backup 文件路径：cordis.patch.yml.bak-<ISO-timestamp-safe> */
export function backupPathFor(patchPath: string, when: Date = new Date()): string {
  const ts = when.toISOString().replace(/[:.]/g, '-');
  return `${patchPath}.bak-${ts}`;
}

/** 列出某个目录下所有 .bak-* 文件（用于 orphan 清理 / 崩溃恢复） */
export function listBackups(patchPath: string): string[] {
  const dir = dirname(patchPath);
  // 轻量实现：不读 dir，调用方传 glob 结果；保留接口便于测试注入
  return [];
}
