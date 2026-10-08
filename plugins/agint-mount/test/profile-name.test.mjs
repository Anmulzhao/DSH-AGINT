#!/usr/bin/env node
/**
 * agint-mount — profile 名解析单测（2026-10-08，desktop 适配）
 *
 * 为什么必须有这个文件：
 *   profile 名写死 'web' 时，装到 desktop 的表现是「服务起来、路径指错、零报错」——
 *   本次改造的所有层次都在跟静默降级作战。所以每条断言都要配 **negative control**：
 *   故意破坏某一层，结果**必须**变化；不变说明那一层根本没接上（假防线）。
 *
 * 覆盖：
 *   1) 优先级链六层逐层生效
 *   2) 每一层的 negative control（拿掉该层后结果必须变）
 *   3) detectAgintProfiles 的 0 / 1 / 多命中语义（多命中不猜）
 *   4) resolvePaths 用非 web profile 能通过存在性检查
 *   5) resolvePaths 失败信息带已探测的 profile 清单（可诊断）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  resolveProfileName,
  resolveProfilesDir,
  resolvePaths,
  detectAgintProfiles,
  listProfileNames,
  readInstalledProfile,
} from '../lib/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 建一个最小 DSH_HOME：profiles/<...>/plugins 下放 agint-* 目录 */
function makeHome(spec = {}) {
  const home = join(tmpdir(), `agint-profile-test-${randomUUID()}`);
  const profiles = spec.profiles ?? ['web'];       // 每个 profile 是否含 agint- 插件
  const withPlugins = spec.withPlugins ?? profiles; // 默认每个 profile 都放
  mkdirSync(home, { recursive: true });
  for (const p of profiles) {
    mkdirSync(join(home, 'profiles', p), { recursive: true });
    if (withPlugins.includes(p)) {
      mkdirSync(join(home, 'profiles', p, 'plugins', 'agint-memory'), { recursive: true });
    } else {
      mkdirSync(join(home, 'profiles', p, 'plugins'), { recursive: true });
    }
  }
  if (spec.fact) {
    mkdirSync(join(home, '.agint-bundle'), { recursive: true });
    writeFileSync(
      join(home, '.agint-bundle', 'profile.json'),
      JSON.stringify({ profile: spec.fact, updatedAt: '2026-10-08T00:00:00+00:00' }),
    );
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

// ── 1) 优先级链 ────────────────────────────────────────────────────────────
test('① 显式 profile 优先于一切', () => {
  const h = home({ profiles: ['web', 'desktop'], fact: 'desktop' });
  assert.equal(
    resolveProfileName({ dshHome: h, profile: 'ops', env: { DSH_PROFILE: 'desktop' } }),
    'ops',
  );
});

test('② env.DSH_PROFILE 优先于安装事实文件', () => {
  const h = home({ profiles: ['web', 'desktop'], fact: 'desktop' });
  assert.equal(resolveProfileName({ dshHome: h, env: { DSH_PROFILE: 'desktop' } }), 'desktop');
  // negative control：拿掉 DSH_PROFILE，结果必须换成事实文件给的 desktop…
  // （这里两者相同，改用不同值才能验出层级差异）
  const h2 = home({ profiles: ['web', 'desktop'], fact: 'web' });
  assert.equal(resolveProfileName({ dshHome: h2, env: { DSH_PROFILE: 'desktop' } }), 'desktop');
  assert.equal(resolveProfileName({ dshHome: h2, env: {} }), 'web', '无 DSH_PROFILE 时应落到安装事实');
});

test('③ env.DSH_PROFILE_DIR 取 basename', () => {
  const h = home({ profiles: ['web'] });
  assert.equal(
    resolveProfileName({ dshHome: h, env: { DSH_PROFILE_DIR: `${h}/profiles/desktop` } }),
    'desktop',
  );
});

test('④ 安装事实文件优先于目录探测', () => {
  // desktop 是唯一装了 agint-* 的 profile；事实文件却写 ops ⇒ 事实文件赢
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'], fact: 'ops' });
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'ops');
});

test('⑤ 唯一命中时目录探测生效', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'] });
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'desktop');
});

test('⑥ 全落空回落 web', () => {
  const h = home({ profiles: [] });
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'web');
  // fallback 可覆盖
  assert.equal(resolveProfileName({ dshHome: h, env: {}, fallback: 'desktop' }), 'desktop');
});

// ── 2) negative control：每层拿掉后结果必须变 ───────────────────────────────
test('negative: 删掉安装事实文件 ⇒ 结果从 desktop 变成探测/回落值', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'], fact: 'desktop' });
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'desktop');
  rmSync(join(h, '.agint-bundle'), { recursive: true, force: true });
  // 探测层仍唯一命中 desktop ⇒ 还是 desktop（证明探测层真的接上了）
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'desktop');
  // 再把探测层打掉（让 web 也装 agint-* ⇒ 多命中不猜）⇒ 必须回落 web
  mkdirSync(join(h, 'profiles', 'web', 'plugins', 'agint-memory'), { recursive: true });
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'web', '多命中不猜，应回落 web');
});

test('negative: 事实文件写坏（非 JSON）⇒ 不抛，继续回落', () => {
  const h = home({ profiles: ['web'], withPlugins: ['web'] });
  mkdirSync(join(h, '.agint-bundle'), { recursive: true });
  writeFileSync(join(h, '.agint-bundle', 'profile.json'), '{ this is not json');
  assert.equal(readInstalledProfile(h), null);
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'web');
});

// ── 3) detectAgintProfiles 语义 ────────────────────────────────────────────
test('detectAgintProfiles：0 命中', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: [] });
  assert.deepEqual(detectAgintProfiles(h), []);
});

test('detectAgintProfiles：多命中全部返回（由调用方决定不猜）', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['web', 'desktop'] });
  assert.deepEqual(detectAgintProfiles(h), ['desktop', 'web']);
  assert.equal(resolveProfileName({ dshHome: h, env: {} }), 'web', '多命中 ⇒ 不猜 ⇒ 回落 web');
});

test('detectAgintProfiles：profiles/ 不存在时不抛，返回空', () => {
  const h = join(tmpdir(), `agint-profile-test-${randomUUID()}`);
  mkdirSync(h, { recursive: true });
  cleanups.push(h);
  assert.deepEqual(detectAgintProfiles(h), []);
  assert.deepEqual(listProfileNames(h), []);
});

// ── 4) resolvePaths 用非 web profile ───────────────────────────────────────
test('resolvePaths：装到 desktop 时能解析出 desktop 的路径', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'], fact: 'desktop' });
  const paths = resolvePaths({ dshHome: h, env: {} });
  assert.equal(paths.profileName, 'desktop');
  assert.equal(paths.profilesDir, join(resolve(h), 'profiles', 'desktop'));
  // 兼容别名不能断：老调用方按 profilesWeb 取
  assert.equal(paths.profilesWeb, paths.profilesDir);
  assert.equal(paths.pluginsRoot, join(resolve(h), 'profiles', 'desktop', 'plugins'));
});

test('resolvePaths：opts.profilesDir 仍然最高优先（旧版 dsh 注入）', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'] });
  const injected = join(resolve(h), 'profiles', 'desktop');
  const paths = resolvePaths({ dshHome: h, env: {}, profilesDir: injected });
  assert.equal(paths.profilesDir, injected);
  assert.equal(paths.profileName, 'desktop');
});

test('resolvePaths：失败信息带已探测的 profile 清单（可诊断）', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: [] });
  assert.throws(
    () => resolvePaths({ dshHome: h, env: {}, profile: 'ghost' }),
    (err) => {
      assert.match(err.message, /profiles\/ghost 不存在/);
      assert.match(err.message, /已探测 profile：desktop, web/, '错误信息必须列出可选项');
      return true;
    },
  );
});

test('resolvePaths：DSH_HOME 未设时抛错', () => {
  assert.throws(() => resolvePaths({ dshHome: '', env: {} }), /DSH_HOME 未设置/);
});

// ── 5) resolveProfilesDir ──────────────────────────────────────────────────
test('resolveProfilesDir 拼出目标 profile 目录', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'] });
  assert.equal(resolveProfilesDir(h, { env: {} }), join(resolve(h), 'profiles', 'desktop'));
  assert.equal(resolveProfilesDir(h, { env: {}, profile: 'ops' }), join(resolve(h), 'profiles', 'ops'));
});
