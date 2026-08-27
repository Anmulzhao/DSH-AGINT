/**
 * lib/profile-resolver.js — Sprint 10 v0.6.3 #3
 *
 * 把 lib/index.js 的 resolveProfile() 抽出来形成独立模块。
 * 职责：
 *   1. 按 process.platform 路由到对应 profile 文件
 *   2. 解析 JSON / SBPL 字符串为结构化对象
 *   3. 探测底层 syscall 限制可用性（seccomp / sandbox-exec）
 *   4. 返回 ResolvedProfile 给 runVerify/runExplore 透传给 ctx.sandbox.confine
 *
 * L0-frozen 保护（设计稿 §七）：
 *   - 不引用 quality-contract FROZEN 接口
 *   - 不引入新的中心化服务
 *   - 不修改 runSmoke / runVerify / runExplore / routeForMutation 任何签名
 *
 * 行数预算（设计稿 §十.1）：≤120 行（含注释）
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROFILE_DIR = resolve(__dirname, '../profiles');

/**
 * 解析 BPF JSON profile 为 dsh sandbox 期望的格式
 */
export function resolveBpfProfile(mode) {
  const file = resolve(PROFILE_DIR, `sandbox-seccomp-${mode}.json`);
  if (!existsSync(file)) {
    return { unsupported: true, platform: 'linux', mode, reason: `profile file missing: ${file}`, recommended: 'in-process-fallback' };
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (raw.defaultAction !== 'SCMP_ACT_KILL_PROCESS') {
    return { unsupported: true, platform: 'linux', mode, reason: 'defaultAction must be SCMP_ACT_KILL_PROCESS', recommended: 'in-process-fallback' };
  }
  if (!Array.isArray(raw.syscallAllow) || raw.syscallAllow.length === 0) {
    return { unsupported: true, platform: 'linux', mode, reason: 'syscallAllow missing or empty', recommended: 'in-process-fallback' };
  }
  return {
    platform: 'linux',
    mode,
    format: 'bpf-json',
    content: readFileSync(file, 'utf8'),
    defaultAction: raw.defaultAction,
    syscallAllow: raw.syscallAllow,
    syscallDeny: raw.syscallDeny ?? [],
    execveAllowlist: raw.execveAllowlist ?? [],
    execveDeny: raw.execveDeny ?? [],
    arch: raw.arch ?? [],
    _meta: raw._meta,
  };
}

/**
 * 解析 SBPL profile 为 dsh sandbox 期望的格式
 */
export function resolveSbplProfile(mode) {
  const file = resolve(PROFILE_DIR, `sandbox-sbpl-${mode}.sb`);
  if (!existsSync(file)) {
    return { unsupported: true, platform: 'darwin', mode, reason: `profile file missing: ${file}`, recommended: 'in-process-fallback' };
  }
  const content = readFileSync(file, 'utf8');
  if (!content.includes('(deny default)')) {
    return { unsupported: true, platform: 'darwin', mode, reason: 'SBPL must contain (deny default)', recommended: 'in-process-fallback' };
  }
  if (!content.includes('(deny network*)')) {
    return { unsupported: true, platform: 'darwin', mode, reason: 'SBPL must deny network*', recommended: 'in-process-fallback' };
  }
  return {
    platform: 'darwin',
    mode,
    format: 'sbpl',
    content,
    _meta: extractSbplMeta(content),
  };
}

/**
 * 顶层路由：按 process.platform 返回对应 profile
 */
export function resolveProfile(mode) {
  if (!['verify', 'explore'].includes(mode)) {
    throw new Error(`resolveProfile: unknown mode '${mode}' (expect verify|explore)`);
  }
  const platform = process.platform;
  if (platform === 'linux') return resolveBpfProfile(mode);
  if (platform === 'darwin') return resolveSbplProfile(mode);
  return { unsupported: true, platform, mode, reason: 'no-seccomp-on-this-platform', recommended: 'in-process-fallback' };
}

/**
 * 探测本机 syscall 限制能力（用于 backendHealth）
 */
export function probeSyscallCapability() {
  return {
    seccompAvailable: process.platform === 'linux' && !resolveBpfProfile('verify').unsupported,
    sbplAvailable: process.platform === 'darwin' && !resolveSbplProfile('verify').unsupported,
  };
}

function extractSbplMeta(content) {
  const m = content.match(/\(_meta([\s\S]*?)\)/);
  if (!m) return {};
  const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean);
  const meta = {};
  for (const line of lines) {
    const kv = line.match(/^\((\S+)\s+"([^"]*)"\)$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return meta;
}