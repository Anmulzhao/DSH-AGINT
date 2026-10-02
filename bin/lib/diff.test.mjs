// bin/lib/diff.test.mjs —— 自写 unified diff 的正确性测试
//
// ⭐ 核心原则：只测「能生成 diff」的测试等于没测 —— 生成算法千篇一律，
//   错了也「有输出」。真正要证明的是**能还原**，所以本文件重心在：
//   ① 与系统工具（GNU diff / git apply）双向对拍
//   ② apply 往返：生成的 diff 反向应用后必须逐字节等于原文
//   ③ 构造已知错误输入，证明校验器能抓到

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unifiedDiff, applyReverse } from './diff.mjs';

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function tmp() {
  return mkdtempSync(join(tmpdir(), 'diff-test-'));
}

/**
 * 抽出 patch 里的 **hunk 内容行**（排除 `---`/`+++` 文件头、`@@` 行、标记行）。
 *
 * ⭐ 必须按 `@@` 之后的行取，而不是按「首字符」过滤 —— 文件头恰好也以 `-`/`+` 开头。
 */
function hunkContentLines(patch) {
  const out = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === '\ No newline at end of file') continue;
    if (line === '') continue;
    out.push(line);
  }
  return out;
}

/** ⭐ 往返自证：生成 diff → 反向应用 → 必须逐字节等于原文。 */
function roundTrip(before, after) {
  const patch = unifiedDiff(before, after, 'a/x', 'b/x');
  if (patch === '') return before === after;
  const restored = applyReverse(patch, after, 'b/x');
  assert.notEqual(restored, null, `反向应用失败（diff 与目标文件不匹配）\n${patch}`);
  assert.equal(restored, before, `往返不一致\n--- patch ---\n${patch}`);
  return true;
}

// ── 基础形状 ────────────────────────────────────────────────────────────────

test('完全相同 ⇒ 返回空串（不是「一个都没有的 hunk」）', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'a/x', 'b/x'), '');
});

test('单行改动生成一个 hunk，含正确的 @@ 行号', () => {
  const p = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'a/x', 'b/x');
  assert.match(p, /^--- a\/x\n\+\+\+ b\/x\n/);
  assert.match(p, /@@ -1,3 \+1,3 @@/);
  assert.match(p, /^-b$/m);
  assert.match(p, /^\+B$/m);
});

test('新增文件：before 为空 ⇒ 全部是 + 行', () => {
  const p = unifiedDiff('', 'x\ny\n', '/dev/null', 'b/new');
  assert.match(p, /^\+x$/m);
  assert.match(p, /^\+y$/m);
  // ⭐ 判「无删除行」必须**只看 hunk 内容行**：文件头 `--- a/f` 也以 `-` 开头。
  //   第一版用 /^-/m 直接判 ⇒ 头行永远命中 ⇒ 这条测试从写下来就是红的；
  //   第二版用 /^[ +-]/ 也不行，`+++ b/new` 同样命中。判据见 hunkContentLines。
  const hunkLines = hunkContentLines(p);
  assert.ok(hunkLines.every((l) => !l.startsWith('-')), `不该有删除行：\n${p}`);
  // 标准 unified diff 语义：空侧行号为 0
  assert.match(p, /^@@ -0,0 \+1,2 @@$/m);
});

test('删除文件：after 为空 ⇒ 全部是 - 行', () => {
  const p = unifiedDiff('x\ny\n', '', 'a/old', '/dev/null');
  assert.match(p, /^-x$/m);
  const hunkLines = hunkContentLines(p);
  assert.ok(hunkLines.every((l) => !l.startsWith('+')), `不该有新增行：\n${p}`);
  // after 侧空 ⇒ + 侧行号 0、计数 0（标准 unified diff 形式，`git apply` 认）
  assert.match(p, /^@@ -1,2 \+0,0 @@$/m);
});

test('末尾无换行时最后一行仍能被检出（CRLF/换行尾处理）', () => {
  const p = unifiedDiff('a\nb', 'a\nB', 'a/x', 'b/x');
  assert.match(p, /^-b$/m);
  assert.match(p, /^\+B$/m);
});

test('CRLF 输入按行比对，不因 \\r 产生假差异', () => {
  const p = unifiedDiff('a\r\nb\r\n', 'a\r\nb\r\n', 'a/x', 'b/x');
  assert.equal(p, '', '只有行尾符差异（\\r）不应算作内容变化');
});

// ── 往返自证（重心）────────────────────────────────────────────────────────

test('往返：单行改', () => roundTrip('a\nb\nc\n', 'a\nB\nc\n'));
test('往返：中间插入两行', () => roundTrip('a\nb\nc\n', 'a\nx\ny\nb\nc\n'));
test('往返：中间删除两行', () => roundTrip('a\nx\ny\nb\nc\n', 'a\nb\nc\n'));
test('往返：首行改动', () => roundTrip('a\nb\nc\nd\ne\nf\ng\n', 'A\nb\nc\nd\ne\nf\ng\n'));
test('往返：尾行改动', () => roundTrip('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nd\ne\nf\nG\n'));
test('往返：空→有内容', () => roundTrip('', 'a\nb\n'));
test('往返：有内容→空', () => roundTrip('a\nb\n', ''));
test('往返：两侧都空', () => roundTrip('', ''));
test('往返：全部行都改', () => roundTrip('a\nb\nc\n', 'x\ny\nz\n'));

test('往返：多个分散 hunk 不互相吞并', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n') + '\n';
  const after = before.replace('line-2', 'CHANGED-A').replace('line-35', 'CHANGED-B');
  const p = unifiedDiff(before, after, 'a/x', 'b/x');
  assert.equal((p.match(/^@@/gm) || []).length, 2, '应生成两个独立 hunk');
  roundTrip(before, after);
});

test('往返：相邻改动必须合并成一个 hunk（不能共享上下文行）', () => {
  // 改动行相距 4，context=3 ⇒ 若按「重叠」判据会错误合成两个 hunk，
  // 而 patch 应用时共享上下文会重复应用 ⇒ 这是真实会出错的形态。
  const before = Array.from({ length: 30 }, (_, i) => `L${i}`).join('\n') + '\n';
  const after = before.replace('L10', 'X').replace('L14', 'Y');
  const p = unifiedDiff(before, after, 'a/x', 'b/x');
  assert.equal((p.match(/^@@/gm) || []).length, 1, '距离 ≤ 2×context 的改动应合并');
  roundTrip(before, after);
});

test('往返：重复行（diff 的经典陷阱，LCS 可能给出合法但不同的对齐）', () => {
  roundTrip('x\nx\nx\ny\nx\n', 'x\ny\nx\nx\nx\n');
});

test('往返：中文与 Emoji（多字节，测按字节/按字符切分是否一致）', () => {
  roundTrip('中文第一行\n中文第二行\n😀😀😀\n', '中文第一行\n中文改行\n😀😀😀\n');
});

// ── 与系统工具交叉验证 ─────────────────────────────────────────────────────

test('⛔ 与 GNU diff 交叉：生成的 diff 能被系统 diff 认可为「有变化」', () => {
  const r = spawnSync('diff', ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return; // 无 diff 命令则跳过（不假装通过）
  const d = tmp();
  try {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nB\nc\nd\nE\n';
    writeFileSync(join(d, 'before'), before);
    writeFileSync(join(d, 'after'), after);
    const sys = spawnSync('diff', ['-u', 'before', 'after'], { cwd: d, encoding: 'utf8' });
    assert.equal(sys.status, 1, '系统 diff 应报告「有差异」（exit 1）');
    const mine = unifiedDiff(before, after, 'before', 'after');
    // 系统 diff 的 hunk 数应与我的一致 —— 说明切分粒度相同
    const sysHunks = (sys.stdout.match(/^@@/gm) || []).length;
    const myHunks = (mine.match(/^@@/gm) || []).length;
    assert.equal(myHunks, sysHunks, `hunk 数不一致\n系统:\n${sys.stdout}\n我的:\n${mine}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('⛔ 与 git apply 交叉：git 能用我的 diff 反向还原文件', () => {
  if (!HAS_GIT) return;
  const d = tmp();
  try {
    const before = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n';
    const after = before.replace('beta', 'BETA').replace('zeta\n', 'zeta\nomega\n');
    const patch = unifiedDiff(before, after, 'a/f.txt', 'b/f.txt');
    assert.notEqual(patch, '', '前提：确实有差异');
    assertGitApplyRoundTrip(d, before, after, patch);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/** 用真实 `git apply -R` 验证 diff 往返。断言逐字节还原。 */
function assertGitApplyRoundTrip(dir, before, after, patch) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), after);
  writeFileSync(join(dir, 'p.patch'), patch);
  const ap = spawnSync('git', ['apply', '-R', '--whitespace=nowarn', 'p.patch'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const got = readFileSync(join(dir, 'f.txt'), 'utf8');
  assert.equal(ap.status, 0, `git apply -R 失败：${ap.stderr}\n--- patch ---\n${patch}`);
  assert.equal(got, before, 'git 反向应用后内容应与原文逐字节一致');
}

/**
 * ⛔⭐ 回归：before 无末尾换行 + before/after 共享同一末行内容。
 *
 * 这就是 10-03 真实导出时 `git apply` 报
 * 「patch does not apply at bin/plugin-check.sh:464」的形态：
 *
 *   before = "…\nlastline"          （无末尾 \n）
 *   after  = "…\nlastline\n新增一段"  （末行内容与 before 的末行**相同**）
 *
 * 标记的判据若写成「内容 == 末行内容」，就会把 `\ No newline at end of file`
 * 挂到 hunk 里的**上下文行**后面而不是 `aLast` 那一行 ⇒ git apply 拒绝。
 *
 * ⭐ 为什么此前的往返自检没抓到：applyReverse 由**自己的行号推进**驱动，
 *   完全不看标记挂在哪一行 ⇒ 自己验自己，验的是自己的实现而不是标准格式。
 *   所以这条必须用真 `git apply` 对拍，不能只跑 roundTrip。
 */
test('⛔⭐ git apply 交叉：无末尾换行 + 末行内容与 after 相同', () => {
  if (!HAS_GIT) return;
  const d = tmp();
  try {
    const before = 'l1\nl2\nl3\nlast';            // 无末尾换行
    const after = 'l1\nl2\nl3\nlast\nappended\n'; // last 内容不变，后面追加
    const patch = unifiedDiff(before, after, 'a/f.txt', 'b/f.txt');
    // ⭐ 标记必须挂在 **`-last`**（before 侧末行的**删除行**）之后。
    //   为什么是删除行而不是上下文行：末行的「内容」没变、变的是「有没有末尾换行」，
    //   标准 unified diff 把这种行拆成 `-old` + 标记 / `+new` 两行。
    //   若保留成上下文行 ` last` 再挂标记，git 会读成「after 的 last 也无末尾换行」
    //   而实际有 ⇒ 整块 hunk 被拒（真实导出报 bin/plugin-check.sh:464）。
    const lines = patch.split('\n');
    const markIdx = lines.indexOf('\\ No newline at end of file');
    assert.ok(markIdx > 0, `patch 必须含无末尾换行标记：\n${patch}`);
    assert.equal(
      lines[markIdx - 1],
      '-last',
      `标记必须挂在 before 侧末行的删除行之后，实际挂在「${lines[markIdx - 1]}」之后`,
    );
    assertGitApplyRoundTrip(d, before, after, patch);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('⛔ git apply 交叉：多个 hunk（行号必须各自定位，不能都停在 1）', () => {
  if (!HAS_GIT) return;
  const d = tmp();
  try {
    const before = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n') + '\n';
    const after = before.replace('line5', 'FIVE').replace('line50', 'FIFTY');
    const patch = unifiedDiff(before, after, 'a/f.txt', 'b/f.txt');
    assert.equal((patch.match(/^@@/gm) || []).length, 2);
    assertGitApplyRoundTrip(d, before, after, patch);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('⛔ git apply 交叉：文件末尾的改动（before 行数远小于 after）', () => {
  if (!HAS_GIT) return;
  const d = tmp();
  try {
    // before 331 行 / after 489 行 —— 真实 bin/plugin-check.sh 的形态
    const before = Array.from({ length: 331 }, (_, i) => `L${i}`).join('\n') + '\n';
    const after = before + Array.from({ length: 158 }, (_, i) => `NEW${i}`).join('\n') + '\n';
    const patch = unifiedDiff(before, after, 'a/f.txt', 'b/f.txt');
    assertGitApplyRoundTrip(d, before, after, patch);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * ⛔⭐⭐ 10-03 真实导出最终形态：before 与 after **都无末尾换行**，末行内容相同。
 *
 * 这是 `bin/plugin-check.sh` 的真实形态，也是本轮最后抓到的那个 bug：
 *   before = "…\nesac\n\necho \"─── … ───\""     （无末尾 \n）
 *   after  = "…\nesac\n\necho \"─── … ───\"\n…\nfi"（也无末尾 \n）
 *
 * ⛔ 触发条件写错的地方：修「末行强制拆分」时，条件被写成
 *   `A.trailingNewline !== B.trailingNewline`（两侧**不同**才拆）——
 *   而这里两侧**都是无末尾换行**（相同）⇒ 不拆 ⇒ 末行留成上下文行
 *   ⇒ `git apply` 报「patch does not apply at bin/plugin-check.sh:464」。
 *
 * ⭐ 正确判据：**「任一侧无末尾换行」**（与另一侧无关）。
 *
 * 固化两件事：① hunk 头必须与 `git diff --no-index` 逐字一致；
 *            ② `git apply -R` 退出码 0 且还原后逐字节等于 before。
 */
test('⛔⭐⭐ git apply 交叉：两侧都无末尾换行 + 末行内容相同（真实 bin/plugin-check.sh 形态）', () => {
  if (!HAS_GIT) return;
  const d = tmp();
  try {
    const head = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const last = 'echo "─── 完成 ───"';
    const before = `${head}\n${last}`; // 无末尾换行
    const after = `${head}\n${last}\n${Array.from({ length: 20 }, (_, i) => `new ${i}`).join('\n')}\nfi`; // 也无末尾换行
    assert.ok(!before.endsWith('\n') && !after.endsWith('\n'), '前提：两侧都无末尾换行');

    const patch = unifiedDiff(before, after, 'a/f.txt', 'b/f.txt');

    // ① 末行必须被拆成 `-` / `+`（不能留作上下文行）
    assert.ok(
      patch.includes(`-${last}\n\\ No newline at end of file\n+${last}`),
      `末行必须拆成 -/+ 对并挂标记，实际 patch：\n${patch}`,
    );

    // ② hunk 头与 git 自己的输出一致（对着真实文件跑 git diff 逐字比）
    //    ⭐ 只比**行号与计数**：`@@ -a,b +c,d @@` 后面的「函数名上下文」是 git
    //    扫描源码猜出来的可选装饰（它认出了「line 36」这段），不是格式要求。
    //    比全文会把「我少写了个装饰」误判成格式错。
    writeFileSync(join(d, 'before'), before);
    writeFileSync(join(d, 'after'), after);
    const gitPatch = spawnSync('git', ['diff', '--no-index', 'before', 'after'], {
      cwd: d,
      encoding: 'utf8',
    }).stdout;
    const hunkSpec = (l) => {
      const m = l.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      return m ? `-${m[1]},${m[2]} +${m[3]},${m[4]}` : `UNPARSED:${l}`;
    };
    const mineHunks = patch.split('\n').filter((l) => l.startsWith('@@')).map(hunkSpec);
    const gitHunks = gitPatch.split('\n').filter((l) => l.startsWith('@@')).map(hunkSpec);
    assert.deepEqual(
      mineHunks,
      gitHunks,
      `hunk 头的行号/计数必须与 git 一致\n我的:\n${mineHunks.join('\n')}\ngit:\n${gitHunks.join('\n')}\n完整 patch:\n${patch}`,
    );

    // ③ git apply -R 真能还原
    rmSync(join(d, 'before'));
    rmSync(join(d, 'after'));
    assertGitApplyRoundTrip(d, before, after, patch);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── ⛔ 校验器必须能抓到错 ──────────────────────────────────────────────────

test('⛔ applyReverse 对上下文不匹配的 patch 必须返回 null（不能瞎猜）', () => {
  const patch = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'a/x', 'b/x');
  // 喂一个与 patch 毫无关系的目标文件
  const wrong = applyReverse(patch, 'totally\ndifferent\ncontent\n', 'b/x');
  assert.equal(wrong, null, '上下文不匹配时必须失败，不能返回半成品');
});

test('⛔ applyReverse 对 label 不匹配的 patch 必须返回 null', () => {
  const patch = unifiedDiff('a\nb\n', 'a\nB\n', 'a/x', 'b/x');
  assert.equal(applyReverse(patch, 'a\nB\n', 'b/OTHER'), null);
});

test('⛔ applyReverse 对损坏的 @@ 行必须返回 null（不能静默跳过）', () => {
  assert.equal(applyReverse('--- a/x\n+++ b/x\n@@ 这不是行号 @@\n', 'a\n', 'b/x'), null);
});

test('⛔ applyReverse 对 hunk 起点早于已消费位置必须返回 null（防重复应用）', () => {
  // 手造一个重叠 hunk：第二个 @@ 的起点落在第一个已消费之后
  const patch = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -1,2 +1,2 @@', ' a', '-c', '+C'].join('\n');
  assert.equal(applyReverse(patch, 'a\nB\nC\n', 'b/x'), null);
});

test('超长输入走降级路径时仍必须往返正确（诚实降级 ≠ 结果错）', () => {
  const before = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = before.replace('line 1000', 'CHANGED');
  const p = unifiedDiff(before, after, 'a/x', 'b/x', 3);
  assert.ok(p.length > 0, '超长输入也应产出 diff');
  roundTrip(before, after);
});