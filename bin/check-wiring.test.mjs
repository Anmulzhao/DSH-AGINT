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

  test('存在缺口时退出码为 1（门禁必须真的能拦）', () => {
    assert.equal(exitCode, 1, `退出码 ${exitCode} —— 有缺口却不报错，门禁形同虚设`);
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
    assert.equal(byTopic.get('sandbox.failed')?.rawVerdict, 'ORPHAN_TOPIC');
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

describe('当前真实状态断言（修好后这里会红 —— 那时请更新豁免与文档）', () => {
  const dead = report.domains.neverEnergized.filter((d) => !d.exemption).map((d) => d.domain);

  test('agint_mutator 尚未通电', () => {
    assert.ok(
      dead.includes('agint_mutator'),
      'agint_mutator 已通电 —— 好消息。请：①更新 docs/wiring-exemptions.json 里 sandbox.* 的连带豁免 ②更新 known-limitations ③把本断言改为「已通电」',
    );
  });

  test('agint_population 尚未通电', () => {
    assert.ok(
      dead.includes('agint_population'),
      'agint_population 已通电 —— 同上，请同步文档与本断言',
    );
  });
});
