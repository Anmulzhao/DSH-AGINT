/**
 * profile-resolver.test.mjs — Sprint 10 v0.6.3 #3
 *
 * 测试范围：
 *   1. resolveBpfProfile('verify'/'explore') 字段契约
 *   2. resolveBpfProfile('bogus') 抛错
 *   3. resolveSbplProfile('verify'/'explore') 字段契约
 *   4. probeSyscallCapability() 返回 {seccompAvailable, sbplAvailable}
 *   5. 降级路径：profile 文件 missing → unsupported.reason 含 "profile file missing"
 *   6. 校验路径：defaultAction !== SCMP_ACT_KILL_PROCESS → unsupported.reason 含 "defaultAction must be"
 *
 * L0-frozen 保护：本测试**不引用** quality-contract 任何符号。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVER_PATH = resolve(__dirname, '../lib/profile-resolver.js');
const PROFILES_DIR = resolve(__dirname, '../profiles');

// 用文件级导入避免重复 module 实例化（resolver 内部只读 PROFILE_DIR 一次，
// 后续改动通过文件改动影响其读到的内容）
const resolver = await import(RESOLVER_PATH);

// ── Case 1: resolveBpfProfile('verify') 形状契约 ─────────────────────────────
test('resolveBpfProfile(verify): linux + defaultAction + non-empty syscallAllow', () => {
  const r = resolver.resolveBpfProfile('verify');
  assert.equal(r.unsupported, undefined, 'verify profile should be supported');
  assert.equal(r.platform, 'linux');
  assert.equal(r.mode, 'verify');
  assert.equal(r.defaultAction, 'SCMP_ACT_KILL_PROCESS');
  assert.equal(r.format, 'bpf-json');
  assert.ok(Array.isArray(r.syscallAllow), 'syscallAllow should be an array');
  assert.ok(r.syscallAllow.length > 0, 'syscallAllow should be non-empty');
});

// ── Case 2: resolveBpfProfile('explore') 含 execveAllowlist ───────────────────
test('resolveBpfProfile(explore): execveAllowlist non-empty + node/git included', () => {
  const r = resolver.resolveBpfProfile('explore');
  assert.equal(r.unsupported, undefined, 'explore profile should be supported');
  assert.equal(r.mode, 'explore');
  assert.ok(Array.isArray(r.execveAllowlist), 'execveAllowlist should be array');
  assert.ok(r.execveAllowlist.length > 0, 'execveAllowlist should be non-empty');
  // 限 node/git（探索模式白名单：可执行 node + git）
  assert.ok(r.execveAllowlist.some(p => p.includes('node')), 'should allow /usr/bin/node');
  assert.ok(r.execveAllowlist.some(p => p.includes('git')), 'should allow /usr/bin/git');
});

// ── Case 3: resolveBpfProfile('bogus') 返回 unsupported（无对应文件） ────────
test('resolveBpfProfile(bogus): returns unsupported with missing-file reason', () => {
  // resolveBpfProfile 不抛错（仅文件检查）；unknown mode 的抛错发生在 resolveProfile 顶层路由
  const r = resolver.resolveBpfProfile('bogus');
  assert.equal(r.unsupported, true, 'unknown mode → unsupported');
  assert.match(r.reason, /profile file missing/, 'reason should explain missing');
});

test('resolveProfile(bogus): throws unknown mode (顶层路由守门)', () => {
  assert.throws(() => resolver.resolveProfile('bogus'), /unknown mode/);
});

// ── Case 4: resolveSbplProfile('verify') 形状契约 ─────────────────────────────
test('resolveSbplProfile(verify): darwin + (deny default) + (deny network*)', () => {
  const r = resolver.resolveSbplProfile('verify');
  assert.equal(r.unsupported, undefined, 'verify SBPL should be supported');
  assert.equal(r.platform, 'darwin');
  assert.equal(r.mode, 'verify');
  assert.equal(r.format, 'sbpl');
  assert.match(r.content, /\(deny default\)/, 'must contain (deny default)');
  assert.match(r.content, /\(deny network\*\)/, 'must contain (deny network*)');
});

// ── Case 5: resolveSbplProfile('explore') 含 execve + node 白名单 ─────────────
test('resolveSbplProfile(explore): contains (allow syscall-execve) + node path-argument', () => {
  const r = resolver.resolveSbplProfile('explore');
  assert.equal(r.unsupported, undefined, 'explore SBPL should be supported');
  assert.equal(r.mode, 'explore');
  assert.match(r.content, /\(allow syscall-execve\)/, 'must allow syscall-execve');
  assert.match(r.content, /\(allow process-exec[\s\S]*?\(path-argument\s+"\/usr\/bin\/node"\)/,
    'must allow process-exec for /usr/bin/node');
});

// ── Case 6: probeSyscallCapability() 形状契约 ─────────────────────────────────
test('probeSyscallCapability: returns {seccompAvailable, sbplAvailable} booleans', () => {
  const c = resolver.probeSyscallCapability();
  assert.equal(typeof c, 'object');
  assert.equal(typeof c.seccompAvailable, 'boolean');
  assert.equal(typeof c.sbplAvailable, 'boolean');
  // platform 逻辑互斥
  if (process.platform === 'linux') {
    assert.equal(c.seccompAvailable, true, 'linux + verify profile ok → true');
    assert.equal(c.sbplAvailable, false, 'linux → sbpl false');
  } else if (process.platform === 'darwin') {
    assert.equal(c.sbplAvailable, true, 'darwin + verify SBPL ok → true');
    assert.equal(c.seccompAvailable, false, 'darwin → seccomp false');
  }
});

// ── Case 7: 降级路径 — profile 文件 missing ───────────────────────────────────
test('resolveBpfProfile: returns unsupported=true when profile file missing', () => {
  const target = resolve(PROFILES_DIR, 'sandbox-seccomp-verify.json');
  const backup = `${target}.tmp-backup-${process.pid}`;
  // 备份原文件
  writeFileSync(backup, readFileSync(target, 'utf8'), 'utf8');
  // 删除
  rmSync(target);
  try {
    const r = resolver.resolveBpfProfile('verify');
    assert.equal(r.unsupported, true, 'should be unsupported when file missing');
    assert.match(r.reason, /profile file missing/, 'reason should explain missing');
    assert.equal(r.recommended, 'in-process-fallback');
    assert.equal(r.platform, 'linux');
  } finally {
    // 恢复
    writeFileSync(target, readFileSync(backup, 'utf8'), 'utf8');
    rmSync(backup);
  }
});

// ── Case 8: 校验路径 — defaultAction 不是 SCMP_ACT_KILL_PROCESS ────────────────
test('resolveBpfProfile: returns unsupported=true when defaultAction invalid', () => {
  const target = resolve(PROFILES_DIR, 'sandbox-seccomp-verify.json');
  const backup = `${target}.tmp-backup-${process.pid}-v`;
  const original = readFileSync(target, 'utf8');
  writeFileSync(backup, original, 'utf8');

  // 把 defaultAction 改成非法值
  const bad = JSON.parse(original);
  bad.defaultAction = 'SCMP_ACT_ERRNO';  // 不是 SCMP_ACT_KILL_PROCESS
  writeFileSync(target, JSON.stringify(bad, null, 2), 'utf8');

  try {
    const r = resolver.resolveBpfProfile('verify');
    assert.equal(r.unsupported, true, 'should be unsupported when defaultAction invalid');
    assert.match(r.reason, /defaultAction must be/, 'reason should mention defaultAction');
    assert.equal(r.recommended, 'in-process-fallback');
  } finally {
    writeFileSync(target, original, 'utf8');
    rmSync(backup);
  }
});