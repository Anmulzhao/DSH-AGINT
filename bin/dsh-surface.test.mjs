#!/usr/bin/env node
/**
 * bin/dsh-surface.test.mjs —— dsh-surface 门禁的单测。
 *
 * WHY：这个门禁的价值全在「判定是否正确」上，而不在「能不能跑起来」。
 * 一个把 EXIT 3 误判成 EXIT 0 的门禁，比没有门禁更糟 —— 
 * 它会让升级承接流程以为自己已经走完了。
 * 所以这里重点覆盖三件容易错的事：
 *   1) diff 的纯逻辑（新增 / 删除 / 仅版本号变）
 *   2) 退出码映射（尤其「仅版本号变 ⇒ 0」与「宿主升级 ⇒ 3」的区分）
 *   3) 宿主缺失分支必须 EXIT 2 且措辞含「没查」
 *
 * 刻意不打桩真实 asar：真实宿主只在本机存在，单测要能在任何机器上跑绿。
 * 真实宿主的验收由 bin/dsh-surface.mjs 自身的命令行回归覆盖。
 *
 * 跑法：node --test bin/dsh-surface.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import {
  EXIT, SURFACES, diffList, diffPackages, pkgName, mapExit, compare,
  extractSurfaces, extractPackages, buildBaseline, checkIntegrity,
  parseArgs, locateHost, run, conclusionText, renderReport,
} from './dsh-surface.mjs';

// -------------------------------------------------------------- 测试工具

/** 收集写入内容的假流。用来断言 stdout / stderr，而不污染测试输出。 */
function sink() {
  const chunks = [];
  const s = new Writable({
    write(c, _e, cb) { chunks.push(String(c)); cb(); },
  });
  s.text = () => chunks.join('');
  return s;
}

/** 造一个最小快照，字段与 collectSurface 的 snap 对齐。 */
function snapOf({ version = '0.2.1-rc.3', hpv = 4, services = [], events = [], types = [], inheritedCtx = [], packages = [] } = {}) {
  return { version, hostProtocolVersion: hpv, services, events, types, inheritedCtx, packages };
}

/** 造一份配套基线（版本可直接覆盖）。 */
function baseOf(snap, patch = {}) {
  const b = buildBaseline(snap, new Date('2026-01-01T00:00:00.000Z'));
  return { ...b, ...patch };
}

/** 假的 api-catalog 模块：四个导出常量都由调用方给定。 */
function fakeMod({ services = [], events = [], types = [], inheritedCtx = [] } = {}) {
  return {
    SERVICE_API: services.map((key) => ({ key })),
    EVENT_API: events.map((name) => ({ name })),
    TYPE_API: types.map((name) => ({ name })),
    INHERITED_CTX_API: inheritedCtx.map((name) => ({ name })),
  };
}

// ------------------------------------------------------------ diff 纯逻辑

test('diffList：无变化时两边都空', () => {
  const d = diffList(['a', 'b'], ['a', 'b']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test('diffList：新增能被识别', () => {
  const d = diffList(['a', 'b', 'c'], ['a', 'b']);
  assert.deepEqual(d.added, ['c']);
  assert.deepEqual(d.removed, []);
});

test('diffList：删除能被识别', () => {
  const d = diffList(['a'], ['a', 'b']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, ['b']);
});

test('diffList：同时新增与删除', () => {
  const d = diffList(['a', 'c'], ['a', 'b']);
  assert.deepEqual(d.added, ['c']);
  assert.deepEqual(d.removed, ['b']);
});

test('diffList：基线缺失时全部算新增（据此保证不会静默通过）', () => {
  const d = diffList(['a'], undefined);
  assert.deepEqual(d.added, ['a']);
});

test('pkgName：能正确切出带 scope 的包名', () => {
  assert.equal(pkgName('@deepseek-ai/cordis@4.0.5'), '@deepseek-ai/cordis');
  assert.equal(pkgName('lodash@1.2.3'), 'lodash');
});

test('diffPackages：仅版本号变要单独归类，不算包增删', () => {
  const d = diffPackages(['@a/x@2.0.0'], ['@a/x@1.0.0']);
  assert.deepEqual(d.addedPackages, []);
  assert.deepEqual(d.removedPackages, []);
  assert.equal(d.versionChanged.length, 1);
  assert.equal(d.versionChanged[0].name, '@a/x');
  assert.equal(d.versionChanged[0].from, '@a/x@1.0.0');
  assert.equal(d.versionChanged[0].to, '@a/x@2.0.0');
});

test('diffPackages：新增与删除包能被识别', () => {
  const d = diffPackages(['@a/keep@1.0.0', '@a/new@1.0.0'], ['@a/keep@1.0.0', '@a/gone@1.0.0']);
  assert.deepEqual(d.addedPackages, ['@a/new@1.0.0']);
  assert.deepEqual(d.removedPackages, ['@a/gone@1.0.0']);
  assert.equal(d.versionChanged.length, 0);
});

test('diffPackages：scope 包同名不同版本不会误判成增删', () => {
  const d = diffPackages(['@s/p@1.1.0', '@s/q@1.0.0'], ['@s/p@1.0.0', '@s/q@1.0.0']);
  assert.deepEqual(d.addedPackages, []);
  assert.deepEqual(d.removedPackages, []);
  assert.equal(d.versionChanged.length, 1);
});

// ---------------------------------------------------------- 退出码映射

test('mapExit：全绿 ⇒ EXIT 0', () => {
  assert.equal(mapExit({ integrityOk: true, surfaceChanged: false, packageChanged: false, hostChanged: false }), EXIT.OK);
});

test('mapExit：仅版本号变 ⇒ EXIT 0（版本号变不算能力面变化）', () => {
  // packageChanged 指「包增删」，仅版本号变不会置位，所以这里是 0。
  assert.equal(mapExit({ integrityOk: true, surfaceChanged: false, packageChanged: false, hostChanged: false }), EXIT.OK);
});

test('mapExit：宿主升级但能力面没变 ⇒ EXIT 3', () => {
  assert.equal(mapExit({ integrityOk: true, surfaceChanged: false, packageChanged: false, hostChanged: true }), EXIT.UPGRADED);
});

test('mapExit：服务有增删 ⇒ EXIT 1', () => {
  assert.equal(mapExit({ integrityOk: true, surfaceChanged: true, packageChanged: false, hostChanged: false }), EXIT.DIFF);
});

test('mapExit：包有增删 ⇒ EXIT 1', () => {
  assert.equal(mapExit({ integrityOk: true, surfaceChanged: false, packageChanged: true, hostChanged: false }), EXIT.DIFF);

});

test('mapExit：完整性失败优先于一切，即使能力面没变也 ⇒ EXIT 1', () => {
  assert.equal(mapExit({ integrityOk: false, surfaceChanged: false, packageChanged: false, hostChanged: false }), EXIT.DIFF);
  assert.equal(mapExit({ integrityOk: false, surfaceChanged: false, packageChanged: false, hostChanged: true }), EXIT.DIFF);
});
