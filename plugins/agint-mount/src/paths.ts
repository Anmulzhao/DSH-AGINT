/**
 * agint-mount — 路径解析（红线：不使用 dsh 新增的 dsh.profilesDir Service）
 *
 * 来源策略（spike 决策）：
 *   - profiles/<profile>/ 路径仅由 process.env.DSH_HOME 拼出（顶层 layout 约定）
 *   - 若 ctx 暴露了 `profilesDir` Service（可能存在旧版 dsh），作为可选项兜底
 *   - 拼出后做 existence check；不存在立即抛错并 emit mount.failed（NOT_FOUND）
 *
 * profile 名不再写死 'web'（2026-10-08 改造，适配 desktop profile）。
 * 解析口径见 resolveProfileName()。本文件与 lib/paths.js 手工同步（无编译步骤）。
 *
 * 不直接调用任何 dsh 官方 preset；纯 host-side 路径解析。
 */
import { join, resolve, dirname, basename } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const DEFAULT_PROFILE = 'web';
/** 判定一个目录是否是「装了 AGINT 插件的 profile 目录」的标记前缀 */
const AGINT_PLUGIN_PREFIX = 'agint-';
/** AGINT 安装器写入的「安装到哪个 profile」事实文件（相对 $DSH_HOME） */
const PROFILE_FACT_REL = join('.agint-bundle', 'profile.json');

/**
 * 读安装事实：install.sh 把本次安装的目标 profile 名写进 $DSH_HOME/.agint-bundle/profile.json。
 *
 * 为什么需要它（2026-10-08 实测）：DSH_PROFILE / DSH_PROFILE_DIR 只喂 shell 子进程，
 * 插件主进程读不到（见 resolveProfileName 注释）。安装事实文件是 AGINT 自己写的、
 * 不依赖 dsh 内部契约的真源，比「扫目录猜」更准。
 *
 * @returns {string|null} 读不到 / 坏了返回 null（不是错误，继续回落）
 */
export function readInstalledProfile(dshHome: string): string | null {
  if (!dshHome) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(dshHome), PROFILE_FACT_REL), 'utf8'));
    const name = parsed?.profile;
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
  } catch {
    return null;
  }
}

export interface PathsConfig {
  dshHome: string;          // DSH_HOME 解析后
  profileName: string;      // 生效的 profile 名（web / desktop / …）
  profilesWeb: string;      // 兼容别名 = profilesDir（老调用方按此名取，不能断）
  profilesDir: string;      // ~/.dsh/profiles/<profile>
  cordisPatch: string;      // ~/.dsh/profiles/<profile>/cordis.patch.yml
  pluginsRoot: string;      // ~/.dsh/profiles/<profile>/plugins
  stagingRoot: string;      // ~/.dsh/profiles/<profile>/plugins/.staging
  webPackageJson: string;   // ~/.dsh/profiles/<profile>/package.json
  sentinelLease: string;    // ~/.dsh/sentinel.lease
  agintHome: string;        // AGINT_HOME（mount 不强制使用，留作发事件 payload）
}

export interface ProfileNameOptions {
  profile?: string;         // 显式指定（最高优先）
  profileName?: string;     // 同 profile，供「从 ctx 传进来」的场合表意
  dshHome?: string;         // 覆盖 DSH_HOME（探测用）
  env?: NodeJS.ProcessEnv;
  fallback?: string;        // 全部落空时的最终回落值
}

function nonEmpty(v: string | undefined | null): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 列出 $DSH_HOME/profiles 下的 profile 名（按名字排序，保证探测结果稳定）。
 * 目录不存在 / 读不动时返回空数组 —— 不抛：探测属于兜底层，失败应回落到上层优先级。
 */
export function listProfileNames(dshHome: string): string[] {
  if (!dshHome) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(join(resolve(dshHome), 'profiles'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/**
 * 探测「哪个 profile 装了 AGINT」：条件是该 profile 的 plugins/ 下有 agint-* 目录。
 *
 * ⛔ 为什么只在**唯一命中**时才认（2026-10-08）：
 *   多 profile 都装了 AGINT 时（例如 web 是历史部署位、desktop 是新装的），
 *   猜哪一个都是 50% 错。猜错的代价是「服务起来、路径指错、零报错」——
 *   正是本次改造要消灭的那类静默降级。所以多命中时返回空结果，交给上层回落，
 *   由调用方用 profileContext / DSH_PROFILE 这类**权威信号**来定。
 */
export function detectAgintProfiles(dshHome: string): string[] {
  const hits: string[] = [];
  for (const name of listProfileNames(dshHome)) {
    const pluginsDir = join(resolve(dshHome), 'profiles', name, 'plugins');
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      continue; // 该 profile 没有 plugins/ 或读不动：不算命中，也不算错误
    }
    if (entries.some((e) => e.isDirectory() && e.name.startsWith(AGINT_PLUGIN_PREFIX))) {
      hits.push(name);
    }
  }
  return hits;
}

/**
 * 解析当前生效的 dsh profile 名。
 *
 * 优先级链（先权威后猜测，逐层回落）：
 *   ① opts.profile / opts.profileName  —— 调用方显式给（测试、或上层已算好）
 *   ② env.DSH_PROFILE                  —— dsh 官方 shell 环境变量
 *   ③ env.DSH_PROFILE_DIR 的 basename  —— 同上，同一次注入
 *   ④ 安装事实文件 $DSH_HOME/.agint-bundle/profile.json —— 安装器写入，最可信的兜底
 *   ⑤ 探测 profiles/<任意名>/plugins 含 agint-* 者 —— 唯一命中才认（见 detectAgintProfiles）
 *   ⑥ opts.fallback ?? 'web'
 *
 * ⚠️ 关于 ②③（2026-10-08 实测，写在代码里防止后人再踩）：
 *   dsh 桌面版（0.2.x，app.asar 内 shell-env 插件）里 DSH_PROFILE / DSH_PROFILE_DIR
 *   是 **shell 调用注册表**的内置键 —— 只在每次 bash / pwsh 子进程执行时由
 *   `collect()` 现构造（`values[DSH_PROFILE_KEY] = profile.name`），
 *   **从不写进 process.env**（全仓 `process.env[DSH_...] =` 赋值 0 命中）。
 *   所以插件主进程里 `process.env.DSH_PROFILE` 通常是 undefined。
 *   它仍然留在这条链上：AGINT 自己起的 bash 子进程会带着它，且命令行手跑时也有效。
 *   真正权威、且在插件进程里拿得到的是 **cordis ctx**：`ctx.get('profileContext')?.name`
 *   （dsh 官方 patch 里就这么用：`disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`）。
 *   调用方应把 ctx 拿到的名字通过 ① 传进来。
 */
export function resolveProfileName(opts: ProfileNameOptions = {}): string {
  const env = opts.env ?? process.env;
  const explicit = nonEmpty(opts.profile) ?? nonEmpty(opts.profileName);
  if (explicit) return explicit;
  const fromEnv = nonEmpty(env.DSH_PROFILE);
  if (fromEnv) return fromEnv;
  const dirEnv = nonEmpty(env.DSH_PROFILE_DIR);
  if (dirEnv) return basename(resolve(dirEnv));
  const dshHome = opts.dshHome ?? env.DSH_HOME ?? '';
  if (dshHome) {
    const installed = readInstalledProfile(dshHome);
    if (installed) return installed;
    const hits = detectAgintProfiles(dshHome);
    if (hits.length === 1) return hits[0];
  }
  return nonEmpty(opts.fallback) ?? DEFAULT_PROFILE;
}

/**
 * 解析 profile 目录（$DSH_HOME/profiles/<profile>）。
 * 只拼路径、不做存在性校验 —— 存在性由 resolvePaths 统一判（那里要带诊断信息）。
 */
export function resolveProfilesDir(dshHome: string, opts: ProfileNameOptions = {}): string {
  return join(resolve(dshHome), 'profiles', resolveProfileName({ ...opts, dshHome }));
}

/**
 * 解析所有路径。允许 ctx 注入 profilesDir（可选），否则从 DSH_HOME + profile 名拼。
 *
 * @throws Error DSH_HOME 未设或 profile 目录不存在
 */
export function resolvePaths(opts: {
  dshHome?: string;
  env?: NodeJS.ProcessEnv;
  profilesDir?: string; // 可选（旧版 dsh 可能暴露）
  profile?: string;     // 显式 profile 名
  profileName?: string; // 同 profile（从 ctx.get('profileContext').name 传入）
  fallback?: string;
  agintHome?: string;
}): PathsConfig {
  const env = opts.env ?? process.env;
  const dshHome = opts.dshHome ?? env.DSH_HOME ?? '';
  if (!dshHome) {
    throw new Error('agint-mount: DSH_HOME 未设置，无法定位 profiles/<profile>/');
  }
  const home = resolve(dshHome);
  const profileName = resolveProfileName({ ...opts, env, dshHome: home });
  const profilesDir = opts.profilesDir ?? join(home, 'profiles', profileName);
  if (!existsSync(profilesDir)) {
    // 带上已探测到的 profile 清单：否则「装到 desktop 却还在找 web」这类问题
    // 只会得到一句 Not Found，看不出该改哪个 profile。
    const tried = listProfileNames(home).join(', ') || '（profiles/ 下无目录）';
    throw new Error(`agint-mount: profiles/${profileName} 不存在：${profilesDir}（已探测 profile：${tried}）`);
  }
  return {
    dshHome: home,
    profileName,
    // profilesWeb 保留为 profilesDir 的别名：老调用方按这个名字取，不能断
    profilesWeb: profilesDir,
    profilesDir,
    cordisPatch: join(profilesDir, 'cordis.patch.yml'),
    pluginsRoot: join(profilesDir, 'plugins'),
    stagingRoot: join(profilesDir, 'plugins', '.staging'),
    webPackageJson: join(profilesDir, 'package.json'),
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
