/**
 * check-memory 门禁的自测。
 *
 * 为什么需要：门禁自己错了比没有门禁更危险 —— 它会给出一张假的「全绿」，
 * 而这张假绿会取代人肉排查（K63 那类静默失败能活四天的机制）。
 * 另外本门禁天生有一种「看起来绿」的失败态：**检查项一条都没匹配上**（正则写窄了）——
 * 所以下面对**计数**也断言，防的是"空跑"假绿。
 *
 * 跑法：node --test bin/check-memory.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-memory.mjs');
const NODE = process.execPath;

/** 门禁有 FAIL 时退出码是 1，execFileSync 会抛 —— 捕获后取 stdout 报表。 */
function runJson(args = []) {
  try {
    const out = execFileSync(NODE, [SCRIPT, '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { report: JSON.parse(out), exitCode: 0 };
  } catch (e) {
    if (e.status === 1 && e.stdout) return { report: JSON.parse(e.stdout), exitCode: 1 };
    throw e; // exit 2 / 语法错不许吞
  }
}
const codes = (r) => r.report.findings.map((f) => f.code);
const has = (r, code) => codes(r).includes(code);

/** 造一个 fixture：<tmp>/<case>/{.workbuddy/memory,repo} */
let caseNo = 0;
function fixture({ memory, knowledge, extraFiles = {}, strayMemory = null }) {
  const base = fs.mkdtempSync(join(os.tmpdir(), `cmm-${process.pid}-${++caseNo}-`));
  const memDir = join(base, '.workbuddy', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  if (memory !== null) fs.writeFileSync(join(memDir, 'MEMORY.md'), memory ?? '');
  if (knowledge !== null) fs.writeFileSync(join(memDir, 'KNOWLEDGE.md'), knowledge ?? '');
  for (const [rel, body] of Object.entries(extraFiles)) {
    const abs = join(base, rel);
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (strayMemory !== null) {
    const sd = join(base, 'repo', '.workbuddy', 'memory');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(join(sd, 'MEMORY.md'), strayMemory);
  }
  const repo = join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return { base, memDir, repo };
}

const KD_OK = '# K\n\n## K1 甲\n\n## K2 乙\n';
const MEM_OK = '# M\n\n引 K1 与 K2。\n';

describe('判据正确性（不是「脚本能不能跑」）', () => {
  test('① 干净输入 → 无 FAIL，且计数非零（防空跑假绿）', () => {
    const f = fixture({ memory: MEM_OK, knowledge: KD_OK });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    assert.equal(r.exitCode, 0);
    const fails = r.report.findings.filter((x) => x.level === 'F');
    assert.deepEqual(fails, [], `不该有 FAIL：${JSON.stringify(fails)}`);
    assert.equal(r.report.stats.kHeadings, 2);
    assert.equal(r.report.stats.kRefs, 2);
  });

  test('⭐ ② 索引指向不存在的条目 → FAIL dangling-k（这正是 K116 漏记的形态）', () => {
    const f = fixture({ memory: '# M\n\n引 K1 与 K9。\n', knowledge: KD_OK });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, 'dangling-k'), codes(r).join(','));
    assert.match(r.report.findings.find((x) => x.code === 'dangling-k').msg, /K9/);
  });

  test('⭐ ③ 重复 K 号但未声明 → FAIL dup-undeclared（声明腐坏 = 谁按声明避坑谁踩空）', () => {
    const f = fixture({
      memory: '# M\n\n## 索引\n\n引 K5。\n',
      knowledge: '# K\n\n## K5 甲\n\n## K5 乙\n',
    });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, 'dup-undeclared'));
  });

  test('④ 无重复、无声明 → 不报（不许为「没声明」而制造噪音）', () => {
    const f = fixture({ memory: '# M\n\n引 K1。\n', knowledge: '# K\n\n## K1 甲\n' });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    assert.equal(r.exitCode, 0);
    assert.ok(!has(r, 'dup-not-declared') && !has(r, 'dup-undeclared'), codes(r).join(','));
  });

  test('⑤ 声明的组数与实际不符 → WARN dup-count-mismatch', () => {
    const f = fixture({
      memory: '# M\n\n⚠️ **K 号有 5 组重复**（未重编号）\n**K5**（甲 / 乙）\n\n引 K5。\n',
      knowledge: '# K\n\n## K5 甲\n\n## K5 乙\n',
    });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    const m = r.report.findings.find((x) => x.code === 'dup-count-mismatch');
    assert.ok(m, codes(r).join(','));
    assert.match(m.msg, /5.*1|1.*5/);
  });

  test('⑥ MEMORY.md 超体积 → WARN memory-too-large', () => {
    const f = fixture({ memory: '# M\n\n' + 'x'.repeat(200), knowledge: KD_OK });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo, '--max-chars', '50']);
    assert.ok(has(r, 'memory-too-large'));
  });

  test('⑦ 引用的仓库路径不存在 → WARN path-ref-missing（存在的不许报）', () => {
    const f = fixture({
      memory: '# M\n\n`bin/check-wiring.mjs` 与 `docs/nope.md`\n',
      knowledge: KD_OK,
      extraFiles: { 'repo/bin/check-wiring.mjs': '// x\n' },
    });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    const msgs = r.report.findings.filter((x) => x.code === 'path-ref-missing').map((x) => x.msg);
    assert.equal(msgs.length, 1, JSON.stringify(msgs));
    assert.match(msgs[0], /docs\/nope\.md/);
  });

  test('⑧ 引用的技能不存在 → WARN skill-ref-missing', () => {
    const f = fixture({ memory: '# M\n\n技能 `definitely-not-a-skill-xyz`\n', knowledge: KD_OK });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    assert.ok(has(r, 'skill-ref-missing'));
  });

  test('⭐ ⑨ 沿路撞见残废记忆目录 → WARN stray-memory-dir（记忆分裂要可见）', () => {
    const f = fixture({ memory: MEM_OK, knowledge: KD_OK, strayMemory: '# 旧\n' });
    const r = runJson(['--repo', f.repo]); // 不传 --memory-dir，走向上查找
    assert.equal(r.report.memoryDir, f.memDir, '应选中带 KNOWLEDGE.md 的那份');
    assert.ok(has(r, 'stray-memory-dir'));
    assert.match(r.report.findings.find((x) => x.code === 'stray-memory-dir').msg, /旧记忆目录/);
  });

  test('⑩ 记忆文件缺失 → FAIL，不是静默通过', () => {
    const f = fixture({ memory: null, knowledge: null });
    const r = runJson(['--memory-dir', f.memDir, '--repo', f.repo]);
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, 'memory-missing'));
  });
});
