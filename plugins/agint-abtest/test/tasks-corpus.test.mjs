/**
 * test/tasks-corpus.test.mjs — 任务语料 lint（方案 §九.2）
 *
 * 每份语料：≥10 任务、≥2 区分度、≥1 阴性对照、assetPath 真实存在、
 * 每任务有判据（verifySpec 或 L2 text rubric）、id 唯一。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = resolve(__dirname, '../tasks');
const REPO_ROOT = resolve(__dirname, '../../..');

const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'));

test('语料目录非空', () => {
  assert.ok(files.length >= 1, 'tasks/ 应至少一份语料');
});

for (const f of files) {
  const corpus = JSON.parse(readFileSync(resolve(TASKS_DIR, f), 'utf8'));

  test(`${f}: ≥10 任务 + ≥2 区分度 + ≥1 阴性对照`, () => {
    assert.ok(corpus.tasks.length >= 10, `任务数 ${corpus.tasks.length} < 10`);
    const disc = corpus.tasks.filter((t) => t.kind === 'discrimination').length;
    const neg = corpus.tasks.filter((t) => t.kind === 'negative-control').length;
    assert.ok(disc >= 2, `区分度任务 ${disc} < 2`);
    assert.ok(neg >= 1, `阴性对照 ${neg} < 1`);
  });

  test(`${f}: assetPath 存在 + promptId 与文件名一致`, () => {
    assert.ok(existsSync(resolve(REPO_ROOT, corpus.assetPath)), `assetPath 不存在: ${corpus.assetPath}`);
    assert.equal(corpus.promptId, f.replace(/\.json$/, ''));
  });

  test(`${f}: 每任务有判据 + id 唯一 + rubric 维度齐全`, () => {
    const ids = new Set();
    assert.ok(Array.isArray(corpus.rubric?.dims) && corpus.rubric.dims.length >= 2, 'rubric.dims ≥2');
    for (const t of corpus.tasks) {
      assert.ok(!ids.has(t.id), `id 重复: ${t.id}`);
      ids.add(t.id);
      assert.ok(['L1-check', 'L1-exec', 'L2'].includes(t.layer), `${t.id} layer 非法`);
      const hasCriteria = t.verifySpec || (t.layer === 'L2' && t.answerShape === 'text');
      assert.ok(hasCriteria, `${t.id} 无判据`);
      if (t.layer === 'L1-exec') assert.ok(t.runner?.type, `${t.id} L1-exec 缺 runner`);
    }
  });
}