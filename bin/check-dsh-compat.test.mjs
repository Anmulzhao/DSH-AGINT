// bin/check-dsh-compat.test.mjs — 兼容门禁的版本下限判定测试
//
// 修的是什么：checkVersionDrift 里原先自己手搓了一个字符串比较 cmp，把版本号
// 按 [.-] 拆开后逐段 Number()。预发布后缀（-rc.N）拆出的 'rc' 是 NaN，而
// NaN !== NaN 恒真，于是循环在走到后缀段时短路：
//   · 0.1.7-rc.1 vs 自身      → 返回 1（完全相等却判成不等）
//   · 0.1.7-rc.1 vs 0.1.7     → 返回 1（预发布其实低于正式版，判反了）
// 后者是**漏报**：若 VERSION 把 minimum 写成正式版，本机跑 rc 版会被静默放过。
// 改成 semver.compare 后两种情形都恢复正确。
//
// 本测试不 mock checkVersionDrift（它没有 export，加 main 守卫会动脚本执行结构），
// 改为端到端：临时改 VERSION 的 minimum 列 → 真跑脚本 → 读 --json 的 issues。
// 判据覆盖「该红的时候真的会红」，而不只是「现在通过」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(__dirname, 'check-dsh-compat.mjs');
const VERSION = join(REPO_ROOT, 'VERSION');

const ORIGINAL = readFileSync(VERSION, 'utf8');

/**
 * 本机 dsh 真值：向脚本自身要，不在测试里写死。
 *
 * ⛔ 2026-10-19：这里原先硬编码 `'0.2.0-rc.2'`，那是被 findDshRoot() 的 bug 污染的
 * 读数（它命中了包树根 `dsh-runtime/package.json` 而非真正的
 * `node_modules/@deepseek-ai/dsh`）。修 P0 后真值变成 0.2.1-rc.2 ⇒ 5 条测试全红。
 * ⇒ 测试的前提不该复刻被测物的输出，改为**动态取一次**，测试才不会给 bug 当帮凶。
 */
function detectRuntimeVersion() {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', env: process.env });
  assert.ok(r.status === 0 || r.status === 1, `探测真值失败: ${r.status}\n${r.stderr}`);
  const v = JSON.parse(r.stdout).dshVersion;
  assert.ok(typeof v === 'string' && /^\d/.test(v), `探测到的版本不合法: ${v}`);
  return v;
}
const RUNTIME_VERSION = detectRuntimeVersion();

/** 改 VERSION 矩阵首行的 minimum 列，跑一次 --json，还原，返回 issues 列表。 */
function probeWithMinimum(minValue) {
  const lines = ORIGINAL.split('\n');
  const row = lines.findIndex((l) => /^\|\s*v?\d+\.\d+\.\d+\s*\|/.test(l.trim()));
  assert.ok(row >= 0, 'VERSION 里应有一行以 | vX.Y.Z | 开头的矩阵行');
  const cells = lines[row].split('|');
  cells[2] = ` ${minValue} `;
  lines[row] = cells.join('|');
  writeFileSync(VERSION, lines.join('\n'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
      encoding: 'utf8',
      env: process.env,
    });
    // 退出码本身就是判据：有 critical 时脚本按设计返回 1。所以只断言
    // 「不是崩在信号/异常上」（>128 或无 JSON 输出），具体结论读 issues。
    assert.ok(
      r.status === 0 || r.status === 1,
      `脚本应正常退出（0=通过 / 1=有 critical），实际 ${r.status}\n${r.stderr}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.dshVersion,
      RUNTIME_VERSION,
      `前提：本机 dsh 应为 ${RUNTIME_VERSION}（动态探测），否则下面期望值不成立`,
    );
    return { issues: out.issues, critical: out.critical };
  } finally {
    writeFileSync(VERSION, ORIGINAL);
  }
}

const has = (result, kind) => result.issues.filter((i) => i.kind === kind);

// ── 预发布后缀的判定方向（修复的核心）────────────────────────────────────────
test('本机=minimum 且双方都带 rc 后缀 → 不触发 below-minimum', () => {
  // 旧 cmp 在这里返回 1，把「完全相等」判成不等。这条守住下限判定不再误触。
  const r = probeWithMinimum(RUNTIME_VERSION);
  assert.equal(has(r, 'below-minimum').length, 0);
  assert.equal(r.critical, 0, '完全相等不该产生任何 critical');
});

test('minimum 是同号正式版、本机是 rc 版 → 必须触发 below-minimum（防漏报）', () => {
  // 旧 cmp 返回 1（判成不低于）⇒ 静默放过。这条是上次修复的核心防回归。
  // ⚠ 2026-10-19：原先写死 '0.2.0'，但真值已升到 0.2.1-rc.2，而 0.2.1-rc.2 > 0.2.0
  //   ⇒ 该断言会因版本推进而失去意义。改为**从真值推出同号正式版**：
  //   X.Y.Z-rc.N 的正式版即 X.Y.Z，按 semver 恒有 X.Y.Z-rc.N < X.Y.Z。
  const formal = RUNTIME_VERSION.replace(/-.*$/, '');
  assert.notEqual(formal, RUNTIME_VERSION, `前提：真值 ${RUNTIME_VERSION} 需带预发布后缀`);
  const r = probeWithMinimum(formal);
  const issues = has(r, 'below-minimum');
  assert.equal(issues.length, 1, '预发布版低于同号正式版，应报且只报一条');
  assert.equal(issues[0].level, 'critical');
  assert.equal(r.critical, 1, 'critical 计数应随之 +1（脚本退出码也会变 1）');
});

// ── P0 防回归（2026-10-19）：包树根 ≠ 真正的 dsh 包 ──────────────────────────
// 事故：$DSH_HOME/.agint-deps/dsh-runtime/package.json 的 name 也叫
// '@deepseek-ai/dsh'，但它是**包树容器清单**（陈旧 0.2.0-rc.2），真内核在其
// node_modules 下（软链 → kernel-0.2.1，实测 0.2.1-rc.2）。旧实现命中容器就
// return ⇒ 持续假报「版本漂移」。假警报比没警报更坏：真漂移来时会被它淹没。
test('P0：探测到的 dsh 必须来自 node_modules 下那份，不是包树容器清单', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.ok(r.status === 0 || r.status === 1, `脚本应正常退出，实际 ${r.status}\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const root = out.dshRoot ?? '';
  assert.ok(
    /node_modules[\\/]@deepseek-ai[\\/]dsh([\\/]|$)/.test(root),
    `dshRoot 应指向 node_modules 下的 dsh 包，实际: ${root}`,
  );
  assert.ok(
    !/[\\/]dsh-runtime[\\/]?$/.test(root),
    `dshRoot 不得停在包树容器根（那正是旧 bug 的命中位），实际: ${root}`,
  );
});

test('P0：VERSION 声明的 tested 与本机一致时不得报 version-drift', () => {
  // 现状 tested 列带括号注解「0.2.1-rc.2（另于 0.2.0-rc.2 验证）」，
  // 全等字符串比较会把注解当成版本号的一部分 ⇒ 恒报。修复后应为 0 条。
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: process.env,
  });
  const out = JSON.parse(r.stdout);
  const drift = out.issues.filter((i) => i.kind === 'version-drift');
  assert.equal(
    drift.length,
    0,
    `tested 已覆盖本机 ${out.dshVersion}，不应报 drift；实际报了: ${JSON.stringify(drift)}`,
  );
});

// ── 上下界不误伤 ────────────────────────────────────────────────────────────
test('minimum 远低于本机 → 不触发', () => {
  const r = probeWithMinimum('0.1.0');
  assert.equal(has(r, 'below-minimum').length, 0);
  assert.equal(r.critical, 0);
});

test('minimum 远高于本机 → 触发', () => {
  const r = probeWithMinimum('0.3.0');
  assert.equal(has(r, 'below-minimum').length, 1);
  assert.equal(r.critical, 1);
});

// ── 非法输入走降级而不是崩 ───────────────────────────────────────────────────
test('minimum 不是合法 semver → 报 unparsed，且不产生 below-minimum', () => {
  const r = probeWithMinimum('not-a-semver');
  assert.equal(has(r, 'version-matrix-unparsed').length, 1, '应报矩阵无法解析');
  assert.equal(has(r, 'below-minimum').length, 0, '解析不了就不该硬判，更不能崩');
  assert.equal(r.critical, 0, 'info 级不算失败，退出码仍是 0');
});

// ── 测试自身不能污染仓库 ────────────────────────────────────────────────────
test('VERSION 文件已还原，没有残留改动', () => {
  assert.equal(readFileSync(VERSION, 'utf8'), ORIGINAL, '测试必须在 finally 里还原 VERSION');
});
