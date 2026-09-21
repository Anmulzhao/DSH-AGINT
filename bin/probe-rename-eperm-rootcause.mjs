/**
 * 根因级修法验证（2026-09-21）
 *
 * 假设（09-17 提出但从未验证）：
 *   rename EPERM 的真因是 **tmp 目录建在 skills_root 内部** ——
 *   dsh-skill-filesystem 的 watcher（watch:true, Chokidar）只跳过 `.system`，
 *   会去读 skills_root 内新建的 `.xxx.tmp-*` 目录里的 SKILL.md（Windows 上持有句柄），
 *   紧跟其后的整目录 rename 就撞 EPERM。
 *
 * 若假设成立，则：把 tmp 建到 skills_root **之外**（同盘，保证 rename 仍原子）
 * → watcher 根本看不到临时目录 → **撞 EPERM 的概率应显著下降甚至归零**。
 *
 * 本探针做三组对照，同一循环、同进程，组间紧邻：
 *   A 组：tmp 在 skills_root 内（现状做法）
 *   B 组：tmp 在 skills_root 外（skills_root 的兄弟目录，同盘）
 *   C 组：tmp 在 skills_root 内，但先等待 60ms 再 rename（模拟"占用窗口过去"）
 *
 * 每组都不做重试 —— 只看**第一次 rename 是否成功**。
 * 这是关键的：加retry会让两组都成功，掩盖差别。要测的是**故障发生率**。
 *
 * 安全：只写 zzprobe* / .probe* 前缀；每组结束自清；不碰生产数据。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SKILLS = 'C:/Users/Administrator/.dsh/.agent-presets/agint/skills';
// 同盘兄弟目录 —— 保证 rename 仍是同文件系统（原子），但在 watcher 监听范围之外
const OUTSIDE = 'C:/Users/Administrator/.dsh/.agent-presets/agint/_probe_staging';
const RUN = String(process.argv[2] ?? Date.now()).slice(-6);
const N = Number(process.argv[3] ?? 300);

if (!fs.existsSync(SKILLS)) { console.error('skills_root 不存在'); process.exit(2); }
fs.mkdirSync(OUTSIDE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s = '') => console.log(s);
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

async function writeStub(dir) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), 'probe stub (invalid skill)\n', 'utf8');
  await fsp.writeFile(path.join(dir, 'manifest.json'), '{"probe":true}\n', 'utf8');
}

/** 组 A：tmp 在 skills_root 内 —— 现状做法 */
async function groupA(i) {
  const name = `zzprobe-${RUN}-a${i}`;
  const tmp = path.join(SKILLS, `.${name}.tmp-${Date.now()}`);
  const target = path.join(SKILLS, name);
  await writeStub(tmp);
  const t0 = Date.now();
  try { await fsp.rename(tmp, target); }
  catch (e) { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
              return { ok: false, code: e.code, ms: Date.now() - t0 }; }
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  return { ok: true, ms: Date.now() - t0 };
}

/** 组 B：tmp 在 skills_root 外（同盘兄弟目录）—— 根因级修法 */
async function groupB(i) {
  const name = `zzprobe-${RUN}-b${i}`;
  const tmp = path.join(OUTSIDE, `.${name}.tmp`);
  const target = path.join(SKILLS, name);
  await writeStub(tmp);
  const t0 = Date.now();
  try { await fsp.rename(tmp, target); }
  catch (e) { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
              return { ok: false, code: e.code, ms: Date.now() - t0 }; }
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  return { ok: true, ms: Date.now() - t0 };
}

/** 组 C：tmp 在 skills_root 内，但先等 60ms —— 验证"窗口是否只是时间问题" */
async function groupC(i) {
  const name = `zzprobe-${RUN}-c${i}`;
  const tmp = path.join(SKILLS, `.${name}.tmp-${Date.now()}`);
  const target = path.join(SKILLS, name);
  await writeStub(tmp);
  await sleep(60);
  const t0 = Date.now();
  try { await fsp.rename(tmp, target); }
  catch (e) { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
              return { ok: false, code: e.code, ms: Date.now() - t0 }; }
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  return { ok: true, ms: Date.now() - t0 };
}

const GROUPS = [
  ['A  tmp 在 skills_root 内（现状）      ', groupA],
  ['B  tmp 在 skills_root 外（根因修法）  ', groupB],
  ['C  tmp 在内 + 先等 60ms              ', groupC],
];

line('='.repeat(78));
line(`根因级修法验证 — 真实 skills_root，run=${RUN}，每组 ${N} 轮，均不做重试`);
line(`  skills_root: ${SKILLS}`);
line(`  外部 staging: ${OUTSIDE}`);
line('='.repeat(78));

const results = {};
for (const [label, fn] of GROUPS) {
  const st = { ok: 0, fail: [], codes: {} };
  for (let i = 0; i < N; i++) {
    const r = await fn(i);
    if (r.ok) st.ok++;
    else { st.fail.push(r); st.codes[r.code] = (st.codes[r.code] || 0) + 1; }
  }
  results[label] = st;
  const rate = (st.fail.length / N * 100).toFixed(1);
  line('');
  line(`  ${label} 首次成功 ${st.ok}/${N}  失败 ${st.fail.length} (${rate}%)  ${JSON.stringify(st.codes)}`);
}

line('');
line('─'.repeat(78));
const A = results[GROUPS[0][0]], B = results[GROUPS[1][0]], C = results[GROUPS[2][0]];
line('  判定：');
if (B.fail.length < A.fail.length) {
  line(`    ✅ B 组失败 ${B.fail.length} < A 组失败 ${A.fail.length} —— 支持"tmp 建在 skills_root 内是故障诱因"`);
} else if (B.fail.length === 0 && A.fail.length === 0) {
  line(`    ℹ️ 本轮两组均 0 失败（概率低未分出差别）；需更大样本`);
} else {
  line(`    ⚠️ B 组未优于 A 组（B=${B.fail.length} vs A=${A.fail.length}）—— 假设未获支持`);
}
line(`    C 组（等 60ms 再 rename）失败 ${C.fail.length} —— ${C.fail.length === 0 ? '与"窗口会自然过去"一致' : '说明等待不足以规避'}`);

line('');
line(`（清理用前缀：zzprobe-${RUN}）`);
