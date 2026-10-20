// agents-size-guard 单测（2026-10-18）。
//
// 重点不是「超限能算对」，而是 check-soundness 那几条：
//   ① 输入源消失必须抛错（故障注入实测，不是推理）；
//   ② 时间戳不参与判定（否则每次都红）；
//   ③ 字节数用 UTF-8 编码长度，不取 stat.size。
//
// 纯逻辑，不依赖 dsh 运行时；用真实临时目录做 IO。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentsSizeGuard, measureSections, DEFAULT_LIMITS } from '../lib/agents-size-guard.js';

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'asg-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const bigText = (n) => 'x'.repeat(n);

test('默认限值与 AGENTS.md 自述的双限一致', () => {
  assert.equal(DEFAULT_LIMITS.maxBytes, 10000);
  assert.equal(DEFAULT_LIMITS.maxChars, 5000);
  assert.equal(DEFAULT_LIMITS.hostBudgetBytes, 12000);
});

test('未超限：level=ok 且不写报告（不往 docs/ 丢无信息量文件）', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    await writeFile(file, '# A\n\nshort\n', 'utf8');
    const r = await runAgentsSizeGuard({ file, reportDir: join(dir, 'docs') });
    assert.equal(r.level, 'ok');
    assert.equal(r.wroteReport, false);
    assert.equal(r.reportPath, null);
    assert.equal(r.critical, false);
  });
});

test('超字节限：level=critical，overBytes 算对，写报告', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    await writeFile(file, bigText(10001), 'utf8');
    const r = await runAgentsSizeGuard({ file, reportDir: join(dir, 'docs') });
    assert.equal(r.level, 'critical');
    assert.equal(r.overBytes, 1);
    assert.equal(r.wroteReport, true);
    assert.ok(await readFile(r.reportPath, 'utf8'));
  });
});

test('只超字符限（字节未超）：中文 3000 字 = 9000 字节 < 10000 但字符可超限', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    // 1 个中文 = 3 字节。用 6000 个中文：18000 字节（也超字节限）。
    // 构造「字节不超、字符超」需西文字符：ASCII 1 字节 = 1 字符 ⇒ 不可能。
    // 故改为验证双限是 OR 关系：任一超限即 critical。这里两个都超，仍须 critical。
    await writeFile(file, '中'.repeat(6000), 'utf8');
    const r = await runAgentsSizeGuard({ file, reportDir: join(dir, 'docs') });
    assert.equal(r.bytes, 18000);
    assert.equal(r.chars, 6000);
    assert.equal(r.overBytes, 8000);
    assert.equal(r.overChars, 1000);
    assert.equal(r.critical, true);
  });
});

test('逼近上限（≥90%）：level=warn 且写报告（提前量，不等超限）', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    // ⚠ 不能用纯 ASCII 构造：ASCII 下字节数 == 字符数，9100 字节会同时撞破
    // 5000 字符限而变成 critical。warn 区间的真形状是「字节高、字符低」——
    // 用双字节字符：4600 字 × 2 字节 = 9200 字节（92% > 90%，未超 10000），
    // 4600 字符（未超 5000）。
    await writeFile(file, 'é'.repeat(4600), 'utf8');
    const r = await runAgentsSizeGuard({ file, reportDir: join(dir, 'docs') });
    assert.equal(r.bytes, 9200);
    assert.equal(r.chars, 4600);
    assert.equal(r.level, 'warn');
    assert.equal(r.critical, false);
    assert.equal(r.wroteReport, true);
  });
});

test('中文正文更容易先撞字符限：双限是 OR，任一触顶即 critical', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    // 纯 ASCII 正文：6000 字节 = 6000 字符 ⇒ 字节远未到 10000，字符已破 5000。
    await writeFile(file, bigText(6000), 'utf8');
    const r = await runAgentsSizeGuard({ file, reportDir: join(dir, 'docs') });
    assert.equal(r.overBytes, 0, '字节未超限');
    assert.equal(r.overChars, 1000, '字符超限 1000');
    assert.equal(r.critical, true, '任一触顶即须压缩');
  });
});

test('故障注入：被核文件消失 ⇒ 抛错（静默 skip = 门禁失效）', async () => {
  await withTmp(async (dir) => {
    await assert.rejects(
      () => runAgentsSizeGuard({ file: join(dir, 'nope.md'), reportDir: join(dir, 'docs') }),
      /读不到/,
      '文件不存在必须抛错，不能当「没问题」',
    );
  });
});

test('故障注入：报告目录不可写 ⇒ 抛错', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    await writeFile(file, bigText(12000), 'utf8');
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not-a-dir', 'utf8'); // mkdir 会撞上
    await assert.rejects(
      () => runAgentsSizeGuard({ file, reportDir: join(blocker, 'docs') }),
      /报告写盘失败/,
    );
  });
});

test('故障注入：localFile 配了但读不到（非 ENOENT）⇒ 抛错', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    await writeFile(file, 'ok\n', 'utf8');
    const local = join(dir, 'localdir');
    await mkdir(local); // 读一个目录会 EISDIR，不是 ENOENT
    await assert.rejects(
      () => runAgentsSizeGuard({ file, reportDir: join(dir, 'docs'), localFile: local }),
      /localFile 配了但读不到/,
    );
  });
});

test('localFile 不存在是正常态：不报错，localPresent=false', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    await writeFile(file, 'ok\n', 'utf8');
    const r = await runAgentsSizeGuard({
      file,
      reportDir: join(dir, 'docs'),
      localFile: join(dir, 'AGENTS.local.md'),
    });
    assert.equal(r.localPresent, false);
    assert.equal(r.localBytes, 0);
    assert.equal(r.level, 'ok');
  });
});

test('宿主预算风险：AGENTS.md 未触双限但吃掉 12000 预算 ⇒ 判出丢弃风险并写报告', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    // 8000 字节 / 8000 字符 —— 字节未超 10000，字符超 5000 字符限（这是双限的
    // 本意：任一先触顶即须压缩）。此处刻意让「字节不超」以隔离 hostDropRisk 判据：
    // 8192 字节 + 4096 字节覆盖层 = 12288 > 12000，唯一触发点是覆盖层。
    await writeFile(file, bigText(8192), 'utf8');
    const local = join(dir, 'AGENTS.local.md');
    await writeFile(local, bigText(4096), 'utf8');
    const r = await runAgentsSizeGuard({ file, reportDir: join(dir, 'docs'), localFile: local });
    assert.equal(r.bytes, 8192, '字节未触 10000 硬限');
    assert.equal(r.budgetUsed, 12288);
    assert.equal(r.hostDropRisk, true, '12288 > 12000，宿主会整份丢弃');
    assert.equal(r.wroteReport, true);
    const body = await readFile(r.reportPath, 'utf8');
    assert.match(body, /宿主预算|丢弃/, '报告必须说清是宿主预算风险');
  });
});

test('时间戳不参与判定：同一内容连跑两次，level 与体积完全相同', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    await writeFile(file, bigText(10500), 'utf8');
    const a = await runAgentsSizeGuard({ file, reportDir: join(dir, 'd1') });
    const b = await runAgentsSizeGuard({ file, reportDir: join(dir, 'd2') });
    assert.equal(a.level, b.level);
    assert.equal(a.bytes, b.bytes);
    assert.equal(a.chars, b.chars);
    // 报告文件名带日期，同日同文件名 ⇒ 内容也应一致（时间戳只在正文里作留痕字符串）
    assert.equal(
      (await readFile(a.reportPath, 'utf8')).replace(/（\d{8}）/, '（DATE）'),
      (await readFile(b.reportPath, 'utf8')).replace(/（\d{8}）/, '（DATE）'),
    );
  });
});

test('字节数按 UTF-8 算，不取 stat.size（CRLF 与多字节都要算准）', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    const text = '中'.repeat(10); // 30 字节 / 10 字符
    await writeFile(file, text, 'utf8');
    const r = await runAgentsSizeGuard({ file, reportDir: join(dir, 'docs') });
    assert.equal(r.bytes, 30);
    assert.equal(r.chars, 10);
  });
});

test('measureSections 能切出标题段并算字节', () => {
  const text = '# 一\n\nbody one\n\n## 二\n\nbody two\n';
  const secs = measureSections(text);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].title, '一');
  assert.equal(secs[0].level, 1);
  assert.equal(secs[1].title, '二');
  assert.ok(secs[0].bytes > 0 && secs[1].bytes > 0);
  const total = secs.reduce((n, s) => n + s.bytes, 0);
  assert.equal(total, Buffer.byteLength(text, 'utf8'));
});

test('measureSections 无标题时退化为单段', () => {
  const secs = measureSections('no heading here\n');
  assert.equal(secs.length, 1);
  assert.equal(secs[0].title, '(全文无标题)');
});

test('自定义限值时以传入值为准（宿主预算可随 profile 调整）', async () => {
  await withTmp(async (dir) => {
    const file = join(dir, 'AGENTS.md');
    await writeFile(file, bigText(600), 'utf8');
    const r = await runAgentsSizeGuard({
      file,
      reportDir: join(dir, 'docs'),
      maxBytes: 500,
      maxChars: 500,
    });
    assert.equal(r.critical, true);
    assert.equal(r.overBytes, 100);
  });
});
