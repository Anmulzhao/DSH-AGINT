/**
 * EPERM 占用窗口测定探针（2026-09-21）
 *
 * 目的：回答一个具体问题 —— 当 rename 撞上 EPERM 时，**要等多久才能成功**？
 *       这个数字直接决定 `renameWithRetry` 的 delays 该设多长。
 *
 * 与 `_ab_rename_strict.mjs` 的差别：那个测「5 次尝试够不够」；
 * 这个测「第一次 EPERM 之后的成功延迟分布」，并用**激进重试直到成功**把窗口量出来。
 *
 * 手法：
 *   - 真实 skills_root（不是 tmp 目录 —— 那测不出 watcher 占用）
 *   - 每轮：建 tmp 目录 → 写 SKILL.md/manifest.json → 立刻 rename
 *   - 撞 EPERM 后：**每 25ms 重试一次，直到成功或超 60s**，记录等待毫秒数
 *   - 每轮结束后清掉目标，避免占用累积
 *
 * 安全：只写 `.probe-*` 前缀 + `zzprobe*` 目标名；跑完自清。不做任何生产数据改动。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SKILLS = 'C:/Users/Administrator/.dsh/.agent-presets/agint/skills';
const RUN = String(process.argv[2] ?? Date.now()).slice(-6);
const N = Number(process.argv[3] ?? 60);

if (!fs.existsSync(SKILLS)) {
  console.error('skills_root 不存在:', SKILLS);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s = '') => console.log(s);

/** 一次尝试：建 tmp + 写文件 + rename(带激进重试)。返回第一次尝试的结果与成功等待。 */
async function one(i) {
  const name = `zzprobe-${RUN}-e${i}`;
  const tmp = path.join(SKILLS, `.probe-${RUN}-${i}.tmp`);
  const target = path.join(SKILLS, name);
  if (fs.existsSync(target)) throw new Error(`harness bug: target exists ${target}`);

  await fsp.mkdir(tmp, { recursive: true });
  await fsp.writeFile(path.join(tmp, 'SKILL.md'), 'probe stub (invalid skill)\n', 'utf8');
  await fsp.writeFile(path.join(tmp, 'manifest.json'), '{"probe":true}\n', 'utf8');

  // 第一次尝试 —— 记下是否撞错
  const t0 = Date.now();
  try {
    await fsp.rename(tmp, target);
    await cleanup(target);
    return { first: 'ok', waitMs: 0, polls: 0 };
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') {
      await cleanup(target, tmp);
      return { first: 'other', code: e.code, waitMs: 0, polls: 0 };
    }
    // 撞上瞬时占用 —— 每 25ms 探一次，量出窗口
    for (let poll = 1; poll <= 2400; poll++) {   // 2400 * 25ms = 60s 上限
      await sleep(25);
      try {
        await fsp.rename(tmp, target);
        const waitMs = Date.now() - t0;
        await cleanup(target);
        return { first: e.code, waitMs, polls: poll };
      } catch (e2) {
        if (e2.code !== 'EPERM' && e2.code !== 'EBUSY' && e2.code !== 'EACCES') {
          await cleanup(target, tmp);
          return { first: e.code, then: e2.code, waitMs: Date.now() - t0, polls: poll };
        }
      }
    }
    await cleanup(target, tmp);
    return { first: e.code, waitMs: -1, polls: 2400 };   // 超 60s 仍未成功
  }
}

async function cleanup(target, tmp) {
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

line('='.repeat(78));
line(`EPERM 占用窗口测定 — 真实 skills_root，run=${RUN}，${N} 轮`);
line(`目标目录: ${SKILLS}`);
line('='.repeat(78));

const stats = { clean: 0, hit: [], other: [], timeout: 0 };
for (let i = 0; i < N; i++) {
  const r = await one(i);
  if (r.first === 'ok') stats.clean++;
  else if (r.waitMs === -1) { stats.timeout++; line(`  [${i}] ⚠️ ${r.first} → 60s 内未成功`); }
  else if (r.first === 'other' || r.then) stats.other.push(r);
  else {
    stats.hit.push(r);
    line(`  [${i}] ${r.first} 撞上 → 等待 ${r.waitMs}ms（第 ${r.polls} 次探测）成功`);
  }
}

line('');
line('─'.repeat(78));
line(`  一次成功（未撞占用）: ${stats.clean}/${N}  (${(stats.clean / N * 100).toFixed(1)}%)`);
line(`  撞上瞬时占用        : ${stats.hit.length}/${N}  (${(stats.hit.length / N * 100).toFixed(1)}%)`);
line(`  超 60s 未成功       : ${stats.timeout}`);
line(`  非瞬时错误          : ${stats.other.length}`);

if (stats.hit.length) {
  const waits = stats.hit.map((h) => h.waitMs).sort((a, b) => a - b);
  const pct = (p) => waits[Math.min(waits.length - 1, Math.floor(waits.length * p))];
  line('');
  line('  占用窗口分布（毫秒）:');
  line(`    min ${waits[0]}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  max ${waits[waits.length - 1]}`);
  line(`    全部样本: ${JSON.stringify(waits)}`);

  // 关键判定：现有 delays=[0,40,120,300,700] 能覆盖多少
  const CUM = [0, 40, 160, 460, 1160];   // 各次尝试的累计等待
  const covered = waits.filter((w) => w <= CUM[CUM.length - 1]).length;
  const wouldFail = waits.filter((w) => w > CUM[CUM.length - 1]).length;
  line('');
  line(`  对照现有 renameWithRetry（delays=[0,40,120,300,700]，累计 1160ms）:`);
  line(`    覆盖 ${covered}/${waits.length} 次；若首次重试不成功则最终失败 ${wouldFail} 次`);
  const needMs = waits[waits.length - 1];
  line(`    要全覆盖，退避窗口需 ≥ ${needMs}ms（建议取整到 ${Math.ceil(needMs / 500) * 500}ms）`);
}

if (stats.other.length) {
  line('');
  line('  非瞬时错误样本:');
  for (const o of stats.other.slice(0, 5)) line(`    ${JSON.stringify(o)}`);
}

line('');
line(`（清理用前缀：zzprobe-${RUN}  /  .probe-${RUN}）`);
