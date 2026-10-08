#!/usr/bin/env node
/**
 * agint-dream — profile 名解析单测 + 与 agint-mount 的口径一致性（2026-10-08）
 *
 * 为什么不是直接 import agint-mount 的 resolveProfileName：
 *   quality-bridge.js 的 v0.2 纪律写明「跨 plugin 边界 import 会绑死版本号」。
 *   于是 dream 内联了一份**同口径**实现。内联 = 有漂移风险，所以本文件除了测
 *   dream 自己的行为，还要**逐层比对 mount 的结果**，让漂移在 CI 里变红。
 *
 * ⚠️ 比对范围：dream 版刻意少了「profiles/<任意名>/plugins 目录探测」一层
 *   （见 resolveDreamProfileName 注释）。所以比对时 fixture 必须让该层不参与
 *   —— 否则两边结果不同是**设计如此**，不是 bug。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { resolveDreamProfileName, readInstalledProfile, resolveTargetPath } from '../lib/quality-bridge.js';
import { resolveProfileName } from '../../agint-mount/lib/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeHome({ profiles = ['web'], withPlugins = [], fact = null } = {}) {
  const home = join(tmpdir(), `agint-dream-profile-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  for (const p of profiles) {
    mkdirSync(join(home, 'profiles', p, 'plugins'), { recursive: true });
    if (withPlugins.includes(p)) {
      mkdirSync(join(home, 'profiles', p, 'plugins', 'agint-memory'), { recursive: true });
    }
  }
  if (fact) {
    mkdirSync(join(home, '.agint-bundle'), { recursive: true });
    writeFileSync(join(home, '.agint-bundle', 'profile.json'), JSON.stringify({ profile: fact }));
  }
  return home;
}

const cleanups = [];
function home(spec) {
  const h = makeHome(spec);
  cleanups.push(h);
  return h;
}
test.after(() => {
  for (const h of cleanups) rmSync(h, { recursive: true, force: true });
});

// ── dream 自己的行为 ───────────────────────────────────────────────────────
test('① 显式 profile 最优先', () => {
  const h = home({ fact: 'desktop' });
  assert.equal(resolveDreamProfileName({ dshHome: h, env: {}, profile: 'ops' }), 'ops');
});

test('② env.DSH_PROFILE 生效', () => {
  const h = home({ fact: 'web' });
  assert.equal(resolveDreamProfileName({ dshHome: h, env: { DSH_PROFILE: 'desktop' } }), 'desktop');
});

test('③ env.DSH_PROFILE_DIR 取 basename', () => {
  const h = home({});
  assert.equal(resolveDreamProfileName({ dshHome: h, env: { DSH_PROFILE_DIR: `${h}/profiles/desktop` } }), 'desktop');
});

test('④ 安装事实文件生效（dream 无 ctx 时的主兜底）', () => {
  const h = home({ fact: 'desktop' });
  assert.equal(resolveDreamProfileName({ dshHome: h, env: {} }), 'desktop');
});

test('⑤ 全落空回落 web', () => {
  const h = home({});
  assert.equal(resolveDreamProfileName({ dshHome: h, env: {} }), 'web');
});

test('negative: 事实文件拿掉 ⇒ 必须回落 web（证明真的读了它）', () => {
  const h = home({ fact: 'desktop' });
  assert.equal(resolveDreamProfileName({ dshHome: h, env: {} }), 'desktop');
  rmSync(join(h, '.agint-bundle'), { recursive: true, force: true });
  assert.equal(resolveDreamProfileName({ dshHome: h, env: {} }), 'web');
});

test('readInstalledProfile：缺失 / 坏 JSON / 缺字段 都返回 null 不抛', () => {
  const h = home({});
  assert.equal(readInstalledProfile(h), null);
  mkdirSync(join(h, '.agint-bundle'), { recursive: true });
  writeFileSync(join(h, '.agint-bundle', 'profile.json'), 'not json');
  assert.equal(readInstalledProfile(h), null);
  writeFileSync(join(h, '.agint-bundle', 'profile.json'), JSON.stringify({ profile: '  ' }));
  assert.equal(readInstalledProfile(h), null);
});

// ── 与 mount 的口径一致性（fixture 排除目录探测层：两个 profile 都不放 agint-*）──
test('parity: 各层与 agint-mount 的 resolveProfileName 结果一致', () => {
  const cases = [
    { label: '显式', opts: { profile: 'desktop' }, env: {} },
    { label: 'DSH_PROFILE', opts: {}, env: { DSH_PROFILE: 'desktop' } },
    { label: '事实文件', opts: {}, env: {} },
    { label: '全落空', opts: {}, env: {} },
  ];
  for (const c of cases) {
    // 带事实文件 / 不带事实文件各测一遍
    for (const fact of ['desktop', null]) {
      const h = home({ profiles: ['web', 'ops'], fact });
      const a = resolveDreamProfileName({ dshHome: h, env: c.env, ...c.opts });
      const b = resolveProfileName({ dshHome: h, env: c.env, ...c.opts });
      assert.equal(a, b, `${c.label} / fact=${fact}：dream=${a} 与 mount=${b} 不一致`);
    }
  }
});

// ── resolveTargetPath 真的落到目标 profile ─────────────────────────────────
test('resolveTargetPath：装到 desktop 时 host 副本走 desktop/plugins', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'], fact: 'desktop' });
  const got = resolveTargetPath({ id: 'agint-memory', kind: 'plugin' }, { DSH_HOME: h });
  assert.equal(got, join(resolve(h), 'profiles', 'desktop', 'plugins', 'agint-memory'));
});

test('resolveTargetPath：desktop 没有该插件时回落到 AGINT_HOME 仓路径', () => {
  const h = home({ profiles: ['desktop'], withPlugins: [], fact: 'desktop' });
  const repo = join(tmpdir(), `agint-dream-repo-${randomUUID()}`);
  mkdirSync(join(repo, 'plugins', 'agint-memory'), { recursive: true });
  cleanups.push(repo);
  const got = resolveTargetPath({ id: 'agint-memory', kind: 'plugin' }, { DSH_HOME: h, AGINT_HOME: repo });
  assert.equal(got, join(resolve(repo), 'plugins', 'agint-memory'));
});

test('resolveTargetPath：id 非法时返回 null', () => {
  assert.equal(resolveTargetPath(null, {}), null);
  assert.equal(resolveTargetPath({ id: '', kind: 'plugin' }, {}), null);
});
