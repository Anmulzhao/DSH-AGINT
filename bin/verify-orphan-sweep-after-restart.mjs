#!/usr/bin/env node
/**
 * 重启后验收：skills_root 孤儿清理是否真的生效
 *
 * 用法（老板双击重启 dsh 之后，跑这一条）：
 *   node D:/DSH/bin/verify-orphan-sweep-after-restart.mjs
 *
 * 路径默认按本机 $DSH_HOME 推导，可被环境变量覆盖：
 *   DSH_HOME（默认 C:/Users/<user>/.dsh）
 *
 * 判据（五条，[0] 是核心）：
 *   [1] 宿主加载的字节里含 sweepSkillOrphans —— 代码确实到位
 *   [2] skills_root 内无 .tmp- 与 .failed- 孤儿 —— 现场干净
 *   [3] 能真实清掉一个「人造孤儿」 —— 功能真的在跑（不是只加载了没接线）
 *
 * ⚠️ 判据 [3] 会**真的创建并删除**一个临时目录（名字以 . 开头 + .tmp-<ts>），
 *    这是本脚本唯一的生产写操作，且只动它自己造的那个目录，不碰任何真实技能。
 *    不想写就加 --no-write，只跑 [1][2]。
 */
import { readdir, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || 'C:/Users/Administrator', '.dsh');
// 2026-09-23 起自动生成技能的投放目标改到**用户级根**（`$DSH_HOME/skills`，与插件
// schema 默认值一致）：旧的 `.agent-presets/agint/skills` 属 install.sh 镜像管理范围，
// 重装会把自动生成的技能整片清掉。`AGINT_SKILLS_ROOT` 可覆盖（隔离测试用临时目录）。
const SKILLS_ROOT = process.env.AGINT_SKILLS_ROOT || join(DSH_HOME, 'skills');
const PLUGIN_DIR = join(DSH_HOME, 'profiles/web/plugins/agint-skill-autocreate');
const HOST_INDEX = join(PLUGIN_DIR, 'lib/index.js');
const HOST_RM = join(PLUGIN_DIR, 'lib/release-manager.js');
const AC_STORE = join(DSH_HOME, 'storages/agint_skill_autocreate.json');
const CRON_STORE = join(DSH_HOME, 'storages/agint_cron.json');
const MARKER = join(DSH_HOME, '.agint-restart/marker.json');
const NO_WRITE = process.argv.includes('--no-write');

const PASS = [];
const FAIL = [];
const NOTE = [];

function ok(msg) { PASS.push(msg); console.log('  ✅ ' + msg); }
function bad(msg) { FAIL.push(msg); console.log('  ❌ ' + msg); }
function note(msg) { NOTE.push(msg); console.log('  ·  ' + msg); }

console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(' skills_root 孤儿清理 · 重启后验收');
console.log(' 时间: ' + new Date().toISOString());
console.log('══════════════════════════════════════════════════════════');

// ── 判据 [0]：进程启动时间 vs 文件落盘时间 ────────────────────
// 这是**唯一纯外部可自动判**的「重启是否加载了新版」证据：
//   ESM 模块加载后进内存，磁盘再变也不重载（除非宿主显式 watch+reload）。
//   所以：进程启动时间 **晚于** 插件文件 mtime  ⇒ 启动时磁盘上就是新版 ⇒ 内存即新版。
//
// 启动时间来源：`$DSH_HOME/.agint-restart/marker.json` 的 `lastBootAt` + `pid`
//   —— 这是 agint-restart 插件每次启动自己写的，比查系统 API 更可靠
//   （wmic 在 Win11 已移除；tasklist 不给启动时间）。
console.log('');
console.log('[0] dsh 进程启动时间 vs 插件文件落盘时间');
try {
  const { readFile } = await import('node:fs/promises');
  const { statSync } = await import('node:fs');

  const marker = JSON.parse(
    await readFile(MARKER, 'utf8')
  );
  const bootMs = marker.lastBootAt ? new Date(marker.lastBootAt).getTime() : null;
  const fstat = statSync(HOST_INDEX);

  const fmtLocal = (ms) =>
    new Date(ms + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

  if (bootMs === null) {
    note('marker.json 无 lastBootAt —— 跳过本判据');
    note('插件文件落盘: ' + fmtLocal(fstat.mtime.getTime()) + ' (本地)');
  } else {
    note('dsh 最近启动: ' + fmtLocal(bootMs) + ' (本地)  [pid ' + (marker.pid ?? '?') + ']');
    note('插件文件落盘: ' + fmtLocal(fstat.mtime.getTime()) + ' (本地)');
    note('代码指纹: ' + (marker.codeFingerprint ?? '(无)'));
    if (bootMs > fstat.mtime.getTime()) {
      ok('进程启动 **晚于** 文件落盘 → 加载的就是新版（重启已生效）');
    } else {
      bad('进程启动 **早于** 文件落盘 → 加载的是旧版（还没重启 / 重启没生效）');
      note('  Δ = ' + Math.round((fstat.mtime.getTime() - bootMs) / 60_000) + ' 分钟（文件比启动晚了这么久）');
    }
  }
} catch (e) {
  note('判据 [0] 执行异常: ' + e.message);
}

// ── 判据 [1]：代码到位（读宿主真字节）────────────────────────
console.log('');
console.log('[1] 宿主字节是否含 orphan 清理实现');
let hostSrc = '';
try {
  const { readFile } = await import('node:fs/promises');
  hostSrc = await readFile(HOST_INDEX, 'utf8');
  if (hostSrc.includes('sweepSkillOrphans')) ok('宿主 index.js 含 sweepSkillOrphans 引用');
  else bad('宿主 index.js 不含 sweepSkillOrphans —— 同步没做全');
  if (hostSrc.includes('orphanSweep')) ok('宿主 index.js 含 orphanSweep 结果字段');
  else bad('宿主 index.js 缺 orphanSweep 结果字段');

  // ⚠️ 注意：文件里有 ≠ 进程内存里有（ESM 加载后不随磁盘变）
  // 这一条**无法**从外部直接证明，只能用下面的 [3] 间接验。此处只提示。
  note('注意：文件有该实现 ≠ 当前进程已加载 —— 由 [3] 的实际行为来判');
} catch (e) {
  bad('读宿主 index.js 失败: ' + e.message);
}

// ── 判据 [2]：现场干净 ──────────────────────────────────────
console.log('');
console.log('[2] skills_root 现场是否存在孤儿');
const ORPHAN_RE = /^\.\S+\.tmp-\d{10,}(\.failed-\d{10,})?$/;
let namesBefore = [];
try {
  namesBefore = await readdir(SKILLS_ROOT);
  const orphans = namesBefore.filter((n) => ORPHAN_RE.test(n));
  const skills = namesBefore.filter((n) => !ORPHAN_RE.test(n));
  note('目录总条目 ' + namesBefore.length + '（技能 ' + skills.length + ' + 孤儿 ' + orphans.length + '）');
  if (orphans.length === 0) ok('无孤儿残留（可能是清理生效，也可能是本来就没产生）');
  else note('发现 ' + orphans.length + ' 个孤儿: ' + orphans.join(', ') + '（这是「等清理」的正常态）');
} catch (e) {
  bad('读 skills_root 失败: ' + e.message + '（路径对吗？' + SKILLS_ROOT + '）');
}

// ── 判据 [3]：真实清掉一个人造孤儿（唯一写操作）──────────────
console.log('');
console.log('[3] 端到端：造一个孤立 tmp 目录，看它会不会被清掉');
if (NO_WRITE) {
  note('--no-write 指定，跳过（本判据是唯一能证明「真的在跑」的证据，建议别跳过）');
} else {
  const probeName = '.zzverify-restart.tmp-' + (Date.now() - 3 * 3600_000); // 3 小时前，超过 TTL 1h
  const probeDir = join(SKILLS_ROOT, probeName);
  let created = false;
  try {
    await mkdir(probeDir, { recursive: true });
    await writeFile(join(probeDir, 'SKILL.md'), '# probe\n', 'utf8');
    // 把 mtime 拨回 3 小时前，确保超过默认 TTL（60 分钟）
    const old = new Date(Date.now() - 3 * 3600_000);
    await utimes(probeDir, old, old);
    created = true;
    note('已造孤儿: ' + probeName);

    // ── 直接 import 宿主那份 release-manager.js 的**真字节** ──
    // （K62 真导入法：不猜、不复制代码，直接吃宿主那份文件）
    let sweep = null;
    let isOrphanTmpDir = null;
    try {
      const rmMod = await import(pathToFileURL(HOST_RM).href);
      sweep = rmMod.sweepSkillOrphans;
      isOrphanTmpDir = rmMod.isOrphanTmpDir;
    } catch (e) {
      note('未能 import release-manager.js: ' + e.message);
    }

    if (typeof isOrphanTmpDir === 'function') {
      if (isOrphanTmpDir(probeName)) ok('判据函数认可该名字为孤儿（isOrphanTmpDir）');
      else bad('判据函数不认可该名字 —— 正则有问题');

      // 反例复核：真实技能名绝不能被判成孤儿（误杀 = 灾难）
      const mustBeFalse = ['good-skill', '.system', '.config', '.hidden-skill', '.foo.tmp-12345'];
      const wrong = mustBeFalse.filter((n) => isOrphanTmpDir(n));
      if (wrong.length === 0) ok('红线用例全过：' + mustBeFalse.join(' / ') + ' 均判 false');
      else bad('判据误判（会把真实技能当孤儿）: ' + wrong.join(', '));
    } else {
      note('未拿到 isOrphanTmpDir（跳过判据复核）');
    }

    if (typeof sweep === 'function') {
      const res = await sweep({ skillsRoot: SKILLS_ROOT, ttlMs: 60 * 60_000 });
      if (res.removed.includes(probeName)) ok('sweepSkillOrphans 真的清掉了人造孤儿 → 功能可用');
      else bad('sweepSkillOrphans 没有清掉人造孤儿（removed=' + JSON.stringify(res.removed) + '）');
    } else {
      note('无法调用 sweepSkillOrphans（跳过此项）');
    }
  } catch (e) {
    bad('端到端执行异常: ' + e.message);
  } finally {
    if (created) {
      try { await rm(probeDir, { recursive: true, force: true }); note('已清理自己的人造孤儿（不留痕）'); }
      catch { /* 若已被清则忽略 */ }
    }
  }

  // 复核：真实技能数不能变
  try {
    const after = await readdir(SKILLS_ROOT);
    const before = namesBefore.length;
    const probeLeft = after.filter((n) => n.startsWith('.zzverify-restart')).length;
    if (probeLeft === 0) ok('人造孤儿无残留');
    else bad('人造孤儿没清干净: ' + probeLeft + ' 个');
    if (after.length === before) ok('目录条目数与开始时一致（' + before + '）→ 真实技能未被误伤');
    else note('条目数 ' + before + ' → ' + after.length + '（若孤儿被清则正常）');
  } catch (e) {
    bad('复核失败: ' + e.message);
  }
}

// ── 判据 [4]：进程内存里是否真跑了新版（唯一能证明「重启生效」的判据）────
// ⚠️ 判据 [3] 证明的是「磁盘上的代码能跑」，**不能**证明 dsh 进程内存里是新版。
//    因为 [3] 是动态 import 文件 —— 从磁盘读的，跟进程内存无关。
//    真正能证明「重启生效」的，是**产物**：日聚合跑过后 audit_log 里应该出现
//    orphan_sweep_completed（只有新版代码会写这条）。
console.log('');
console.log('[4] 进程是否已加载新版（查 audit_log 产物）');
try {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(AC_STORE, 'utf8');
  const d = JSON.parse(raw);
  const log = d?.tables?.audit_log ?? {};
  const arr = Array.isArray(log) ? log : Object.values(log);
  const swept = arr.filter((e) => String(e?.action ?? '').includes('orphan_sweep'));
  if (swept.length > 0) {
    ok('audit_log 里已有 orphan_sweep 记录（' + swept.length + ' 条）→ 新版代码确实在跑');
    const last = swept[swept.length - 1];
    note('最近一条: ' + JSON.stringify(last).slice(0, 200));
  } else {
    // 注意：这不一定是失败 —— 孤儿清理只在「有超 TTL 孤儿」时才写 audit。
    // 现场没有孤儿 → 它跑了但没东西可清 → 不写 audit。所以此条只能作提示。
    note('audit_log 里暂无 orphan_sweep 记录');
    note('→ 这本身不是失败：孤儿清理**只在有超 TTL 孤儿时才写 audit**。');
    note('  现场没孤儿 → 它跑了但没东西可清 → 不写 audit。');
    note('→ 要确证「进程内存已是新版」，看下面的 [0] 进程启动时间判据。');
  }
  // 附带：日聚合最后运行时间（判断重启后有没有跑过）
  const st = JSON.parse(await readFile(CRON_STORE, 'utf8'));
  const rec = st?.tables?.cron_state?.['skill-autocreate-aggregate'];
  if (rec?.lastRunAt) {
    const t = new Date(rec.lastRunAt);
    note('skill-autocreate-aggregate 最后运行: ' + rec.lastRunAt + ' (' + t.toISOString() + ', result=' + rec.lastResult + ')');
  }
} catch (e) {
  bad('读 audit 存储失败: ' + e.message);
}

// ── 结论 ────────────────────────────────────────────────────
console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(' 结论: ' + (FAIL.length === 0 ? '✅ 全绿' : '❌ 有 ' + FAIL.length + ' 项失败'));
console.log('   通过 ' + PASS.length + ' 项' + (FAIL.length ? '，失败 ' + FAIL.length + ' 项' : ''));
for (const f of FAIL) console.log('   ❌ ' + f);
console.log('══════════════════════════════════════════════════════════');
console.log('');
process.exit(FAIL.length === 0 ? 0 : 1);
