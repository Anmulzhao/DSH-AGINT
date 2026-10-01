/**
 * check-preset-parity 门禁的自测。
 *
 * 为什么需要：门禁自己错了比没有门禁更危险 —— 它会给出一张假的「全绿」，
 * 而这张假绿会取代人肉排查。本门禁的判据有两个特别容易写错的地方，各有一条专门用例：
 *
 *   1. **嵌套行**：cordis:group 的子行放在 config 数组里（plan-mode / compaction-basic /
 *      tool-workflow 都在那儿）。只遍历顶层就会漏掉三组能力，判据却照样报「通过」。
 *   2. **`!!js` 表达式**：`disabled: !!js process.platform === 'win32'` 解析出来是**字符串**，
 *      按真值判断会把 Linux 上明明启用的 tool-bash 误判成禁用 ⇒ 假红。
 *
 * 跑法：node --test bin/check-preset-parity.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = path.join(HERE, 'check-preset-parity.mjs');
const NODE = process.execPath;

/**
 * ⚠️ 门禁有缺口时退出码就是 1，而 execFileSync 见非零退出码会抛异常 ——
 *    直接调用会让「门禁报出了缺口」变成「测试崩了」，正好掩盖真实信号。
 *    所以这里必须捕获，从 error.stdout 取报表。exit 2（环境不满足）仍向上抛。
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
    throw e;
  }
}

const kinds = (report, level) => report.issues.filter((i) => i.level === level).map((i) => i.kind);

/* ------------------------------------------------------------------ *
 * fixture 构造
 * ------------------------------------------------------------------ */

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-parity-')); });
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
function writeFixture(content) {
  const file = path.join(tmp, `f${seq++}.yml`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/** shipped cordis preset 的形态：patch 文件里 insert 段下的 preset-cordis 行。 */
function targetFile(pluginsYaml) {
  return writeFixture(`- insert:
    - id: preset-cordis
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cordis
        plugins:
${pluginsYaml}`);
}

/** agint preset 的形态：裸 plugins 数组（cordis:include 直接加载它）。 */
function agintFile(pluginsYaml) {
  return writeFixture(pluginsYaml);
}

const BASE_ROWS = `          - id: persona
            name: '@deepseek-ai/dsh-persona'
          - id: present
            name: '@deepseek-ai/dsh-tool-present'
          - id: tool-cordis
            name: '@deepseek-ai/dsh-tool-cordis'`;

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('check-preset-parity 判据', () => {
  test('完全对齐时通过，且不误报超集', () => {
    const t = targetFile(BASE_ROWS);
    const a = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: present
  name: '@deepseek-ai/dsh-tool-present'
- id: tool-cordis
  name: '@deepseek-ai/dsh-tool-cordis'
- id: agint-memory-tools
  name: ../../profiles/web/plugins/agint-memory/lib/tools.js`);
    const { report, exitCode } = runJson([`--target-file=only=${t}`, `--agint=only=${a}`]);
    assert.equal(report.critical, 0, `不该有 critical：${JSON.stringify(report.issues)}`);
    assert.equal(exitCode, 0);
    // 多出来的 agint 工具模块是预期超集，只能是 info
    assert.deepEqual(kinds(report, 'info'), ['agint-extra-row']);
  });

  test('缺行判红（防假绿：最核心的一条）', () => {
    const t = targetFile(BASE_ROWS);
    const a = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: present
  name: '@deepseek-ai/dsh-tool-present'`);
    const { report, exitCode } = runJson([`--target-file=only=${t}`, `--agint=only=${a}`]);
    assert.equal(exitCode, 1);
    const missing = report.issues.filter((i) => i.kind === 'missing-row');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].row, 'tool-cordis');
  });

  test('嵌套 cordis:group 的子行也算能力行（漏递归 = 漏三组能力）', () => {
    const t = targetFile(`          - id: planning
            name: cordis:group
            group: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'`);
    const a = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'`);
    const { report, exitCode } = runJson([`--target-file=only=${t}`, `--agint=only=${a}`]);
    assert.equal(exitCode, 1);
    const missing = report.issues.filter((i) => i.kind === 'missing-row').map((i) => i.row).sort();
    // planning 是 group 本身（不是能力），plan-mode 是它 config 里的真能力行 —— 两个都要报出来才算递归到位
    assert.deepEqual(missing, ['plan-mode', 'planning']);
  });

  test('同 id 不同包判红', () => {
    const t = targetFile(BASE_ROWS);
    const a = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: present
  name: '@deepseek-ai/dsh-tool-present'
- id: tool-cordis
  name: '@deepseek-ai/dsh-tool-someone-else'`);
    const { report, exitCode } = runJson([`--target-file=only=${t}`, `--agint=only=${a}`]);
    assert.equal(exitCode, 1);
    const div = report.issues.filter((i) => i.kind === 'package-divergence');
    assert.equal(div.length, 1);
    assert.equal(div[0].row, 'tool-cordis');
  });

  test('上游启用、agint disabled 判红', () => {
    const t = targetFile(BASE_ROWS);
    const a = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: present
  name: '@deepseek-ai/dsh-tool-present'
- id: tool-cordis
  name: '@deepseek-ai/dsh-tool-cordis'
  disabled: true`);
    const { report, exitCode } = runJson([`--target-file=only=${t}`, `--agint=only=${a}`]);
    assert.equal(exitCode, 1);
    const reg = report.issues.filter((i) => i.kind === 'disabled-regression');
    assert.equal(reg.length, 1);
    assert.equal(reg[0].row, 'tool-cordis');
  });

  test('`!!js` 平台表达式按本机求值，不因是真值字符串而假红', () => {
    // 两侧写法完全相同 —— 无论本机是 win32 还是别的平台，都不该报 disabled-regression。
    // 若实现退化成「非空字符串即禁用」，Linux 上这条会红，而它本该是绿的。
    const rows = `          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'`;
    const agintRows = `- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'`;
    const { report, exitCode } = runJson([`--target-file=only=${targetFile(rows)}`, `--agint=only=${agintFile(agintRows)}`]);
    assert.equal(report.critical, 0, `同表达式不该判红：${JSON.stringify(report.issues)}`);
    assert.equal(exitCode, 0);
  });

  test('上游 disabled、agint 启用 = 超集，只报 info 不判红', () => {
    const t = targetFile(`          - id: tool-ralph
            name: '@deepseek-ai/dsh-tool-ralph'
            disabled: true`);
    const a = agintFile(`- id: tool-ralph
  name: '@deepseek-ai/dsh-tool-ralph'`);
    const { report, exitCode } = runJson([`--target-file=only=${t}`, `--agint=only=${a}`]);
    assert.equal(exitCode, 0);
    assert.deepEqual(kinds(report, 'info'), ['superset-row']);
  });

  test('双副本漂移判红（部署位有、仓库没有 = 重装会抹掉）', () => {
    const t = targetFile(BASE_ROWS);
    const full = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: present
  name: '@deepseek-ai/dsh-tool-present'
- id: tool-cordis
  name: '@deepseek-ai/dsh-tool-cordis'`);
    const stale = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'`);
    const { report, exitCode } = runJson([`--target-file=only=${t}`, `--agint=repo=${stale}`, `--agint=deployed=${full}`]);
    assert.equal(exitCode, 1);
    const drift = report.issues.filter((i) => i.kind === 'copy-drift');
    assert.equal(drift.length, 2, 'present 与 tool-cordis 两行都应报漂移');
    assert.ok(drift.every((i) => i.message.includes('部署位有、仓库副本没有')), 'repo=stale 才是「部署位有、仓库没有」那个方向');
  });

  test('两个基线一致时去重，不把 2 条缺口报成 4 条', () => {
    const a = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'`);
    // 两份内容相同的基线（等价于 shipped 与 live 一致），跑两个看是否去重
    const { report } = runJson([
      `--target-file=shipped=${targetFile(BASE_ROWS)}`,
      `--target-file=live=${targetFile(BASE_ROWS)}`,
      `--agint=only=${a}`,
    ]);
    assert.equal(report.targets.length, 2);
    assert.equal(report.targetsAgree, true, '两份基线内容相同，应判定为一致');
    const missing = report.issues.filter((i) => i.kind === 'missing-row');
    assert.equal(missing.length, 2, 'present + tool-cordis 各一条，不因两个基线而翻倍');
    assert.deepEqual(missing[0].targets, ['shipped', 'live']);
  });

  test('两个基线不一致时明确报出来（profile 级 patch 改写了 preset 行）', () => {
    const a = agintFile(`- id: persona
  name: '@deepseek-ai/dsh-persona'`);
    const { report } = runJson([
      `--target-file=shipped=${targetFile(BASE_ROWS)}`,
      `--target-file=live=${targetFile(`          - id: persona
            name: '@deepseek-ai/dsh-persona'`)}`,
      `--agint=only=${a}`,
    ]);
    assert.equal(report.targetsAgree, false, '基线不同不能被静默当成一致');
  });
});

/* ------------------------------------------------------------------ *
 * 当前真实状态
 * ------------------------------------------------------------------ */

describe('本机真实状态', () => {
  let report;
  let exitCode;
  try {
    ({ report, exitCode } = runJson());
  } catch (e) {
    if (e.status === 2) return; // 本机没装 dsh，这组断言不适用
    throw e;
  }

  test('仓库副本已补齐三行（2026-10-01 缺口已闭合）', () => {
    const missingRepo = report.issues
      .filter((i) => i.kind === 'missing-row' && i.copy === 'repo')
      .map((i) => i.row)
      .sort();
    assert.deepEqual(missingRepo, [], `仓库副本不该缺行：${JSON.stringify(missingRepo)}`);
    // 历史：2026-10-01 给部署位补了 command-goal / tool-cordis / present 三行，
    // 仓库副本没跟上 —— 谁按仓库重装一次这三个能力就没了，且无任何报错。
    // 当初这条断言写成「缺三行」的看门狗，补齐后按约定翻转成「已补齐」而不是删掉。
  });

  test('部署副本对上游 cordis 无缺口', () => {
    const missingDeployed = report.issues.filter((i) => i.kind === 'missing-row' && i.copy === 'deployed');
    assert.equal(missingDeployed.length, 0, `部署位不该缺行：${JSON.stringify(missingDeployed)}`);
  });

  test('双副本一致（VERSION 红线：双副本必须同时同步）', () => {
    const drift = report.issues.filter((i) => i.kind === 'copy-drift').map((i) => i.row).sort();
    assert.deepEqual(drift, [], `副本又漂移了：${JSON.stringify(drift)}`);
  });

  test('门禁判绿（exit 0）', () => {
    assert.equal(exitCode, 0, `不该有 critical：${JSON.stringify(report.issues.filter((i) => i.level === 'critical'))}`);
  });
});
