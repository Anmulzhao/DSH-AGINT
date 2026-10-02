/**
 * check-wiring 门禁的自测。
 *
 * 为什么需要：门禁自己错了比没有门禁更危险 —— 它会给出一张假的「全绿」，
 * 而这张假绿会取代人肉排查（这正是 K63 那类静默失败能活四天的机制）。
 *
 * 测的不是「脚本能不能跑」，是**判据对不对**：
 *   - 已知正常的链路不许被误报成缺口（防误报回归）
 *   - 豁免机制必须真的生效（否则豁免清单形同虚设）
 *   - 当前真实状态断言（mutator/population 未通电）—— 修好后这里会红，
 *     **那是提醒你去更新豁免清单与文档，不是让你删掉这条断言**。
 *
 * 跑法：node --test bin/check-wiring.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, 'check-wiring.mjs');
const NODE = process.execPath;

/**
 * ⚠️ 门禁有缺口时退出码就是 1，而 execFileSync 见非零退出码会抛异常 ——
 *    直接调用会让「门禁报出了缺口」变成「测试崩了」，正好掩盖真实信号。
 *    所以这里必须捕获，从 error.stdout 取报表。
 */
function runJson(args = []) {
  try {
    const out = execFileSync(NODE, [SCRIPT, '--json', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { report: JSON.parse(out), exitCode: 0 };
  } catch (e) {
    if (e.status === 1 && e.stdout) return { report: JSON.parse(e.stdout), exitCode: 1 };
    throw e; // 真的崩了（exit 2 / 语法错）不许吞
  }
}

const { report, exitCode } = runJson();

describe('输出契约', () => {
  test('--json 可被解析且含四查结果', () => {
    assert.ok(report.checkedAt, '缺少 checkedAt');
    assert.ok(Array.isArray(report.shellServices), '缺少 shellServices');
    assert.ok(Array.isArray(report.topics), '缺少 topics');
    assert.ok(report.domains, '缺少 domains');
    assert.ok(Array.isArray(report.domains.neverEnergized), '缺少 domains.neverEnergized');
  });

  test('生产存储真的读到了数据（读数失败必须显性暴露）', () => {
    assert.equal(report.prodError, null, `生产存储读取失败：${report.prodError}`);
    assert.ok(report.prodTotal > 0, '生产事件数为 0 —— 要么存储路径错了，要么总线真的空了');
  });

  test('退出码与缺口一致（有缺口必须 exit 1，无缺口才 exit 0）', () => {
    const hardGaps =
      report.topics.filter((t) => t.verdict === 'ORPHAN_TOPIC' || t.verdict === 'NO_SUBSCRIBER').length +
      report.missingServices.length +
      (report.tsDrift?.length ?? 0) +
      (report.dualCopy?.divergent?.length ?? 0) +
      (report.dualCopy?.mirrorMissing?.length ?? 0);
    assert.equal(
      exitCode,
      hardGaps > 0 ? 1 : 0,
      `缺口 ${hardGaps} 条却退出 ${exitCode} —— 门禁的拦与放必须对得上`,
    );
    // 反向验证：不能因为"什么都查不出来"才绿。生产数据必须真的读到了。
    assert.ok(report.topics.some((t) => t.prodCount > 0), '一条生产数据都没有 —— 门禁可能根本没连上存储');
  });
});

describe('防误报：已知健康的链路不许被判成缺口', () => {
  const byTopic = new Map(report.topics.map((t) => [t.topic, t]));

  test('evolution.evaluated 有订阅方（quality-policy / trajectory）', () => {
    const t = byTopic.get('evolution.evaluated');
    assert.ok(t, '未检出 evolution.evaluated');
    assert.equal(t.verdict, 'OK', `误判为 ${t.verdict}；发布/订阅=${t.publishers.length}/${t.subscribers.length}`);
  });

  test('policy.deployed 有订阅方（metrics 计数器）', () => {
    assert.equal(byTopic.get('policy.deployed')?.verdict, 'OK');
  });

  test('evolution.proposed 有订阅方（09-20 接线成果不许回退）', () => {
    const t = byTopic.get('evolution.proposed');
    assert.equal(t.verdict, 'OK');
    assert.ok(t.prodCount > 0, 'evolution.proposed 生产数为 0 —— 09-20 的接线可能断了');
  });

  test('服务名不许被当成 topic（agint.* 命名空间误报回归）', () => {
    const bogus = report.topics.filter((t) => /^agint\.[a-z]+$/.test(t.topic));
    assert.deepEqual(bogus, [], `把服务名当成了 topic：${bogus.map((b) => b.topic).join(', ')}`);
  });
});

describe('豁免机制', () => {
  const byTopic = new Map(report.topics.map((t) => [t.topic, t]));

  test('清单里的主题被标为 EXEMPTED 且不进 FAIL', () => {
    for (const topic of ['sandbox.failed', 'sandbox.passed', 'hmr.settled', 'evoorch.task-started']) {
      const t = byTopic.get(topic);
      assert.ok(t, `未检出 ${topic}`);
      assert.equal(t.verdict, 'EXEMPTED', `${topic} 未被豁免（实际 ${t.verdict}）`);
      assert.ok(t.exemption?.reason, `${topic} 的豁免缺少 reason`);
    }
  });

  test('豁免过的主题仍保留原始判定，便于复查', () => {
    // 2026-09-29 更新：sandbox.failed 已有 **1 条**生产数据（v0.2.7 实跑时 runSmoke
    // 返回 plugin-not-found，sandbox 插件仍发了 sandbox.failed —— 见
    // plugins/agint-quality-sandbox/lib/index.js:296-300 的 addFailure 与 :230 的 withPublish）。
    // 于是 check-wiring 的判定按「生产有数据 ⇒ 发布方是动态构造」翻转：
    //   decide 逻辑 bin/check-wiring.mjs:274
    //   if (pubs.length === 0 && subs.length > 0) verdict = n > 0 ? 'PUBLISHER_DYNAMIC' : 'ORPHAN_TOPIC'
    // 从 ORPHAN_TOPIC 变成 PUBLISHER_DYNAMIC。**这是本断言按设计触发**（它本来就是
    // 「上游通电就提醒复查」的 watchdog），不是回归。
    assert.equal(byTopic.get('sandbox.failed')?.rawVerdict, 'PUBLISHER_DYNAMIC');
    // sandbox.passed 至今 n=0（runSmoke 从未返回过 ok），维持 ORPHAN_TOPIC。
    // 它一旦变成 PUBLISHER_DYNAMIC，这里就该红 —— 那同样是要复查豁免的信号。
    assert.equal(byTopic.get('sandbox.passed')?.rawVerdict, 'ORPHAN_TOPIC');
  });

  test('查 F：没有任何「取了但没注册」的命名空间（恒 undefined 不报错，最阴的一类）', () => {
    assert.deepEqual(
      report.missingServices.map((m) => m.name),
      [],
      '存在命名空间错配：取不到服务却不报错，只会静默软降级',
    );
  });

  test('查 G：TS 源与产物无漂移（只改 lib 会被下次 build 静默回退）', () => {
    assert.deepEqual(report.tsDrift ?? [], [], 'lib 与 src 的 provide 键集合不一致 —— 下次 build 会丢服务');
  });

  test('查 H：仓库改动已全部上线（部署位不应停留在旧 hash）', () => {
    assert.ok(
      Array.isArray(report.drift.repoNewer),
      'JSON 里缺少 drift.repoNewer —— 查 H 没导出结果',
    );
    assert.deepEqual(
      report.drift.repoNewer,
      [],
      `这些文件改了仓库还没部署到宿主：\n${report.drift.repoNewer.join('\n')}`,
    );
  });

  test('查 H：部署位没有仓库不知情的本地改动', () => {
    assert.deepEqual(
      report.drift.hostOnly,
      [],
      `宿主部署位有仓库里不存在的文件（下次 install 会覆盖，需先回收）：\n${report.drift.hostOnly.join('\n')}`,
    );
  });

  test('查 H：漂移比对确实扫到了足够多的文件（挂空档要能发现）', () => {
    assert.ok(
      report.drift.checked > 100,
      `只比对了 ${report.drift.checked} 个文件 —— 多半是路径算错了，查 H 形同虚设`,
    );
  });

  test('双副本没有走偏（bundle 位 vs 兼容镜像位逐字节一致）', () => {
    assert.ok(report.dualCopy.checked > 0, '未检出双副本布局 —— install.sh 的镜像位可能已不再同步');
    assert.equal(report.dualCopy.divergent.length, 0, `副本已分叉：${report.dualCopy.divergent.join(', ')}`);
    assert.equal(report.dualCopy.mirrorMissing.length, 0, `镜像位缺失：${report.dualCopy.mirrorMissing.join(', ')}`);
  });

  test('域豁免生效：agint_search 不计入 DEAD', () => {
    const dead = report.domains.neverEnergized.map((d) => d.domain);
    assert.ok(!dead.includes('agint_search') || report.domains.neverEnergized.find((d) => d.domain === 'agint_search')?.exemption);
  });
});

describe('当前真实状态断言（再变红时请更新豁免与文档）', () => {
  const dead = report.domains.neverEnergized.filter((d) => !d.exemption).map((d) => d.domain);
  const energized = report.domains.energized.map((d) => d.domain);

  // 2026-09-29：mutator / population 域已通电（agint_mutator.json 13629B mtime 2026-09-28 22:49:39，
  // proposals=3；agint_population.json 5438B，variants=2）。原断言是「尚未通电」的看门狗，
  // 通电后故意红以提醒同步豁免与文档 —— 豁免（sandbox.*）与 known-limitations 已于同日更新，
  // 断言随之翻转为「已通电」。下半链（commit → sandbox.runSmoke）仍未通，另由豁免条目盯着。
  test('agint_mutator 已通电', () => {
    assert.ok(
      !dead.includes('agint_mutator'),
      'agint_mutator 又退回未通电 —— 请查 $DSH_HOME/storages/agint_mutator.json 是否消失，并复查 wiring-exemptions 里 sandbox.* 的 unblockWhen',
    );
    assert.ok(energized.includes('agint_mutator'), `agint_mutator 应在已通电列表里，当前已通电 ${energized.length} 个`);
  });

  test('agint_population 已通电', () => {
    assert.ok(
      !dead.includes('agint_population'),
      'agint_population 又退回未通电 —— 同上，请复查 agint_population.json 与 sandbox.* 豁免',
    );
    assert.ok(energized.includes('agint_population'), `agint_population 应在已通电列表里，当前已通电 ${energized.length} 个`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 交付物（设计 §5.2.2）：--static-only 静态模式
//
// 为什么单独立测：这条模式是给 CI / 未部署环境用的。它最大的风险不是报错，
// 而是**静默地什么都不查** —— 查 E/H 在没有部署位时本来就恒空（existsSync 守卫
// 直接短路），如果不显式标注，那张"一致"是假绿。所以断言里必须验「跳过了」
// 这件事被**说出来**了，而不只是没报错。
// ─────────────────────────────────────────────────────────────────────────────
describe('--static-only 静态模式', () => {
  const run = (args) =>
    execFileSync(NODE, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  test('跳过查 E 与查 H，并且**显式说出**跳过了（不是静默不查）', () => {
    const out = run(['--static-only']);
    assert.match(out, /查 E：双副本一致性/);
    assert.match(out, /查 H：仓库 ↔ 部署位漂移/);
    assert.match(out, /⊘ 跳过（--static-only）/, '跳过状态必须在输出里可见，否则与假绿无法区分');
    // 出现两次：E 一次、H 一次
    assert.equal((out.match(/⊘ 跳过（--static-only）/g) || []).length, 2);
  });

  test('保留 A/B/C/D/F/G/I（设计 §5.2.2 只跳 E/H）', () => {
    const out = run(['--static-only']);
    for (const label of ['查 A：空壳服务', '查 B/C：主题接线', '查 D：存储域通电', '查 F：命名空间错配', '查 G：TS 源/产物漂移', '查 I：漂移插件 smoke 验证']) {
      assert.ok(out.includes(label), `静态模式漏了 ${label}`);
    }
  });

  test('结论行标注静态模式', () => {
    const out = run(['--static-only']);
    assert.match(out, /静态模式：查 E\/H 已跳过/);
  });

  test('向后兼容：不带参数时不得出现静态模式标记（既有调用方行为不变）', () => {
    const out = run([]);
    assert.doesNotMatch(out, /⊘ 跳过（--static-only）/, '默认模式被静态模式污染了');
    assert.doesNotMatch(out, /静态模式：查 E\/H 已跳过/);
  });

  test('--json 下 E/H 带 skipped 标记（静态模式必须自证没查过，而不是报"一致"）', () => {
    const j = JSON.parse(run(['--static-only', '--json']));
    assert.equal(j.dualCopy.skipped, true, '查 E 未标记 skipped');
    assert.ok(j.dualCopy.skipReason && j.dualCopy.skipReason.length > 0);
    assert.equal(j.drift.skipped, true, '查 H 未标记 skipped');
    assert.ok(j.drift.skipReason && j.drift.skipReason.length > 0);
    // 跳过的检查不得产出"一致"这种假结论
    assert.equal(j.dualCopy.checked, 0);
    assert.equal(j.drift.checked, 0);
  });

  test('默认模式 --json 下 E/H 不带 skipped 标记（向后兼容）', () => {
    const j = JSON.parse(run(['--json']));
    assert.notEqual(j.dualCopy.skipped, true);
    assert.notEqual(j.drift.skipped, true);
  });
});
