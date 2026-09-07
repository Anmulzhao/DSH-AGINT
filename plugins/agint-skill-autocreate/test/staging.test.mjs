// Sprint 15 T1 验收：staging 候选物化（SKILL.md + manifest.json + scripts）、
// TTL 兜底清理、路径安全。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createStaging,
  cleanupCandidate,
  cleanupStale,
  renderSkillMd,
  stagingRootFor,
  assertSafeCandidateId,
} from '../lib/staging.js';

const DRAFT = {
  name: 'pdf-summarizer',
  description: '批量总结 PDF 文档并输出要点列表',
  category: 'productivity',
  template: 'file-processing',
  frontmatter: {
    name: 'pdf-summarizer',
    description: '批量总结 PDF 文档并输出要点列表',
    triggers: ['用户要求总结 PDF', 'pdf 太多需要摘要'],
    tools: ['read_file', 'write_file'],
  },
  body: '# PDF 总结\n\n1. 读取用户指定的 PDF 文件。\n2. 提取每页要点。\n',
  references: [],
  scripts: ['#!/bin/sh\necho "summary"'],
};

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'staging-'));
  return dir;
}

test('createStaging：物化 SKILL.md + manifest.json + scripts/', async () => {
  const home = makeHome();
  try {
    const cand = { id: 'sc_20260908_abc123', skillDraft: DRAFT };
    const { dir, files } = await createStaging(cand, { dshHome: home });

    assert.ok(dir.includes(join('staging', cand.id)), '目录应在 staging/<candidateId>');
    assert.ok(files.includes('SKILL.md'));

    const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    assert.ok(skillMd.startsWith('---\nname: pdf-summarizer\n'));
    assert.ok(skillMd.includes('triggers:\n  - 用户要求总结 PDF'));
    assert.ok(skillMd.includes('# PDF 总结'));

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, 'pdf-summarizer');
    assert.equal(manifest.version, '0.0.0');
    assert.equal(manifest.candidateId, cand.id);
    assert.deepEqual(manifest.tools, ['read_file', 'write_file']);

    const script = readFileSync(join(dir, 'scripts', 'script_0.sh'), 'utf8');
    assert.ok(script.includes('summary'), 'scripts 字符串元素应物化为 script_<i>.sh');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('createStaging：对象形态脚本 {name, content} 物化到 scripts/', async () => {
  const home = makeHome();
  try {
    const cand = {
      id: 'sc_20260908_obj123',
      skillDraft: { ...DRAFT, scripts: [{ name: 'run.sh', content: '#!/bin/sh\nnode run.js' }] },
    };
    await createStaging(cand, { dshHome: home });
    const script = readFileSync(join(stagingRootFor(home), cand.id, 'scripts', 'run.sh'), 'utf8');
    assert.ok(script.includes('node run.js'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('renderSkillMd：frontmatter 逐项渲染 + body 保真', () => {
  const md = renderSkillMd(DRAFT);
  assert.ok(md.includes('name: pdf-summarizer'));
  assert.ok(md.includes('description: 批量总结 PDF 文档并输出要点列表'));
  assert.ok(md.includes('  - 用户要求总结 PDF'));
  assert.ok(md.includes('  - read_file'));
  assert.ok(md.endsWith('# PDF 总结\n\n1. 读取用户指定的 PDF 文件。\n2. 提取每页要点。\n\n'));
});

test('createStaging 幂等：同 candidateId 重建不报错', async () => {
  const home = makeHome();
  try {
    const cand = { id: 'sc_20260908_repeat', skillDraft: DRAFT };
    const a = await createStaging(cand, { dshHome: home });
    const b = await createStaging(cand, { dshHome: home });
    assert.equal(a.dir, b.dir);
    assert.ok(existsSync(join(a.dir, 'SKILL.md')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cleanupStale：超过 TTL 的目录被清理，新鲜的不动', async () => {
  const home = makeHome();
  try {
    const old = { id: 'sc_20260901_oldone', skillDraft: DRAFT };
    const fresh = { id: 'sc_20260908_fresh', skillDraft: DRAFT };
    const oldDir = (await createStaging(old, { dshHome: home })).dir;
    await createStaging(fresh, { dshHome: home });

    // 把 old 目录 mtime 拨回 8 天前
    const past = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const { utimesSync } = await import('node:fs');
    utimesSync(oldDir, new Date(past), new Date(past));

    const res = await cleanupStale({ dshHome: home, ttlDays: 7 });
    assert.deepEqual(res.removed, [old.id]);
    assert.ok(!existsSync(oldDir), '旧目录应被清理');
    assert.ok(existsSync(join(stagingRootFor(home), fresh.id, 'SKILL.md')), '新目录保留');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cleanupCandidate：单候选删除', async () => {
  const home = makeHome();
  try {
    const cand = { id: 'sc_20260908_clean', skillDraft: DRAFT };
    const { dir } = await createStaging(cand, { dshHome: home });
    assert.ok(existsSync(dir));
    assert.equal(await cleanupCandidate(cand.id, { dshHome: home }), true);
    assert.ok(!existsSync(dir));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('路径安全：非法 candidateId 拒绝（防穿越）', () => {
  assert.throws(() => assertSafeCandidateId('../../etc/passwd'));
  assert.throws(() => assertSafeCandidateId('a/b'));
  assert.throws(() => assertSafeCandidateId(''));
  assert.doesNotThrow(() => assertSafeCandidateId('sc_20260908_abc123'));
});
