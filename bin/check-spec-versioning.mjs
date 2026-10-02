#!/usr/bin/env node
// bin/check-spec-versioning.mjs —— 协议版本门禁（Phase 3 组 1-A）
//
// 防什么（把 compatibility-matrix.json 的【声明】变成【可执行检查】）：
//   ① 版本号格式非法（缺 minor / 带前缀 / 非数字）
//   ② 矩阵里的 spec 不在 INDEX.json 中登记 ⇒ 矩阵在描述一个不存在的规范
//   ③ INDEX.json 有规范但矩阵漏了 ⇒ 新规范没有升级规则（最常见的漏）
//   ④ 消费方声明为「未实施」但文件已存在 ⇒ 诚实性失真（反向也为真）
//   ⑤ breakingChanges 非空却没升 major ⇒ 声称破坏性变更却仍是 1.x
//   ⑥ 脱敏规则放松（D1~D6 只可收紧不可放松）
//   ⑦ 不变量被违反：L0-frozen 字段被重定义 / FROZEN 枚举被扩展
//   ⑧ knownGaps 里声称「尚未实施」的门禁其实已存在 ⇒ 该销账了
//
// ⭐ 为什么必须有这个门禁：矩阵写着「本文件是规则的声明，不是规则的实现」。
//    没有实现 ⇒ 升级规则、不可放松原则全是文字游戏。Phase 3 要求它可执行。
//
// ⚠️ 本门禁【只读】。发现问题不自动修 —— 版本决策需要人签字。
//
// 退出码：0 = 通过；1 = 有 ERROR。WARN 不阻塞。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const NODE = process.execPath;
const SPECS_DIR = join(REPO_ROOT, 'docs', 'specs');
const INDEX_PATH = join(SPECS_DIR, 'INDEX.json');
const MATRIX_PATH = join(SPECS_DIR, 'compatibility-matrix.json');
const L0_PATH = join(REPO_ROOT, 'docs', 'l0-frozen-baseline.json');
const SCRIPT_PATH = join(__dirname, 'check-spec-versioning.mjs');

const errors = [];
const warns = [];
const notes = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);
const note = (m) => notes.push(m);

function die(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

if (!existsSync(MATRIX_PATH)) die(`兼容矩阵不存在：${MATRIX_PATH}`);
if (!existsSync(INDEX_PATH)) die(`规范索引不存在：${INDEX_PATH}`);

let matrix;
let index;
try {
  matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
} catch (e) {
  die(`compatibility-matrix.json 解析失败：${e.message}`);
}
try {
  index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
} catch (e) {
  die(`INDEX.json 解析失败：${e.message}`);
}

const specs = index.specs ?? [];
const rules = Array.isArray(matrix.rules) ? matrix.rules : [];
const specIds = new Set(specs.map((s) => s.id));
const byId = new Map(specs.map((s) => [s.id, s]));

// ── ① 版本号格式 ────────────────────────────────────────────────────────
// 规则：`<major>.<minor>`，纯数字。带 `v` 前缀或三段式都不接受 ——
// 因为「格式宽松」会让「v1.0」与「1.0」被当成两个版本，比较时静默失配。
const SEMVER_2 = /^\d+\.\d+$/;
const checkVersion = (v, where) => {
  if (typeof v !== 'string' || !SEMVER_2.test(v)) {
    err(`${where} 的版本号非法：${JSON.stringify(v)} —— 必须形如 "1.0"（不带 v 前缀、不带第三段）`);
    return null;
  }
  return v;
};
checkVersion(matrix.matrixVersion, 'compatibility-matrix.matrixVersion');

const specVersions = new Map();
for (const r of rules) {
  if (!r || typeof r.spec !== 'string') {
    err('rules 里有条目缺 spec 字段');
    continue;
  }
  const v = checkVersion(r.currentVersion, `rules[${r.spec}].currentVersion`);
  if (v) specVersions.set(r.spec, v);

  // ② 矩阵里的 spec 必须已登记
  if (!specIds.has(r.spec)) {
    err(`矩阵描述了一个未登记的规范：${r.spec} —— 不在 INDEX.json 的 specs 里`);
  }
  // upgradePolicy 不能空
  if (typeof r.upgradePolicy !== 'string' || r.upgradePolicy.trim() === '') {
    err(`${r.spec} 缺 upgradePolicy —— 没有升级规则的规范等于可以随意破坏`);
  }
  // ⑤ 声称有破坏性变更却没升 major
  const breaking = Array.isArray(r.breakingChanges) ? r.breakingChanges : [];
  if (breaking.length > 0) {
    const major = v ? Number(v.split('.')[0]) : 0;
    if (major < 2) {
      err(`${r.spec} 记录了 ${breaking.length} 项 breakingChanges，但版本仍是 ${v} ⇒ 应升 major（2.x 起）`);
    }
  }
  // ④ 消费方「未实施」声明的诚实性（双向）
  if (Array.isArray(r.consumers)) {
    for (const c of r.consumers) {
      const m = String(c).match(/^(\S+)\s*\((已实施|未实施|未挂载)\)/);
      if (!m) {
        warn(`${r.spec} 的消费方「${c}」没标注状态（已实施/未实施/未挂载）—— 建议统一格式以便机器检查`);
        continue;
      }
      const [, file, claim] = m;
      // 只对仓库内的相对路径做存在性判断
      if (!file.includes('/') && !file.endsWith('.mjs')) continue;
      const onDisk = existsSync(join(REPO_ROOT, file));
      if (claim === '未实施' && onDisk) {
        err(`${r.spec} 的消费方 ${file} 标注「未实施」，但该文件已存在于磁盘 ⇒ 诚实性失真`);
      }
      if (claim === '已实施' && !onDisk) {
        err(`${r.spec} 的消费方 ${file} 标注「已实施」，但磁盘上找不到该文件`);
      }
    }
  }
}

// ── ③ 矩阵是否漏了已登记的规范 ──────────────────────────────────────────
// ⚠️ 这是最容易漏的一条：新增规范时 INDEX.json 改了、矩阵忘了改，
//    结果那个规范「没有升级规则」而没人发现。
for (const s of specs) {
  if (!specVersions.has(s.id)) {
    err(`规范 ${s.id} 已登记在 INDEX.json，但 compatibility-matrix.json 里没有对应规则 ⇒ 它没有任何升级约束`);
  }
}

// ── 矩阵版本与 spec 版本的一致性 ────────────────────────────────────────
// 规范自身的版本声明（若有）应与矩阵一致。取 spec.version 字段。
for (const [id, mv] of specVersions) {
  const s = byId.get(id);
  if (!s) continue;
  if (s.version !== undefined && s.version !== mv) {
    err(`${id} 的版本在 INDEX.json（${s.version}）与矩阵（${mv}）里不一致`);
  }
}

// ── ⑥ 脱敏规则不可放松 ──────────────────────────────────────────────────
// 判据：矩阵里必须保留该不变量，且 evolution-package 规范的文本里
// 「只可收紧」这句话不能被删掉。删掉 = 放松脱敏的入口。
const pkgRule = rules.find((r) => r.spec === 'evolution-package');
if (pkgRule) {
  const pol = String(pkgRule.upgradePolicy || '');
  if (!/收紧/.test(pol) || !/放松/.test(pol)) {
    err('evolution-package 的 upgradePolicy 未声明「脱敏只可收紧不可放松」⇒ 该硬约束丢失');
  }
}
const invariants = Array.isArray(matrix.invariants) ? matrix.invariants : [];
if (invariants.length === 0) {
  err('matrix.invariants 为空 —— 不变量清单本身需要被门禁看护');
}
const redactionInvariant = invariants.find((x) => /脱敏规则只可收紧/.test(String(x)));
if (!redactionInvariant) {
  err('matrix.invariants 缺少「脱敏规则只可收紧不可放松」这一条');
}

// ── ⑦ 不变量：L0-frozen 与 FROZEN 枚举 ─────────────────────────────────
// 矩阵声明「L0-frozen 字段不得被任何 spec 重定义」「FROZEN 枚举不得被扩展」。
// ⭐ 要让这句话有牙齿，就**委派给既有的权威检查**（bin/check-l0-frozen.mjs，
//    它按单元哈希逐个核对），**不要在这里重造一套弱的**。
//    （本门禁第一版想自己读 l0-frozen-baseline.json 的 frozenEnums ——
//    那个字段根本不存在，基线里是「单元 → 哈希」的映射。自己造的结果是
//    一道永远报「字段缺失」却查不出任何真实漂移的假防线。）
const L0_CHECK = join(__dirname, 'check-l0-frozen.mjs');
if (!existsSync(L0_CHECK)) {
  err(`权威 L0 冻结检查不存在：check-l0-frozen.mjs —— 不变量「L0 字段不得被重定义」当前无人执行`);
} else {
  const r = spawnSync(NODE, [L0_CHECK], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) {
    err(`L0 冻结校验未通过（check-l0-frozen.mjs 退出码 ${r.status}）⇒ 有冻结单元被改动，须走 L0 变更流程（多签 + 7 天影子 + major）`);
  } else {
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const units = (out.match(/^\s*·\s*\S+$/gm) || []).length;
    note(`L0 冻结基线校验通过（check-l0-frozen.mjs，${units} 个冻结单元逐一核对）`);
  }
}

// ── ⑧ knownGaps 里的「尚未实施」是否已过期 ──────────────────────────────
// 门禁实现了 ⇒ 对应 gap 该销账。留着会让后来人以为没有这道防线。
const gaps = Array.isArray(matrix.knownGaps) ? matrix.knownGaps : [];
for (const g of gaps) {
  const text = `${g.gap || ''} ${g.plannedBy || ''}`;
  if (/check-spec-versioning\.mjs\s*尚未实施/.test(text)) {
    err('knownGaps 仍写「check-spec-versioning.mjs 尚未实施」，但本文件已存在 ⇒ 该 gap 应销账');
  }
  if (g.gap && !g.impact) {
    warn(`knownGap「${g.gap}」没写 impact —— 无法判断该不该修`);
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
console.log('[\n  spec 版本门禁 compatibility-matrix.json\n]');
console.log(`  规范 ${specs.length} 份 · 矩阵规则 ${rules.length} 条 · 不变量 ${invariants.length} 条 · knownGap ${gaps.length} 条`);
for (const n of notes) console.log(`  · ${n}`);
if (warns.length) {
  console.log('');
  for (const w of warns) console.log(`  ⚠️  ${w}`);
}
if (errors.length) {
  console.log('');
  for (const e of errors) console.log(`  ❌ ${e}`);
  console.log(`\n[check-spec-versioning] ${errors.length} ERROR / ${warns.length} WARN`);
  process.exit(1);
}
console.log(`\n[check-spec-versioning] 0 ERROR / ${warns.length} WARN ✓`);
process.exit(0);
