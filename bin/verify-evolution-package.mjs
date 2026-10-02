// bin/verify-evolution-package.mjs —— 本地校验已导出的包
//
// ⭐ 为什么要有这个包装器（不能只靠包内 verify.mjs）：
//   1. 包内 verify.mjs 要先解包才能跑。**解包动作本身就是一次不可信操作** ——
//      若包被替换过，我们已在自己的机器上执行了攻击者的代码。顺序必须是
//      「先验 hash，再解包」，而包内 verify.mjs 无法做到这一点。
//   2. 包内 verify.mjs 与导出程序同一份作者。**自己验自己不算独立校验。**
//      接收方需要一把不依赖包内代码的尺子。
//   3. 传输后 hash 必须能复算。本包装器吃一个 .tar.gz 路径即可，无需仓库上下文。
//
// 零第三方依赖（只用 node: 内置模块）。只读，不写盘，不执行包内任何代码。
//
// 用法：
//   node bin/verify-evolution-package.mjs packages/test-R1.tar.gz
//   node bin/verify-evolution-package.mjs <包> --json     # 机器可读
//   node bin/verify-evolution-package.mjs <包> --quiet    # 只出结论
//
// 退出码：0 全部通过 / 1 有校验失败 / 2 用法错误或包不可读

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { unpackTar } from './lib/tar.mjs';
import { SENSITIVE_PATTERNS } from './lib/redact.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ── 独立复算用的哈希口径 ────────────────────────────────────────────────
// ⚠️ 必须与 bin/export-evolution-package.mjs 一致，但**故意不 import 它** ——
//    import 它的哈希函数等于用同一份实现自证。这里从 manifest 读算法名后
//    只支持 sha256，算法不认识就报错（不猜、不降级）。
const SUPPORTED_ALGO = new Set(['sha256']);

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');
const target = argv.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('用法：node bin/verify-evolution-package.mjs <包.tar.gz> [--json] [--quiet]');
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`❌ 包不存在：${target}`);
  process.exit(2);
}
if (!statSync(target).isFile()) {
  console.error(`❌ 不是文件：${target}`);
  process.exit(2);
}

// ── 结论收集 ────────────────────────────────────────────────────────────
const findings = [];
const ok = (msg) => findings.push({ level: 'OK', msg });
const fail = (msg) => findings.push({ level: 'FAIL', msg });
const info = (msg) => findings.push({ level: 'INFO', msg });

const say = (...a) => { if (!QUIET && !JSON_OUT) console.log(...a); };

// ── ① 读包 + 解压（在任何校验之前）────────────────────────────────────
// 解压本身安全：我们不执行包内任何文件，只把条目读成内存里的字节。
say(`\n[verify] 校验包：${target}`);
let entries;
try {
  entries = unpackTar(gunzipSync(readFileSync(target)));
  ok(`tar 结构可解析，共 ${entries.length} 个条目`);
} catch (e) {
  console.error(`❌ 包无法解析（tar/gzip 损坏）：${e.message}`);
  process.exit(1);
}

const files = entries.filter((e) => e.type === 'file');
const byPath = new Map(files.map((e) => [e.path, e]));

// ── ② 结构校验：规范 §3 要求的文件是否齐全 ────────────────────────────
// ⚠️ manifest.json 在**包根**，不在 00-MANIFEST/ 下（规范 §3 的树形图如此）。
//    目录条目不写进 tar 也没关系 —— 接收方 `tar xzf` 会自动建目录，
//    校验「分区」应按「该分区下是否有文件」判断，而不是按目录条目是否存在。
//    （我第一版按目录条目查，结果对每个真实包都报「缺少分区」——假失败。）
const REQUIRED_FILES = [
  'manifest.json',
  '03-evaluation/PROVENANCE.json',
  '04-runtime-snapshot/REDACTION-REPORT.json',
  '05-environment/NOT-REPRODUCIBLE.md',
  '05-environment/dsh-compat.json',
  '06-verification/package-hash.json',
  '06-verification/verify.mjs',
];
// ⛔ manifest 必须**先读**，后面的分区判据要用它的 reproductionLevel。
//   （第一版把 manifest 的解析放在 hash 校验段里，结构判据用 `manifest &&`
//    兜底 ⇒ manifest 恒为 undefined ⇒ 等级判据永远走「非 R0」分支 ⇒
//    降级正确的包反而报 fail。这类「读得太晚」的 bug 静默且方向一致，最难查。）
let manifest = null;
try {
  manifest = JSON.parse(byPath.get('manifest.json').content.toString('utf8'));
  ok('manifest.json 可解析');
} catch (e) {
  fail(`manifest.json 缺失或不可解析：${e.message}`);
}

// 必须非空的分区（只有清单没有实际内容 = 空壳分区）。
// ⚠️ 01-code/ 的判据**依赖声明的等级**：等级已是 R0（= R1 前提不成立）时，
//   01-code 空是**合法且如实**的，不该报红。等级是 R1/R2 时它才必须非空。
//   第一版无条件要求非空 ⇒ 与「等级实算」互相打架：降级正确反而报 fail。
const declaredLevel = manifest && manifest.reproductionLevel;
const REQUIRED_PREFIXES = ['03-evaluation/', '04-runtime-snapshot/', '05-environment/'];
if (declaredLevel !== 'R0') {
  REQUIRED_PREFIXES.push('01-code/');
}
for (const req of REQUIRED_FILES) {
  if (byPath.has(req)) ok(`必备文件存在：${req}`);
  else fail(`缺少必备文件：${req} —— 包不完整，不可声称结构完整`);
}
for (const pre of REQUIRED_PREFIXES) {
  const n = files.filter((e) => e.path.startsWith(pre)).length;
  if (n > 0) ok(`分区非空：${pre}（${n} 个文件）`);
  else fail(`分区为空：${pre} —— 只有清单没有内容，等于没有这一层`);
}
if (declaredLevel === 'R0') {
  const n = files.filter((e) => e.path.startsWith('01-code/')).length;
  if (n === 0) info('01-code/ 为空 —— 与声明的 R0 一致（代码级复现不可用，属如实降级）');
}

// ── ③ 路径唯一性（重复即覆盖 ⇒ 静默丢数据）─────────────────────────────
// ⛔ 这条曾是真 bug：同域多表共用一个文件名，打包互相覆盖而 hash 仍自洽。
const seen = new Map();
const dupes = [];
for (const e of files) {
  if (seen.has(e.path)) dupes.push(e.path);
  seen.set(e.path, true);
}
if (dupes.length === 0) ok(`包内 ${files.length} 个文件路径唯一，无同名覆盖`);
else fail(`包内有重复路径 ${dupes.length} 个（后者覆盖前者）：${dupes.slice(0, 5).join(', ')}`);

// ── ④ 逐文件 hash 复算 ─────────────────────────────────────────────────
// ⚠️ 口径必须与导出侧一致：导出用 `textHash(text, {prefix:true})` 写的是
//    `sha256:<hex>`，**不是裸 hex**。第一版这里按裸 hex 比 ⇒ 13 个文件全报
//    「不一致」—— 假失败。裸 hex 与带前缀两种都要接受。
// ⚠️ `package-hash.json` 自身在表里是占位串（自指，无法自含），必须跳过。
const SELF_REF = 'sha256:self-referential-skipped';
const normalize = (h) => (typeof h === 'string' && h.startsWith('sha256:') ? h.slice(7) : h);
let hashEntry = null;
try {
  hashEntry = JSON.parse(byPath.get('06-verification/package-hash.json').content.toString('utf8'));
} catch (e) {
  fail(`package-hash.json 缺失或不可解析：${e.message}`);
}

if (hashEntry && hashEntry.algorithm && !SUPPORTED_ALGO.has(hashEntry.algorithm)) {
  // ⛔ 不猜算法。降级到 md5/sha1 会让「校验通过」变成一句没有意义的假话。
  fail(`不支持的哈希算法：${hashEntry.algorithm} —— 拒绝降级校验`);
} else if (hashEntry && hashEntry.files) {
  const entriesHashed = Object.entries(hashEntry.files)
    .filter(([, want]) => want !== SELF_REF);
  let matched = 0;
  const mismatched = [];
  const missing = [];
  for (const [p, want] of entriesHashed) {
    const f = byPath.get(p);
    if (!f) { missing.push(p); continue; }
    const got = createHash('sha256').update(f.content).digest('hex');
    if (got === normalize(want)) matched++;
    else mismatched.push(p);
  }
  if (mismatched.length === 0 && missing.length === 0) {
    ok(`逐文件 hash 全部一致：${matched}/${entriesHashed.length} ⇒ 包未被替换`);
  } else {
    if (mismatched.length) fail(`hash 不一致 ${mismatched.length} 个：${mismatched.slice(0, 5).join(', ')}`);
    if (missing.length) fail(`hash 表里列了但包里没有 ${missing.length} 个：${missing.slice(0, 5).join(', ')}`);
  }
  // 反向：包里有但 hash 表没列 ⇒ 未受校验保护的文件
  const listed = new Set(entriesHashed.map(([p]) => p));
  const unlisted = files
    .map((e) => e.path)
    .filter((p) => !listed.has(p) && p !== '06-verification/package-hash.json');
  if (unlisted.length === 0) ok('包内每个文件都被 hash 表覆盖（无未受校验文件）');
  else fail(`有 ${unlisted.length} 个文件不在 hash 表中（未受完整性保护）：${unlisted.slice(0, 5).join(', ')}`);

  // Merkle root 交叉核对。⛔ 三条口径必须与导出侧 merkleRoot() 一致：
  //   ① 排除 manifest.json（装着 root，算进去是固定点方程）
  //   ② 排除 package-hash.json（表自身）
  //   ③ **保留 sha256: 前缀**参与哈希（剥前缀是错的 —— 导出侧 textHash 的
  //      输出就是带前缀的串，它哈希的是那个串本身，不是裸 hex）
  if (manifest && manifest.integrity && manifest.integrity.packageHash) {
    const sorted = entriesHashed
      .filter(([p]) => p !== 'manifest.json' && p !== '06-verification/package-hash.json')
      .slice()
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, h]) => String(h));   // ⛔ 不剥前缀
    const root = 'sha256:' + createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
    if (root === manifest.integrity.packageHash) ok(`Merkle root 一致（${root}）⇒ 内容与清单同源`);
    else fail(`Merkle root 不一致：算出 ${root}，清单记 ${manifest.integrity.packageHash} ⇒ 有内容文件在成表之后被改动`);
  }
}

// ── ⑤ 脱敏报告非空（D5）──────────────────────────────────────────────
try {
  const rr = JSON.parse(byPath.get('04-runtime-snapshot/REDACTION-REPORT.json').content.toString('utf8'));
  if (rr.performed === true && rr.irreversible === true) ok('脱敏报告非空且声明不可逆（D5 满足）');
  else fail('脱敏报告缺少 performed/irreversible 声明 ⇒ 脱敏可能未执行');
  if (rr.ruleD1_excludedDomains && rr.ruleD1_excludedDomains.length > 0) {
    ok(`D1 白名单排除域已记录：${rr.ruleD1_excludedDomains.map((x) => x.domain).join(', ')}`);
  } else {
    info('D1 排除域为空 —— 若确实无排除域可接受，但请人工确认不是漏记');
  }
} catch (e) {
  fail(`脱敏报告缺失或不可解析（D5 要求强制产出）：${e.message}`);
}

// ── ⑥ 泄露复扫：不信包内结论，自己再扫一遍 ───────────────────────────
// ⚠️ 复用 SENSITIVE_PATTERNS 里的**模式**，但这里只查「未泛化的绝对路径」，
//    因为凭据形态在 D3 阶段应已整条排除；若这里命中凭据，说明 D3 漏了。
const LEAK_RES = [
  /[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g,
  /[A-Za-z]:[\\/]DSH/g,
  /[/\\]home[/\\][^/\\\s"']+/g,
  /[/\\]workspace[/\\]DSH-AGINT/g,
];
const leaks = [];
for (const f of files) {
  if (!/\.(json|md|txt|patch|yml)$/.test(f.path)) continue;
  const text = f.content.toString('utf8');
  for (const re of LEAK_RES) {
    const m = text.match(re);
    if (m) leaks.push(`${f.path}: ${m[0].slice(0, 50)}`);
  }
}
if (leaks.length === 0) ok('未发现未泛化的绝对路径 ⇒ D2 生效');
else fail(`发现疑似未泛化的绝对路径 ${leaks.length} 处：${leaks.slice(0, 5).join(' | ')}`);

// 凭据形态复扫（D3 兜底）
// ⚠️ 排除 email / cn-mobile / internal-host：这三类是 D3 的判定依据之一，
//    但包内的 NOT-REPRODUCIBLE.md 与规范引用里可能出现示例值 ⇒ 单独归到 INFO，
//    不与「真凭据」混为一谈（混在一起会让真泄露被示例噪声淹没）。
const CRED_SKIP = new Set(['email', 'cn-mobile', 'internal-host']);
const credHits = [];
const softHits = [];
for (const f of files) {
  if (!/\.(json|md|txt|patch|yml)$/.test(f.path)) continue;
  const text = f.content.toString('utf8');
  for (const p of SENSITIVE_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.replace('g', ''));
    if (!re.test(text)) continue;
    const where = `${f.path}: ${p.id}`;
    if (CRED_SKIP.has(p.id)) softHits.push(where);
    else credHits.push(where);
  }
}
if (credHits.length === 0) ok('未发现凭据形态残留 ⇒ D3 生效');
else fail(`发现凭据形态残留 ${credHits.length} 处：${credHits.slice(0, 5).join(' | ')}`);
if (softHits.length > 0) {
  info(`另有 ${softHits.length} 处命中邮箱/手机号/内网地址类模式（D3 的判定依据，需人工确认是示例值还是真数据）：${softHits.slice(0, 3).join(' | ')}`);
}

// ── ⑦ 复现等级：如实读，不抬级 ───────────────────────────────────────
if (manifest && manifest.reproductionLevel) {
  const lvl = manifest.reproductionLevel;
  // R0 是本实现新增的等级：R1 的前提（git HEAD + preimage）不成立时如实降级。
  // 规范 §2 只列了 R1/R2/R3 —— R0 是「连代码级复现都做不到」的诚实表述，
  // 强写 R1 才是虚报。
  const RANK = { R0: 0, R1: 1, R2: 2, R3: 3 };
  if (RANK[lvl] === undefined) {
    fail(`manifest 声明了未知复现级别：${lvl}`);
  } else {
    ok(`manifest 声明复现级别：${lvl}`);
    // ⛔ R2 需要 Ledger proof。声明 R2 却说没有 proof ⇒ 自相矛盾。
    const proof = manifest.integrity && manifest.integrity.ledgerProofAvailable;
    if (lvl === 'R2' && proof !== true) {
      fail('声明 R2（决策级复现）但 ledgerProofAvailable 不为 true ⇒ 声明自相矛盾');
    }
    if (lvl === 'R3') {
      fail('声明 R3（完整重演化）—— 本设计明确 R3 结构性不可达，声明即错误');
    }
    // ⛔ 声明 R1 就必须真的有代码资产。空 01-code 却标 R1 = 虚报。
    if (lvl === 'R1' && !files.some((e) => e.path.startsWith('01-code/'))) {
      fail('声明 R1（代码级精确复现）但 01-code/ 为空 ⇒ 接收方无任何代码可比对');
    }
    if (manifest.reproductionLevelReasons && manifest.reproductionLevelReasons.length > 0) {
      info(`导出方给出的降级理由：${manifest.reproductionLevelReasons.join('；')}`);
    }
  }
} else {
  fail('manifest 未声明 reproductionLevel ⇒ 接收方无法判断可信度');
}

// ── ⑧ 拒绝 FULLY_REPRODUCIBLE 措辞 ───────────────────────────────────
// 规范写死：R3 结构性不可达。任何声称「完全可复现」的措辞都是虚报。
const boast = files.filter((f) => /\.(json|md|txt|yml)$/.test(f.path))
  .filter((f) => /FULLY_REPRODUCIBLE|完全可复现|100%\s*可复现/.test(f.content.toString('utf8')));
if (boast.length === 0) ok('包内无 FULLY_REPRODUCIBLE 类虚报表述');
else fail(`有 ${boast.length} 个文件出现「完全可复现」表述（R3 结构性不可达）：${boast.map((f) => f.path).join(', ')}`);

// ── 汇总 ──────────────────────────────────────────────────────────────
const fails = findings.filter((f) => f.level === 'FAIL');
const level = manifest ? manifest.reproductionLevel : 'UNKNOWN';

if (JSON_OUT) {
  console.log(JSON.stringify({
    package: basename(target),
    passed: fails.length === 0,
    reproductionLevel: level,
    findings,
  }, null, 2));
} else {
  say('');
  for (const f of findings) {
    say((f.level === 'OK' ? '  ✓ ' : f.level === 'FAIL' ? '  ✗ ' : '  · ') + f.msg);
  }
  say('');
  say('[verify] 结论');
  if (fails.length === 0) {
    say('  INTEGRITY_VERIFIED · STRUCTURE_VERIFIED');
    say(`  可达复现级别：${level}`);
    say('  ⛔ 不提供 FULLY_REPRODUCIBLE —— R3 结构性不可达（见 05-environment/NOT-REPRODUCIBLE.md）');
  } else {
    say(`  ❌ ${fails.length} 项校验失败 —— 不可声称该包完整`);
  }
}

process.exit(fails.length === 0 ? 0 : 1);
