/**
 * test/calibration.mjs 回归（提案 a6e6e1d9 第四步）。
 *
 * 为什么需要这组用例：拟合器在**真实数据上永远走不到拟合分支**（目前 0 条标注），
 * 一条没被执行过的拟合代码 = 没被验证过的代码。等老板标完 8 周才发现网格搜索报错，
 * 那时样本时间成本已经花掉了。
 *
 * 用合成样本钉住三件事：
 *   ① 标注足够（≥4 周）⇒ 真的跑网格、真的打印「最优组合」，且命中率是算出来的
 *   ② 无标注 ⇒ 明写「无法拟合」，不许伪造参数
 *   ③ 可辨识性：样本里从不出现的维度必须标 unidentifiable
 *
 * 跑法：node --test test/calibration.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIM_WEIGHTS, THRESHOLDS } from '../lib/scoring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'calibration.mjs');

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
  });
});

/**
 * 造 6 个 ISO 周的样本。composites 定在「噪声比与确信度扣分接近」的位置：
 *   noise 0.06（当前阈值 0.30 ⇒ 比值 0.20）、confidence 0.55（当前 0.70 ⇒ 0.214）
 * ⇒ 两者随阈值上下翻转，网格里**存在**能改变归因的候选（可辨识性非零）。
 * 标注（humanVerdict）一律取 confidence，于是「CONFIDENCE 调高 / NOISE 调高」
 * 会让更多周判 confidence 为最丑 —— 命中率因此是算出来的，不是常量。
 */
function syntheticWeeks({ annotate = true } = {}) {
  const out = [];
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(Date.UTC(2026, 9, 5 + i * 7, 9, 0, 0));
    out.push({
      id: `syn-${i}`,
      ts: d.toISOString(),
      kind: 'weekly',
      composites: { noise: 0.06, confidence: 0.55, redundancy: 0.01, bloat: 0.6 },
      score: 70 - i,
      verdict: 'flat',
      machineWorst: 'confidence',
      humanVerdict: annotate ? 'confidence' : null,
      humanOverall: annotate ? (i % 2 === 0 ? 'better' : 'worse') : null,
    });
  }
  return out;
}

async function withDump(samples, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agint-cal-'));
  const file = join(dir, 'dump.json');
  await writeFile(file, JSON.stringify({ samples }, null, 1));
  try { return await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('① 标注足够 ⇒ 真的跑网格并给出最优组合', async () => {
  await withDump(syntheticWeeks(), async (file) => {
    const { code, stdout, stderr } = await run(['--samples', file]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /已标注 6 周/, '分母必须是已标注周数');
    assert.match(stdout, /最优组合 ⇒ \d+\/6/);
    assert.match(stdout, /当前参数 NOISE 0\.3 \/ CONF 0\.7 \/ RED 0\.05 ⇒ \d+\/6/);
    assert.match(stdout, /可辨识性/);
  });
});

test('② 无标注 ⇒ 明写无法拟合，不伪造参数', async () => {
  await withDump(syntheticWeeks({ annotate: false }), async (file) => {
    const { code, stdout } = await run(['--samples', file]);
    assert.equal(code, 0);
    assert.match(stdout, /0 条已标注 ⇒ \*\*无法拟合\*\*/);
    assert.equal(/最优组合/.test(stdout), false, '没有 ground truth 就不许给出参数');
    assert.match(stdout, /本周期\*\*没有任何人工标注\*\*/);
  });
});

test('③ 从不出现的维度标 unidentifiable（不装作标定过）', async () => {
  await withDump(syntheticWeeks(), async (file) => {
    const { stdout } = await run(['--samples', file]);
    // 合成样本里 machineWorst 恒为 confidence ⇒ 另外三维从未当过最丑
    assert.match(stdout, /机器从不判为最丑的维：noise \/ redundancy \/ bloat/);
    assert.match(stdout, /BLOAT_SATURATION.*unidentifiable/);
  });
});

test('④ --worksheet 打印待标注清单与写入命令', async () => {
  await withDump(syntheticWeeks({ annotate: false }), async (file) => {
    const { code, stdout } = await run(['--samples', file, '--worksheet']);
    assert.equal(code, 0);
    assert.match(stdout, /待标注清单/);
    assert.match(stdout, /2026-W\d\d/);
    assert.match(stdout, /oracle-annotate/);
    assert.match(stdout, /实际动手处理的最丑维度/, '标注口径必须写在提示里');
  });
});

test('⑤ 公式自检在位：当前参数下参数化扣分 == scoring.js', async () => {
  // 若本脚本的 deduction() 与 scoring.js 漂移，任意命令都会 exit 2。
  await withDump(syntheticWeeks(), async (file) => {
    const { code } = await run(['--samples', file, '--worksheet']);
    assert.equal(code, 0, '参数化扣分必须与 scoring.js 逐点一致');
  });
  assert.equal(typeof THRESHOLDS.CONFIDENCE, 'number');
  assert.equal(typeof DIM_WEIGHTS.noise, 'number');
});
