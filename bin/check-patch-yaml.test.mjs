import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(REPO_ROOT, 'bin', 'check-patch-yaml.mjs');

function runFile(file) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--json', '--file', file], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    // exit 1 时 stdout 里仍有 --json 输出
    return { code: e.status, json: e.stdout ? JSON.parse(e.stdout) : null };
  }
}

function writeTmp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchyaml-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('仓库真身 cordis.patch.yml 可解析', () => {
  const { code, json } = runFile(path.join(REPO_ROOT, 'cordis.patch.yml'));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.results[0].ok, true);
});

test('反引号模板字面量 ❌ 必须判失败（2026-10-20 事故形态）', () => {
  const bad = writeTmp('bad.patch.yml', [
    '- insert:',
    '    - id: x',
    '      name: ./plugins/x/lib/index.js',
    '      config:',
    '        p: !!js ` (process.env.A || "b") + "/c" `',
    '',
  ].join('\n'));
  const { code, json } = runFile(bad);
  assert.equal(code, 1);
  assert.equal(json.results[0].ok, false);
  assert.match(json.results[0].error, /js/);
});

test('正确写法：带引号的单行 !!js 标量 ✅', () => {
  const good = writeTmp('good1.patch.yml', [
    '- insert:',
    '    - id: x',
    '      name: ./plugins/x/lib/index.js',
    '      config:',
    '        p: !!js "(process.env.A || \'b\') + \'/c\'"',
    '',
  ].join('\n'));
  const { code } = runFile(good);
  assert.equal(code, 0);
});

test('正确写法：裸标量 !!js ✅', () => {
  const good = writeTmp('good2.patch.yml', [
    '- insert:',
    '    - id: x',
    '      name: ./plugins/x/lib/index.js',
    '      config:',
    '        p: !!js (process.env.A || \'b\') + \'/c\'',
    '',
  ].join('\n'));
  const { code } = runFile(good);
  assert.equal(code, 0);
});

test('顶层不是数组 ❌', () => {
  const bad = writeTmp('notarray.patch.yml', 'id: x\n');
  const { code, json } = runFile(bad);
  assert.equal(code, 1);
  assert.match(json.results[0].error, /数组/);
});
