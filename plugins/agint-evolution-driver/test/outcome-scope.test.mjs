/**
 * outcome-scope 单测（1b R1′ 判据层）。
 *
 * 夹具用**仓内真实文件名**（`.agint-preimage/` 的六个真名 + 真存在的测试文件），
 * 不用编造名 —— 编造名会把判据测成"与生产者约定的另一种形状"，而生产者是 commitToRepo。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePreimagePath,
  deriveTestFiles,
  planTestScope,
} from '../lib/outcome-scope.js';

// 2026-10-03 实测取自 .agint-preimage/ 的六个真名
const REAL_PREIMAGES = [
  '.agint-preimage/bin__plugin-check.sh__2026-09-29T05-26-53-216Z.bak',
  '.agint-preimage/bin__plugin-check.sh__2026-09-29T06-18-42-718Z.bak',
  '.agint-preimage/bin__plugin-check.sh__2026-09-29T07-19-59-845Z.bak',
  '.agint-preimage/plugins__agint-skill-autocreate__test__skill-authoring.test.mjs__2026-09-29T09-34-01-413Z.bak',
  '.agint-preimage/presets__agint__skills__plugin-preflight__SKILL.md__2026-09-27T10-30-07-079Z.bak',
  '.agint-preimage/presets__agint__skills__plugin-preflight__SKILL.md__2026-09-29T10-04-30-457Z.bak',
];

const EXPECTED_PATHS = [
  'bin/plugin-check.sh',
  'bin/plugin-check.sh',
  'bin/plugin-check.sh',
  'plugins/agint-skill-autocreate/test/skill-authoring.test.mjs',
  'presets/agint/skills/plugin-preflight/SKILL.md',
  'presets/agint/skills/plugin-preflight/SKILL.md',
];

test('preimage 真名逐个反解回被改文件（与生产者 commitToRepo 的约定对拍）', () => {
  REAL_PREIMAGES.forEach((p, i) => {
    const r = parsePreimagePath(p);
    assert.equal(r.ok, true, `${p} ⇒ ${JSON.stringify(r)}`);
    assert.equal(r.repoRelPath, EXPECTED_PATHS[i], p);
    assert.match(r.stamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});

test('脏名一律拒，不猜路径', () => {
  for (const bad of [
    null, undefined, '', 'bin__plugin-check.sh__2026-09-29T05-26-53-216Z.bak', // 缺目录前缀
    '.agint-preimage/bin__plugin-check.sh.bak', // 缺时间戳
    '.agint-preimage/bin__plugin-check.sh__2026-09-29T05-26-53-216Z', // 缺 .bak
    '.agint-preimage/bin__plugin-check.sh__2026-09-29 05:26:53.bak', // 时间戳形状不对（未做 :/. → - 替换）
  ]) {
    const r = parsePreimagePath(bad);
    assert.equal(r.ok, false, `该拒：${String(bad)}`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝必须给原因');
  }
});

test('deriveTestFiles：认 .test.mjs 与插件 test/smoke.mjs，⛔ 不认场景集', () => {
  const files = deriveTestFiles([
    'bin/plugin-check-dim11.test.mjs',
    'bin/check-wiring.test.mjs',
    'plugins/agint-cron/test/evolution-reconcile-core.test.mjs',
    'plugins/agint-evolution-driver/test/smoke.mjs',
    'plugins/agint-evolution-driver/test/predictor.test.mjs',
    'test/schema-guard.test.mjs',
    'eval/scenarios/agint-cron.scenario.json',   // 场景集：实测不可见，必须排除
    'plugins/agint-demo/README.md',
    'plugins/agint-demo/test/helper.mjs',        // 不是 smoke.mjs 也不是 .test.mjs
    'docs/x.test.mjs',                            // 文档目录下的 .test.mjs 仍算测试（保守收录）
  ]);
  assert.deepEqual(files, [
    'bin/check-wiring.test.mjs',
    'bin/plugin-check-dim11.test.mjs',
    'docs/x.test.mjs',
    'plugins/agint-cron/test/evolution-reconcile-core.test.mjs',
    'plugins/agint-evolution-driver/test/predictor.test.mjs',
    'plugins/agint-evolution-driver/test/smoke.mjs',
    'test/schema-guard.test.mjs',
  ]);
  assert.equal(files.includes('plugins/agint-demo/test/helper.mjs'), false, '夹具不是可跑测试');
});

test('plugins/** ⇒ 同插件 test/ 全量（嵌套插件取最深插件根）', () => {
  const pool = deriveTestFiles([
    'plugins/agint-cron/test/jobs.test.mjs',
    'plugins/agint-cron/test/schedule-layout.test.mjs',
    'plugins/agint-memory/test/other.test.mjs',
    'plugins/agint-quality/agint-quality-eval/test/eval.test.mjs',
    'plugins/agint-quality/test/root.test.mjs',
    'plugins/agint-evolution-driver/test/smoke.mjs',
  ]);
  assert.deepEqual(planTestScope({ changedPath: 'plugins/agint-cron/lib/jobs.js', testFiles: pool }).files,
    ['plugins/agint-cron/test/jobs.test.mjs', 'plugins/agint-cron/test/schedule-layout.test.mjs'],
    '不得把邻居插件的测试算进来（delta 会被稀释并错误归因）');

  const nested = planTestScope({
    changedPath: 'plugins/agint-quality/agint-quality-eval/lib/regression.js',
    testFiles: pool,
  });
  assert.deepEqual(nested.files, ['plugins/agint-quality/agint-quality-eval/test/eval.test.mjs']);
  assert.equal(nested.rule, 'PLUGIN_TEST_DIR');

  const smoke = planTestScope({ changedPath: 'plugins/agint-evolution-driver/lib/index.js', testFiles: pool });
  assert.deepEqual(smoke.files, ['plugins/agint-evolution-driver/test/smoke.mjs'],
    'smoke.mjs 是 driver 集成件的形状，漏了它等于没有仪器');
});

test('bin/** ⇒ 按文件名前缀匹配（真实形状：plugin-check.sh ⇒ plugin-check-dim11.test.mjs）', () => {
  const pool = deriveTestFiles([
    'bin/plugin-check-dim11.test.mjs',
    'bin/check-wiring.test.mjs',
    'bin/check-l0-frozen.test.mjs',
  ]);
  assert.deepEqual(planTestScope({ changedPath: 'bin/plugin-check.sh', testFiles: pool }).files,
    ['bin/plugin-check-dim11.test.mjs']);
  assert.deepEqual(planTestScope({ changedPath: 'bin/check-wiring.mjs', testFiles: pool }).files,
    ['bin/check-wiring.test.mjs']);
  assert.equal(planTestScope({ changedPath: 'bin/agint-mount.sh', testFiles: pool }).covered, false,
    '没有同名前缀测试的 bin 脚本必须判无覆盖，而不是抓一条不相干的测试凑数');
});

test('⛔ 覆盖门：presets / docs / 纯文本 一律 NO_INSTRUMENT 且 files 为空', () => {
  const pool = deriveTestFiles(['plugins/agint-x/test/a.test.mjs']);
  for (const p of [
    'presets/agint/skills/plugin-preflight/SKILL.md',
    'docs/AGINT-经验教训技能沉淀-20260929.md',
    'wiki/x.md',
    'proposals/agint-cron.md',
  ]) {
    const r = planTestScope({ changedPath: p, testFiles: pool });
    assert.equal(r.covered, false, p);
    assert.deepEqual(r.files, [], p);
    assert.equal(r.rule, 'NO_INSTRUMENT', p);
    assert.equal(r.reason, 'NO_INSTRUMENT_FOR_TARGET_KIND', p);
  }
  // 与 v0.2.14 的期望声明同源：技能类没有仪器，量不到就如实说量不到
});

test('有插件目录但其 test/ 为空 ⇒ NO_EVIDENCE，不许退化成全仓 passRate', () => {
  const r = planTestScope({
    changedPath: 'plugins/agint-newcomer/lib/index.js',
    testFiles: deriveTestFiles(['plugins/agint-cron/test/jobs.test.mjs']),
  });
  assert.equal(r.covered, false);
  assert.equal(r.rule, 'PLUGIN_NO_TEST_DIR');
  assert.equal(r.reason, 'NO_EVIDENCE');
});

test('repoFiles 能核住 preimage 的有损编码（含 __ 的真路径解错了会被拦下）', () => {
  const decoded = 'plugins/a/b/x.js'; // 原名其实是 plugins/a__b/x.js，解回来对不上
  const r = planTestScope({
    changedPath: decoded,
    testFiles: ['plugins/a/b/test/x.test.mjs'],
    repoFiles: ['plugins/a__b/x.js', 'plugins/a__b/test/x.test.mjs'],
  });
  assert.equal(r.covered, false);
  assert.equal(r.rule, 'PATH_NOT_IN_REPO');
  assert.equal(r.reason, 'CHANGED_PATH_NOT_FOUND',
    '路径核不上就是没有证据，不能拿解错的路径去跑邻居的测试');
  const ok = planTestScope({
    changedPath: 'plugins/agint-cron/lib/jobs.js',
    testFiles: ['plugins/agint-cron/test/jobs.test.mjs'],
    repoFiles: ['plugins/agint-cron/lib/jobs.js', 'plugins/agint-cron/test/jobs.test.mjs'],
  });
  assert.equal(ok.covered, true);
});

test('纯函数：不改动入参数组，同输入同输出', () => {
  const pool = ['plugins/agint-cron/test/jobs.test.mjs', 'bin/plugin-check-dim11.test.mjs'];
  const snapshot = [...pool];
  const a = planTestScope({ changedPath: 'bin/plugin-check.sh', testFiles: pool });
  const b = planTestScope({ changedPath: 'bin/plugin-check.sh', testFiles: pool });
  assert.deepEqual(a, b);
  assert.deepEqual(pool, snapshot, '判据不得就地排序/改写调用方的数组');
});

test('缺 changedPath / 空 testFiles 都不炸，判无覆盖', () => {
  assert.equal(planTestScope({}).covered, false);
  assert.equal(planTestScope({ changedPath: '' }).rule, 'NO_PATH');
  const r = planTestScope({ changedPath: 'plugins/agint-cron/lib/jobs.js', testFiles: [] });
  assert.equal(r.covered, false);
  assert.deepEqual(r.files, []);
});
