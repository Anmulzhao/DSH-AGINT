#!/usr/bin/env node
/**
 * agint-family-panel — resolveV2Dirs 的 profile 参数化单测（2026-10-08，desktop 适配）
 *
 * 背景：v2-data.js 原本把 pluginsDir 写死成 $DSH_HOME/profiles/web/plugins。
 * 装到 desktop 而不改 ⇒ 面板所有源读错目录 ⇒ 整体 state:error（**零报错**）。
 *
 * 本文件同时验证两种取 profile 的方式：
 *   ① 调用方从 ctx.get('profileContext').name 传入（第 4 参）
 *   ② 不传时靠安装事实文件 / 目录探测自行解析
 * 并配 negative control：拿掉任一层，结果必须变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { resolveV2Dirs } from '../lib/v2-data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeHome({ profiles = ['web'], withPlugins = [], fact = null } = {}) {
  const home = join(tmpdir(), `agint-fp-profile-${randomUUID()}`);
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

test('① 调用方传 profileName=desktop ⇒ pluginsDir 指向 desktop/plugins', () => {
  const h = home({ profiles: ['web', 'desktop'] });
  const dirs = resolveV2Dirs({ DSH_HOME: h }, import.meta.url, null, 'desktop');
  assert.equal(dirs.pluginsDir, join(resolve(h), 'profiles', 'desktop', 'plugins'));
});

test('② 不传时靠安装事实文件解析到 desktop', () => {
  const h = home({ profiles: ['web', 'desktop'], fact: 'desktop' });
  const dirs = resolveV2Dirs({ DSH_HOME: h }, import.meta.url, null, null);
  assert.equal(dirs.pluginsDir, join(resolve(h), 'profiles', 'desktop', 'plugins'));
});

test('③ 无事实文件时靠目录探测（唯一命中）', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['desktop'] });
  const dirs = resolveV2Dirs({ DSH_HOME: h }, import.meta.url, null, null);
  assert.equal(dirs.pluginsDir, join(resolve(h), 'profiles', 'desktop', 'plugins'));
});

test('④ 全落空回落 web（保持旧行为，不 regression）', () => {
  const h = home({ profiles: ['web', 'desktop'] });
  const dirs = resolveV2Dirs({ DSH_HOME: h }, import.meta.url, null, null);
  assert.equal(dirs.pluginsDir, join(resolve(h), 'profiles', 'web', 'plugins'));
});

test('negative: 显式传 web 时不该被事实文件改成 desktop', () => {
  const h = home({ profiles: ['web', 'desktop'], fact: 'desktop' });
  const dirs = resolveV2Dirs({ DSH_HOME: h }, import.meta.url, null, 'web');
  assert.equal(dirs.pluginsDir, join(resolve(h), 'profiles', 'web', 'plugins'));
});

test('negative: 拿掉事实文件且探测多命中 ⇒ 回落 web（不猜）', () => {
  const h = home({ profiles: ['web', 'desktop'], withPlugins: ['web', 'desktop'], fact: 'desktop' });
  assert.equal(resolveV2Dirs({ DSH_HOME: h }, import.meta.url, null, null).pluginsDir,
    join(resolve(h), 'profiles', 'desktop', 'plugins'));
  rmSync(join(h, '.agint-bundle'), { recursive: true, force: true });
  assert.equal(resolveV2Dirs({ DSH_HOME: h }, import.meta.url, null, null).pluginsDir,
    join(resolve(h), 'profiles', 'web', 'plugins'), '多命中不猜，应回落 web');
});

test('无 DSH_HOME 时仍走自身路径兜底，不因本次改动崩', () => {
  const dirs = resolveV2Dirs({}, import.meta.url, null, 'desktop');
  assert.equal(typeof dirs.pluginsDir, 'string');
  assert.ok(dirs.pluginsDir.length > 0);
});
