/**
 * test/synth-l0-loop.test.mjs — B3：合成产物真喂 quality-static l0-isolation
 *
 * 这是**跨插件真跑**，不是结构断言。产物落盘到临时目录，直接调
 * agint-quality-static 的 checkL0Isolation，看三条子检查的真实判定。
 *
 * 钉两件事：
 *   1. 合规产物 ⇒ 0 blocker（门禁不误伤）
 *   2. 三条子检查各自都能真拦（门禁不形同虚设）
 *
 * 每条负控都指向一个真实违规场景，改坏产物后必须变红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const u = (p) => pathToFileURL(p).href;

const { synthPluginPackage } = await import(u(path.join(ROOT, 'plugins/agint-mutator/lib/synth.js')));
const { checkL0Isolation } = await import(u(path.join(ROOT, 'plugins/agint-quality-static/lib/checkers/l0-isolation.js')));
const { loadProfile } = await import(u(path.join(ROOT, 'plugins/agint-quality-static/lib/static-profile.js')));

const payload = () => ({
  toolName: 'note',
  signature: '{"type":"object"}',
  stubs: ['async record(input) {\n      const parsed = InputSchema.parse(input);\n      return parsed;\n    },'],
  intent: '存短文本',
});

const tmpDirs = [];

/**
 * 把合成产物落盘到临时目录，返回目录路径。
 */
function writePackage(mutate) {
  const r = synthPluginPackage({ payload: payload() });
  assert.equal(r.ok, true, r.reason);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-l0-'));
  tmpDirs.push(dir);
  for (const f of r.files) {
    const out = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.content);
  }
  if (mutate) mutate(dir);
  return dir;
}

function l0(dir) {
  return checkL0Isolation({ pluginDir: dir, profile: loadProfile() });
}

test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('B3 快乐路径：合规合成产物走真 l0-isolation ⇒ 0 blocker', async () => {
  const dir = writePackage();
  const findings = await l0(dir);
  const blockers = findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(findings, null, 2));
});

test('B3 门禁认得 AGINT 形态：产物用 spec 层级也能被读到（本条是假绿修复的回归钉）', async () => {
  const dir = writePackage();
  const mPath = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  // 钉住：AGINT 全仓形态 = spec.cordis / spec.storage，顶层不写
  assert.ok(m.spec.cordis.provides.length > 0);
  assert.ok(m.spec.storage.domains.length > 0);
  assert.equal(m.cordis, undefined, '产物不该为过门禁而在顶层双写');
  assert.equal(m.storage, undefined, '产物不该为过门禁而在顶层双写');
  const findings = await l0(dir);
  assert.equal(findings.filter((f) => f.severity === 'blocker').length, 0);
});

test('B3 负控①：域名改成 agint_meta（撞既有域）⇒ domainIsolation 真拦', async () => {
  const dir = writePackage((d) => {
    const p = path.join(d, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.spec.storage.domains = ['agint_meta'];
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
  });
  const findings = await l0(dir);
  const hit = findings.filter((f) => f.severity === 'blocker' && f.message.includes('[domainIsolation]'));
  assert.ok(hit.length > 0, `domainIsolation 没拦住：${JSON.stringify(findings)}`);
});

test('B3 负控②：服务键改成 agint.quality.*（撞 L0 FROZEN 命名空间）⇒ signatureCompatibility 真拦', async () => {
  const dir = writePackage((d) => {
    const p = path.join(d, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.spec.cordis.provides = ['agint.quality.evilsynth'];
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
  });
  const findings = await l0(dir);
  const hit = findings.filter((f) => f.severity === 'blocker' && f.message.includes('[signatureCompatibility]'));
  assert.ok(hit.length > 0, `signatureCompatibility 没拦住：${JSON.stringify(findings)}`);
});

test('B3 负控③：stubs 里 require 非白名单的 agint-* ⇒ dependencyWhitelist 真拦', async () => {
  const r = synthPluginPackage({
    payload: { ...payload(), stubs: ["const m = require('agint-mutator');\n    async evil() { return m; },"] },
  });
  assert.equal(r.ok, true, r.reason);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-l0-'));
  tmpDirs.push(dir);
  for (const f of r.files) {
    const out = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.content);
  }
  const findings = await l0(dir);
  const hit = findings.filter((f) => f.severity === 'blocker' && f.message.includes('[dependencyWhitelist]'));
  assert.ok(hit.length > 0, `dependencyWhitelist 没拦住：${JSON.stringify(findings)}`);
});
