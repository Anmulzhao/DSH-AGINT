// bin/lib/diff.mjs —— 零依赖 unified diff 生成（Phase 3 交付物三 Tier B）
//
// 为什么自己写：diff 需要 LCS 算法，npm 上的实现都违反仓库零依赖纪律
//（docs/zero-deps-allowlist.json + check-zero-deps.mjs）。
// 用系统 `diff` 命令更省事，但 Windows 的 diff 与 GNU diff 参数/输出格式不兼容，
// 且导出包的接收方可能没有 diff —— **包里必须自包含**。
//
// ⚠️ 与系统 diff 交叉验证是硬要求（tar.mjs 的 PAX 长度 bug 就是自写实现
//   与系统工具对拍才发现的）。见 diff.test.mjs。

/** 把文本切成行。⭐ 末尾换行必须单独处理，否则最后一行会被算成改动。 */
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  // split 后末尾若是空串，说明原文以 \n 结尾 ⇒ 去掉它，行数才与 diff 语义一致
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * 行尾信息：行内容 + 两侧是否以换行结尾。
 *
 * ⭐ 为什么必须单独携带：**「逐字节还原」是 R1 的实际含义**，而行尾符属于字节。
 *   只靠行数组还原，末尾有没有 \n 的信息已经丢了 —— 往返测试会在
 *   `assert.equal` 上因为差一个 `\n` 而红，看起来像算法错，其实是信息丢失。
 *   修法不是放宽测试，而是把丢失的信息补回来。
 */
function slice(text) {
  return { lines: splitLines(text), trailingNewline: text.endsWith('\n') };
}

/**
 * 最长公共子序列（DP 表）。
 *
 * ⭐ 复杂度取舍：O(n·m) 时间与内存。大文件（>2000 行）时 DP 表会吃掉上百 MB，
 *   所以对超长输入降级为「整块替换」—— 诚实降级，不假装做了精细 diff。
 *   判据是**能不能做**，不是「做得快不快」。
 */
function lcsMatrix(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** 单个 hunk：{ start, lines }（行号从 1 起，lines 前缀为 ' ' / '-' / '+'）。 */
/** 单个 hunk：双侧起始行号 + 内容行（行号从 1 起；空侧为 0）。 */
function hunk(oldStart, lines, newStart) {
  return { oldStart, newStart, lines };
}

/**
 * 生成 unified diff。
 *
 * @param {string} before 变更前内容
 * @param {string} after  变更后内容
 * @param {string} beforeLabel a/ 侧的标签
 * @param {string} afterLabel  b/ 侧的标签
 * @param {number} context   每个 hunk 前后保留的上下文行数
 */
export function unifiedDiff(before, after, beforeLabel, afterLabel, context = 3) {
  const A = slice(before);
  const B = slice(after);
  const a = A.lines;
  const b = B.lines;

  // 完全相同 ⇒ 无 diff。⭐ 必须显式返回空串：空串与「文件不存在」是不同语义，
  // 导出器据此决定是列进「无改动」还是「新增/删除」。
  if (a.length === b.length && a.every((x, i) => x === b[i]) && A.trailingNewline === B.trailingNewline) return '';

  const MAX_LINES = 2000;
  let ops;
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // 降级：整块替换。**明确标注**，接收方看到就知道这不是精细 diff。
    ops = [
      ...a.map((l) => ({ type: '-', text: l })),
      ...b.map((l) => ({ type: '+', text: l })),
    ];
  } else {
    ops = diffOps(a, b);
    // ⭐⭐ 末尾换行属性变化的那一行，必须强制拆成 `-旧` / `+新`。
    //
    //   before = "…\nlast"     （无末尾换行）
    //   after  = "…\nlast\n…"   （有末尾换行）
    //
    //   两者**最后一行内容完全相同**，LCS 判定「这行未改」⇒ 输出里它是上下文行
    //   ` last`，后面跟一个 `\ No newline at end of file`。
    //   但 `git apply` 的语义是：标记描述的是**紧邻其上的那一行在该侧是否有末尾换行**。
    //   它在上下文行上加标记 ⇒ 认为 after 的 `last` 也无末尾换行，
    //   而 after 的 `last` 其实有 ⇒ **整块 hunk 被拒**（真实导出时报
    //   「patch does not apply at bin/plugin-check.sh:464」）。
    //
    // ⭐⭐ 涉及「无末尾换行」的那一行，必须强制拆成 `-旧` / `+新`。
    //
    //   触发条件不是「两侧 trailingNewline 不同」，而是
    //   **「任一侧无末尾换行，且该侧末行在 ops 里是上下文行」**。
    //   ⛔ 第一版写的是 `A.trailingNewline !== B.trailingNewline` ——
    //   而真实场景 before 无、after 也无末尾换行（两侧相同！）⇒ 条件不成立 ⇒ 不拆
    //   ⇒ `git apply` 报「patch does not apply at bin/plugin-check.sh:464」。
    //
    //   为什么必须拆：\ No newline 标记的语义是「紧邻其上的那一行**在该侧**
    //   没有末尾换行」。若该行是上下文行（两侧共用），标记就无法只描述一侧
    //   ⇒ 标准做法是把它拆成 `-old` + 标记 + `+old`，各自带自己的换行属性。
    //   git 的真实输出正是如此（实测 `git diff --no-index`）：
    //     @@ -329,4 +463,28 @@
    //      esac
    //
    //     -echo "─── … ───"
    //     \ No newline at end of file
    //     +echo "─── … ───"
    if (a.length > 0 && b.length > 0) {
      // 找 ops 里所有「内容 == before 末行」的上下文行（可能多处，取靠后的）
      const aLastText = a[a.length - 1];
      const needsSplit = (!A.trailingNewline || !B.trailingNewline)
        && ops.some((o) => o.type === ' ' && o.text === aLastText);
      if (needsSplit) {
        // 从后往前替换：每一处匹配都拆成 -/+ 对
        for (let i = ops.length - 1; i >= 0; i--) {
          if (ops[i].type === ' ' && ops[i].text === aLastText) {
            ops.splice(i, 1, { type: '-', text: aLastText }, { type: '+', text: aLastText });
          }
        }
      }
    }
  }

  const hunks = groupHunks(ops, context, a.length, b.length);
  if (hunks.length === 0) return '';

  const out = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  // 记录哪些行的「原始形态无末尾换行」—— 前置条件：before / after 各自的最后一行
  const aLast = a.length ? a[a.length - 1] : null;
  const bLast = b.length ? b[b.length - 1] : null;

  // ⭐⭐ 两侧行号由 groupHunks 独立算出（它掌握 hunk 之间的间隔）。第一版在拼输出时重算 ⇒
  //   第二个 hunk 输出 `@@ -330,3 +1,27 @@`（真实位置在文件尾部），
  //   任何 apply 实现都会拒绝 —— 而且**只在有 2 个以上 hunk 时才炸**，
  //   单 hunk 的测试全绿 ⇒ 典型的「测试没覆盖到真实形态」。
  //   判据：`+` 侧的起始号 = 该 hunk 之前 ' '/'+' 行的总数（跨 hunk 累计）。

  for (const h of hunks) {
    const oldCount = h.lines.filter((l) => l[0] !== '+').length;
    const newCount = h.lines.filter((l) => l[0] !== '-').length;
    // ⭐ 行号直接用 groupHunks 算好的双侧起始号。它在那里已经把
    //   「hunk 之间的未改动间隔」推进进游标了 —— 这里**不能**再推一遍，
    //   也不需要从 hunk 内容反推（拼输出时看不到此前 hunk 吃掉了多少行，
    //   那正是第一版第二个 hunk 行号停在 1 的根因）。
    out.push(`@@ -${Math.max(0, h.oldStart)},${oldCount} +${Math.max(0, h.newStart)},${newCount} @@`);
    // 逐行推进两侧行号，标记必须挂在**该侧实际的那一行**之后。
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (const l of h.lines) {
      out.push(l);
      const t = l[0];
      const text = l.slice(1);
      // ⭐⭐ 标记的判据是「**行号等于该侧末行**」，不是「内容等于末行内容」。
      //   内容判据在真实文件上抓到了错位：before 与 after 的末行内容都是
      //   `echo "─── plugin-check 完成…"`（同一行未改，只是它后面追加了新内容），
      //   于是标记被挂到了**上下文行**后面，而它属于 `aLast` —— 结果
      //   `git apply` 报「patch does not apply at bin/plugin-check.sh:464」。
      //   ⛔ 教训与 tar.mjs 的 PAX 长度 bug 同型：**自写实现必须与标准工具对拍**，
      //   往返自检（我自己写的 apply）用行号驱动、不校验标记位置，所以放过了。
      if (!A.trailingNewline && (t === ' ' || t === '-') && oldNo === a.length) {
        out.push(NO_NEWLINE_MARK);
      }
      if (!B.trailingNewline && (t === ' ' || t === '+') && newNo === b.length) {
        out.push(NO_NEWLINE_MARK);
      }
      if (t === ' ' || t === '-') oldNo++;
      if (t === ' ' || t === '+') newNo++;
    }
  }
  return `${out.join('\n')}\n`;
}

/** 逐行求最短编辑脚本。 */
function diffOps(a, b) {
  const dp = lcsMatrix(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', text: a[i] });
      i++;
    } else {
      ops.push({ type: '+', text: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ type: '-', text: a[i++] });
  while (j < b.length) ops.push({ type: '+', text: b[j++] });
  return ops;
}

/** 把编辑脚本按上下文切成 hunk（合并距离 ≤ 2·context 的相邻改动）。 */
function groupHunks(ops, context, totalBefore = 0, totalAfter = 0) {
  const changed = ops.map((o, i) => (o.type === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return [];
  let prevTo = -1;

  const ranges = [];
  for (const idx of changed) {
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    // ⭐ 判重叠用 `to <= last.to` 而不是 `from <= last.to + 1`：
    //   差一行时两个 hunk 会共享一行上下文，patch 可能应用失败或重复应用。
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
    } else {
      ranges.push({ from, to });
    }
  }

  // ⭐ 每个 hunk 必须携带**双侧**起始行号，且都由「从 ops[0] 数到 from」得出。
  //   两侧都推进，但推进的规则不同：' '/'-' 占 before 位，' '/'+' 占 after 位。
  //   为什么必须在 groupHunks 里算好、不能在拼输出时算：拼输出时只能看到
  //   当前 hunk 的内容，看不到「此前 hunk 吃掉了多少行」—— 第一版正是在那里
  //   漏算间隔，于是第二个 hunk 的行号停在前一个 hunk 末尾（真实文件必炸）。
// ⭐⭐ 一次遍历求双侧行号，**不**在 hunk 边界上来回推游标。
//   前几版的错都在这里：hunk 内容与 hunk 之间的间隔分两段推进，两段的初值对不齐，
//   于是「第二个 hunk」与「文件末尾的 hunk」起始号停在 1 ——
//   **只在有 2 个以上 hunk、或改动落在文件尾时才炸**，单 hunk 小样本测试全绿。
//
//   正确做法：先算出「before 侧行号」与「after 侧行号」的前缀和数组，
//   任意 hunk 的起始号都是 O(1) 查表，且两侧**各自独立**。
//     oldLineOf[i] = ops[0..i-1] 中 ' '/'-' 的条数（+ 空侧偏移）
//     newLineOf[i] = ops[0..i-1] 中 ' '/'+' 的条数
const oldLineOf = new Array(ops.length + 1);
const newLineOf = new Array(ops.length + 1);
const oldBase = totalBefore === 0 ? 0 : 1;
const newBase = totalAfter === 0 ? 0 : 1;
oldLineOf[0] = oldBase;
newLineOf[0] = newBase;
for (let k = 0; k < ops.length; k++) {
  const o = ops[k];
  oldLineOf[k + 1] = oldLineOf[k] + (o.type === ' ' || o.type === '-' ? 1 : 0);
  newLineOf[k + 1] = newLineOf[k] + (o.type === ' ' || o.type === '+' ? 1 : 0);
}

return ranges.map(({ from, to }) => {
    const lines = [];
    for (let k = from; k <= to; k++) lines.push(`${ops[k].type}${ops[k].text}`);
    return hunk(oldLineOf[from], lines, newLineOf[from]);
  });
}

/**
 * 反向应用 unified diff —— 用于**验证**生成的 diff 真能还原。
 *
 * ⭐ 这是本模块存在价值的关键：能生成 diff 的实现很多，能证明 diff 正确的很少。
 *   「接收方 apply 后得到原文件」才是 R1 的实际含义。
 *   导出器在打包前跑一遍 apply 往返，不一致就拒绝出包。
 *
 * @returns {string|null} 还原后的内容；null 表示**应用失败**（上下文不匹配）
 */
export function applyReverse(patch, after, afterLabel) {
  const lines = patch.split('\n');
  // 取 after 的行作为基准
  const target = splitLines(after);
  const result = [];

  // patch 里 `+++ <label>` 之后才是 hunk
  let i = lines.findIndex((l) => l.startsWith(`+++ ${afterLabel}`));
  if (i < 0) return null;
  i++;

  let cursor = 0; // target 已消费到哪一行（0 起）
  let ok = true;
  // 收集「无末尾换行」标记所附着的行内容：反向还原时据此决定要不要补 \n
  const noNewlineAtEnd = new Set();

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('@@')) {
      i++;
      continue;
    }
    const m = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    if (!m) {
      ok = false;
      break;
    }
    // ⭐ 必须读 **+ 侧**（`m[3]`）行号，不是 - 侧：applyReverse 消费的是 after，
//   游标 `cursor` 也是 after 的下标。用 - 侧定位 ⇒ 一旦 before/after 行数不同
//   （真实文件几乎必然如此），跳过行数就错 ⇒ 还原失败或错位还原。
//   ⛔ 第一版读的是 m[1]，单 hunk 且两侧等长时恰好正确 —— 真实文件一改就炸。
    const afterStart = parseInt(m[3], 10);
    // 把 hunk 起点之前的未改动行原样搬过去。
    // 行号 0 表示该侧为空（标准 unified diff 语义），此时跳过 0 行。
    const skip = (afterStart === 0 ? 0 : afterStart - 1) - cursor;
    if (skip < 0) {
      ok = false;
      break;
    }
    for (let k = 0; k < skip; k++) result.push(target[cursor++]);
    i++;

    // 逐行处理 hunk 内容直到下一个 @@
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const h = lines[i];
      // ⭐ 标记行必须**在**循环开头单独处理：它的首字符是 `\`，
      //   若混进下面的 type 分派里会被当成一种 hunk 行 ⇒ 结果错但不报错。
      if (h === NO_NEWLINE_MARK) {
        const last = result[result.length - 1];
        if (last !== undefined) noNewlineAtEnd.add(last);
        i++;
        continue;
      }
      const type = h[0];
      const text = h.slice(1);
      if (type === ' ') {
        // 上下文行在 before/after 里相同，必须与目标一致
        if (target[cursor] !== text) {
          ok = false;
          break;
        }
        result.push(text);
        cursor++;
      } else if (type === '+') {
        // ⭐ 反向：这一行是 patch 加进 after 的 ⇒ after 里有、before 里没有。
        //   **必须消费掉它**，且必须与 target 逐字节相等 —— 不等就说明
        //   patch 与 after 不是同一份数据的两个版本，失败比瞎猜好。
        if (target[cursor] !== text) {
          ok = false;
          break;
        }
        cursor++;
      } else if (type === '-') {
        // 反向：这一行是 patch 从 before 删掉的 ⇒ after 里没有、before 里要加回来。
        //   **不消费 target**（反向的第一版错在这里：去比对 target[cursor]，
        //   而此刻 target[cursor] 是紧随其后的 '+' 行内容 ⇒ 全部往返失败）。
        result.push(text);
      }
      i++;
    }
    if (!ok) break;
  }

  if (!ok) return null;
  // 收尾：hunk 之后的剩余行原样保留
  while (cursor < target.length) result.push(target[cursor++]);
  // ⭐ 空结果 = 空文件。**空文件没有「末尾换行」这回事**，
  //   补一个 \n 会得到「一个空行」而非「零字节」—— 差 1 字节就不是逐字节还原。
  if (result.length === 0) return '';
  // 末尾换行信息**来自 patch 自身**，不靠猜。
  //   判据：patch 里的 `\ No newline at end of file` 标记若附着在 result 最后一行，
  //   说明 before 侧原本无末尾换行；否则有。
  const resultNoTrailingNewline = noNewlineAtEnd.has(result[result.length - 1]);
  return result.join('\n') + (resultNoTrailingNewline ? '' : '\n');
}

/**
 * 无末尾换行的「标记行」—— 标准 unified diff 的做法，git / GNU patch 都认。
 *
 * ⭐ 为什么必须显式标记而不是在 JS 内部悄悄记住：
 *   「逐字节还原」是 R1 的实际含义，而末尾换行属于字节。
 *   不编码进 patch，接收方（可能是任何语言的 apply 实现）就丢了这个信息。
 *   用**通用格式**而不是自定义约定，是为了能交给 `git apply` / `patch` 直接用。
 */
const NO_NEWLINE_MARK = '\\ No newline at end of file';