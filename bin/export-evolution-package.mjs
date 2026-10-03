#!/usr/bin/env node
// bin/export-evolution-package.mjs —— 可复现进化包导出主程序（Phase 3 交付物三，Tier B）
//
// ⛔ **D4 人工确认闸门：没有 --confirm 就不产出包（fail-closed）。**
//   这是本脚本最重要的一条。数据离开本机前的最后一道防线必须是人。
//   默认（无参数）只跑 dry-run，打印清单后退出 0，不落盘任何真实数据。
//
// 用法：
//   node bin/export-evolution-package.mjs                    # dry-run（默认，安全）
//   node bin/export-evolution-package.mjs --dry-run          # 同上（显式）
//   node bin/export-evolution-package.mjs --confirm --out=PATH  # 真正打包
//
// ⛔ **D6 本脚本【不做】任何上传 / 发布动作**（规范 §4.2 D6）。
//    导出是本地动作，发布是外发动作，风险等级不同，不得合并。
//    验收判据：全文无 fetch / http / net / upload 字样。
//
// 数据来源：直接读 $DSH_HOME/storages/*.json 的**文件字节**，不碰 storage 后端。
//   理由：离线批处理；让插件在运行时导出等于把「数据离开本机」变成常规能力，风险面扩大。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { packTarGz } from './lib/tar.mjs';
import { unifiedDiff, applyReverse } from './lib/diff.mjs';
import { generalizePaths, scanSensitiveDeep, redactText } from './lib/redact.mjs';
import { textHash } from './lib/canonical-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DSH_HOME = process.env.DSH_HOME
  || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const STORAGES = join(DSH_HOME, 'storages');
const PREIMAGE_DIR = join(REPO_ROOT, '.agint-preimage');

const argv = process.argv.slice(2);
const CONFIRM = argv.includes('--confirm');
const DRY_RUN = !CONFIRM; // 默认 dry-run
const outArg = argv.find((a) => a.startsWith('--out='));
const OUT_PATH = outArg ? resolve(process.cwd(), outArg.slice('--out='.length)) : null;

const PACKAGE_VERSION = '1.0';

// ── D1 白名单准入 ───────────────────────────────────────────────────────────
/**
 * 允许导出的 runtime 域。
 *
 * ⭐ 这里是「默认拒绝」而非「默认允许」：不在表里的域**一律不导出**。
 *    理由：白名单是穷举的，黑名单永远漏 —— 新插件上线就自动进了包。
 */
const ALLOWED_DOMAINS = {
  agint_evolution: {
    reason: '进化记忆（evolution_log / failure_pattern / success_template）—— 进化复现需要机制状态',
    // ⛔ 表级白名单：这三张表是白名单里的白名单。
    //    同域内的 contract_locks / evolution_ledger 默认【不导出】
    //    （含 hypothesisLock 等可能含自由文本的字段），需要时在下面显式加。
    tables: ['evolution_log', 'failure_pattern', 'success_template'],
  },
  agint_population: { reason: '种群与谱系', tables: null },
  agint_mutator: { reason: '变异记录', tables: null },
  agint_mount: { reason: '挂载记录', tables: null },
  agint_abtest: { reason: 'A/B 实验记录', tables: null },
  agint_quality_policy: { reason: 'policy 决策记录', tables: null },
};

/**
 * ⛔ 明确排除清单（D1）。这些**永不导出**，即便它们在 .gitignore 之外。
 * 理由：进化复现不需要「Agent 记住了什么」，只需要「进化机制的状态」。
 */
const NEVER_EXPORT = [
  { domain: 'agint', why: 'memory 域。type ∈ {lesson, decision, preference, pattern} —— preference/decision 极可能含用户个人偏好与决策（agint-memory/lib/index.js:26 实测枚举）' },
  { domain: 'agint_ov_strategy', why: 'OpenViking 投影（外部服务）' },
  { domain: 'agint_session_extract', why: '会话抽取数据（架构.md:174）' },
];

// ── 工具 ────────────────────────────────────────────────────────────────────

function readStorage(domain) {
  const p = join(STORAGES, `${domain}.json`);
  if (!existsSync(p)) return { domain, path: p, exists: false, data: null };
  try {
    return { domain, path: p, exists: true, data: JSON.parse(readFileSync(p, 'utf8')), raw: readFileSync(p, 'utf8') };
  } catch (e) {
    return { domain, path: p, exists: true, data: null, error: e.message, raw: readFileSync(p, 'utf8') };
  }
}

/** dsh 存储域文件的 tables 可能在顶层也可能在 tables 下，两处都找。 */
function tablesOf(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.tables && typeof data.tables === 'object') return data.tables;
  // 顶层形态：跳过 unit / global 两个保留键
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'unit' || k === 'global') continue;
    if (v && typeof v === 'object') out[k] = v;
  }
  return out;
}

/**
 * 数一张表的行数 —— **dict 与 array 两种形状都要认**。
 *
 * ⚠️ 这不是洁癖，是一个已经造成过假结论的真 bug（2026-10-03 A1 实测）：
 *   本函数原先在 ledger 判定处写成 `Array.isArray(t) ? t.length : 0`，
 *   而 dsh 存储域的表在磁盘上是 **dict**（`{"1": {...}, "2": {...}}`，
 *   见 `$DSH_HOME/storages/agint_evolution.json` 实测）。
 *   ⇒ 6 条真条目被判成「0 行」⇒ `ledgerProofAvailable` 报 false 且**理由是错的**
 *   （说「表 0 行」，实际是「读表的人不认 dict」）。
 *
 * ⛔ 失败方向：恒低报。它不会把「有数据」说成「没数据」的**危害方向**好看 ——
 *   恰好相反，它把一个**可解锁的能力**（R2 信任锚）永久锁死，
 *   而给出的理由（表是空的）把人引向「去造数据」而不是「去修判据」。
 *   这就是 K134 的镜像：能力不可用 ≠ 实现有 bug。
 *
 * @param {unknown} table tables[tname] 的原值
 * @returns {number} 行数；表不存在或不是容器形态时 0
 */
function rowCountOf(table) {
  if (Array.isArray(table)) return table.length;
  if (table && typeof table === 'object') return Object.keys(table).length;
  return 0;
}

/**
 * 数 ledger 里**已锚定**的条目数（`anchorStatus === 'ANCHORED'`）。
 *
 * 为什么不复用行数：`evolution_ledger` 落盘的每条都带 `anchorStatus`
 * （`PENDING` / `ANCHORED` / `ANCHOR_MISMATCH`，见 `ledgerEntrySchema`），
 * 它由 `ledger-anchor` 在**锚点行进了 git 之后**回写。重建条目与尚未跑过锚定的
 * 实时条目都是 `PENDING` ⇒ 「有行」不等于「有信任锚」。
 *
 * ⛔ 认 dict 形状（理由同 rowCountOf 的头注）。
 *
 * @param {unknown} table tables.evolution_ledger 的原值
 * @returns {number}
 */
function countAnchoredLedgerRows(table) {
  const rows = Array.isArray(table)
    ? table
    : (table && typeof table === 'object' ? Object.values(table) : []);
  let n = 0;
  for (const r of rows) {
    if (r && typeof r === 'object' && r.anchorStatus === 'ANCHORED') n += 1;
  }
  return n;
}

// ── 收集素材 ────────────────────────────────────────────────────────────────

function collectRuntime() {
  const items = [];
  const excluded = [];

  for (const [domain, spec] of Object.entries(ALLOWED_DOMAINS)) {
    const ne = NEVER_EXPORT.find((x) => x.domain === domain);
    if (ne) {
      excluded.push({ rule: 'D1', what: domain, why: ne.why });
      continue;
    }
    const r = readStorage(domain);
    if (!r.exists) {
      excluded.push({ rule: 'D1', what: domain, why: `存储域文件不存在（未跑过该插件，或路径不在 ${STORAGES}）` });
      continue;
    }
    if (r.error) {
      excluded.push({ rule: 'D1', what: domain, why: `读取失败：${r.error}` });
      continue;
    }
    const tables = tablesOf(r.data);
    const tableNames = spec.tables ?? Object.keys(tables);

    for (const tname of tableNames) {
      const rows = tables[tname];
      if (rows === undefined) {
        excluded.push({ rule: 'D1', what: `${domain}.${tname}`, why: '表不存在（域内无此表）' });
        continue;
      }
      // D3：逐行敏感扫描，命中则**整条排除**（规范 §4.2 D3：部分遮蔽易漏）
      const kept = [];
      let dropped = 0;
      const droppedByRule = {};
      const rowsArr = Array.isArray(rows) ? rows : Object.entries(rows).map(([k, v]) => ({ __key: k, ...v }));
      for (const row of rowsArr) {
        const scan = scanSensitiveDeep(row);
        if (scan.sensitive) {
          dropped += 1;
          for (const h of scan.hits) {
            droppedByRule[h.id] = (droppedByRule[h.id] ?? 0) + 1;
          }
          continue;
        }
        kept.push(row);
      }
      if (dropped > 0) {
        excluded.push({
          rule: 'D3',
          what: `${domain}.${tname}`,
          why: `整条排除 ${dropped} 条（命中敏感模式：${Object.entries(droppedByRule).map(([k, v]) => `${k}×${v}`).join(', ')}）`,
        });
      }
      if (kept.length === 0) continue;
      items.push({ domain, table: tname, rows: kept, originalCount: rowsArr.length });
    }
  }

  // 明确排除的域也要记进报告（D5：排除必须留痕）
  for (const ne of NEVER_EXPORT) {
    const r = readStorage(ne.domain);
    if (r.exists) {
      excluded.push({ rule: 'D1', what: ne.domain, why: ne.why });
    }
  }

  return { items, excluded };
}

function collectCode() {
  const items = [];
  const notes = [];

  // ① git commit
  const head = readGitHead();
  if (head) {
    items.push({ path: '01-code/git-commit.txt', content: `${head}\n` });
  } else {
    notes.push('拿不到 git HEAD（可能不是 git 仓库或未装 git）⇒ 01-code/git-commit.txt 缺失');
  }

  // ② preimage → 真实 diff.patch（Tier B）
  //
  // ⭐ 命名规则来自引擎侧 `plugins/agint-evolution-driver/lib/index.js:1135`：
  //   `.agint-preimage/${norm.split('/').join('__')}__${stamp}.bak`
  //   即**路径分隔符换成 `__`，再加 `__<时间戳>`**。反解必须与它一一对应 ——
  //   反解错了会拿 A 文件的备份去对 B 文件，产出「看着像 diff」的假 diff。
  //
  //   配对策略：同一路径有多份备份时，取**时间戳最早**的那份作为 before
  //   （即「该期进化之前的原始内容」），与当前文件比。
  //   理由：多份备份是同一路径被反复改动的历史；最早那份才代表「本轮改之前」。
  const preimages = existsSync(PREIMAGE_DIR)
    ? readdirSync(PREIMAGE_DIR).filter((f) => f.endsWith('.bak')).sort()
    : [];

  const diffParts = [];
  const diffMeta = [];
  const diffSkipped = [];

  // ⭐⭐ 同一路径只能有**一条** diff：从时间戳**最早**的备份算。
  //
  //   踩过的坑：6 份备份里有 3 份是同一个 `bin/plugin-check.sh`，
  //   不去重就生成 3 条 diff，全部 apply 到当前文件 —— `git apply` 报
  //   「patch does not apply at bin/plugin-check.sh:464」，
  //   而且**报错行号各不相同**（每条 diff 假定自己 apply 完就能对上）。
  //
  //   为什么取最早那份而不是最新：备份是该路径**每次被改前**的快照，
  //   最早那份 = 本轮改动之前的原始内容，与当前文件的 diff 才是完整的。
  //   （第二早/第三早是「中间态」，与当前文件 diff 只会得到残缺片段。）
  const byPath = new Map();
  for (const bak of preimages) {
    const relPath = decodePreimageName(bak);
    if (!relPath) {
      diffSkipped.push({ backup: bak, reason: '文件名不符合 `<路径>__<时间戳>.bak` 约定' });
      continue;
    }
    if (!byPath.has(relPath)) byPath.set(relPath, []);
    byPath.get(relPath).push(bak);
  }

  for (const [relPath, baks] of [...byPath.entries()].sort()) {
    // 备份文件名按时间戳升序（时间戳是 ISO 定长，字典序 = 时间序）
    const bak = baks[0];
    if (baks.length > 1) {
      diffSkipped.push({
        backup: baks.slice(1).join(', '),
        reason: `同路径有 ${baks.length} 份备份，只用最早的 ${bak}（更晚的是中间态，diff 会残缺且互相冲突）`,
      });
    }
    const live = join(REPO_ROOT, relPath);
    // ⛔ 安全闸：反解出的路径必须仍在仓库内。
    //   备份文件名来自磁盘，不可信；`../../etc/passwd` 这类必须在这里被拦住，
    //   而不是等 readFileSync 把它读进包。
    if (!isInside(REPO_ROOT, live)) {
      diffSkipped.push({ backup: bak, reason: '反解路径越出仓库根，已拒绝读取' });
      continue;
    }
    if (!existsSync(live)) {
      diffSkipped.push({ backup: bak, reason: `对应文件已不存在（${relPath}），无法配对` });
      continue;
    }
    const before = readFileSync(join(PREIMAGE_DIR, bak), 'utf8');
    const after = readFileSync(live, 'utf8');
    const patch = unifiedDiff(before, after, `a/${relPath}`, `b/${relPath}`);
    if (patch === '') {
      diffSkipped.push({ backup: bak, reason: '与当前文件内容一致（无差异）' });
      continue;
    }
    // ⭐ 往返自证：能生成 diff 的实现很多，能证明 diff 真能还原的很少。
    //   R1 的实际含义是「接收方 apply 后得到逐字节相同的文件」，
    //   所以打不进包之前先自己 apply 一次，失败就不出这条 diff。
    const restored = applyReverse(patch, after, `b/${relPath}`);
    if (restored !== before) {
      throw new Error(
        `diff 往返校验失败，拒绝出包：${relPath}\n` +
          '  生成器产出的 diff 无法反向还原出原文件 —— 这种 diff 比没有更危险' +
          '（接收方会以为还原成功）。\n' +
          `  before 长度 ${before.length} · 还原长度 ${restored === null ? 'null' : restored.length}`,
      );
    }
    diffParts.push(patch);
    diffMeta.push({ path: relPath, backup: bak, bytes: patch.length });
  }

  if (diffParts.length > 0) {
    const header =
      '# 01-code/diff.patch —— AGINT 进化包代码差异\n' +
      '# 由 bin/export-evolution-package.mjs 生成（零依赖手写 unified diff）\n' +
      `# 覆盖 ${diffMeta.length} 个文件。每条 diff 生成后都跑过 apply 往返自检。\n` +
      '# 用途：接收方在 preimage 备份缺失时，可用本文件把代码还原到进化前的状态。\n' +
      '#\n' +
      diffMeta.map((m) => `#   ${m.path}（来自 ${m.backup}）`).join('\n') +
      '\n\n';
    items.push({
      path: '01-code/diff.patch',
      content: header + diffParts.join(''),
    });
    items.push({
      path: '01-code/diff-manifest.json',
      content: `${JSON.stringify(
        {
          note: '每个 diff 都已通过 apply 往返自检（还原结果与 preimage 逐字节相同）。',
          count: diffMeta.length,
          files: diffMeta,
          skipped: diffSkipped,
        },
        null,
        2,
      )}\n`,
    });
    if (diffSkipped.length > 0) {
      notes.push(`preimage 有 ${preimages.length} 份，其中 ${diffSkipped.length} 份无法配对（详见 diff-manifest.json 的 skipped）`);
    }
  } else {
    items.push({
      path: '01-code/preimage-manifest.json',
      content: `${JSON.stringify(
        {
          note:
            preimages.length > 0
              ? 'preimage 存在但无法生成任何 diff（全部无法配对）⇒ 见 skipped 原因。'
              : 'preimage 目录为空或不存在 ⇒ 01-code 无备份清单，R1 级复现不可用。',
          count: preimages.length,
          files: preimages,
          skipped: diffSkipped,
        },
        null,
        2,
      )}\n`,
    });
    notes.push('未产出 diff.patch（无 preimage 或无可配对项）⇒ R1 的代码 diff 部分不可用');
  }

  return { items, notes, preimageCount: preimages.length };
}

/**
 * 反解 preimage 文件名 → 仓库相对路径。
 *
 * 命名规则见 `plugins/agint-evolution-driver/lib/index.js:1135`：
 *   `<相对路径各段用 __ 连接>__<ISO 时间戳，冒号换短横线>.bak`
 *
 * ⛔ 时间戳里也含 `-`（如 `2026-09-29T05-26-53-216Z`），所以**从右往左**
 *   找最后一个 `__`，按它切开才是对的。按第一个 `__` 切会把路径段吃掉。
 */
function decodePreimageName(bak) {
  if (!bak.endsWith('.bak')) return null;
  const stem = bak.slice(0, -4);
  const idx = stem.lastIndexOf('__');
  if (idx <= 0) return null;
  const pathPart = stem.slice(0, idx);
  const stamp = stem.slice(idx + 2);
  // 时间戳形态校验：`2026-09-29T05-26-53-216Z`
  if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(stamp)) return null;
  const relPath = pathPart.split('__').join('/');
  return relPath === '' ? null : relPath;
}

/** p 是否在 root 之内（防目录穿越）。 */
function isInside(root, p) {
  const r = resolve(root);
  const t = resolve(p);
  return t === r || t.startsWith(r + sep);
}

function readGitHead() {
  try {
    const p = join(REPO_ROOT, '.git', 'HEAD');
    if (!existsSync(p)) return null;
    const head = readFileSync(p, 'utf8').trim();
    const m = head.match(/^ref:\s*(refs\/heads\/.+)$/);
    if (!m) return head; // detached HEAD
    // ⛔ 捕获组要**含完整 ref 名**。第一版写成 `refs\/heads\/(.+)`（只捕 `main`），
    //   拼路径时又从 `.git` 起算 ⇒ `.git/main` 永远不存在 ⇒ git-commit.txt
    //   永远缺失 ⇒ R1 被静默降级，而输出里只写「拿不到 git HEAD」，
    //   看不出是 bug。**「能力不可用」与「实现有 bug」必须能区分开。**
    const refPath = join(REPO_ROOT, '.git', ...m[1].split('/'));
    if (existsSync(refPath)) return readFileSync(refPath, 'utf8').trim();
    // ref 未落盘 ⇒ 可能在 packed-refs 里（git gc / clone 之后常见）
    const packed = join(REPO_ROOT, '.git', 'packed-refs');
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        if (line.startsWith('#') || line.startsWith('^')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length === 2 && parts[1] === m[1]) return parts[0];
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── 生成 manifest ───────────────────────────────────────────────────────────

function buildManifest({ runtime, code, preimageCount, hasDiffPatch, fileHashes, ledgerAvailable, ledgerReason }) {
  const now = new Date().toISOString();
  const packageId = `EVO-PKG-${now.slice(0, 10).replace(/-/g, '')}-${textHash(now).slice(0, 8)}`;

  // Merkle root：对全部文件 hash 排序后再哈希（顺序无关 ⇒ 可复现）
  const packageHash = merkleRoot(fileHashes);

  // ── 复现等级必须**实算**，不能硬编码 ──────────────────────────────────
  // R1 的定义（规范 §2）是「接收方能得到与当时**逐字节相同**的代码」，
  // 依赖 preimage 备份 + git。缺任一项 ⇒ R1 不成立。
  // ⛔ 硬编码 'R1' 的危害：01-code 空包（无 git、无 preimage）也宣称 R1，
  //   接收方据此以为能精确复现，实际什么都对不上。**这是协议诚实性的破口。**
  //   本条由 bin/verify-evolution-package.mjs 的「分区非空」检查抓出。
  const codeFiles = code.items.filter((i) => i.path.startsWith('01-code/'));
  const hasGitHead = codeFiles.some((i) => i.path === '01-code/git-commit.txt');
  const hasPreimage = preimageCount > 0;
  const r1Reasons = [];
  if (!hasGitHead) r1Reasons.push('拿不到 git HEAD（不在 git 仓库内或 git 不可用）');
  if (!hasPreimage) r1Reasons.push('无 preimage 备份（.agint-preimage 为空）');
  const reproductionLevel = r1Reasons.length === 0 ? 'R1' : 'R0';
  if (reproductionLevel === 'R0') {
    r1Reasons.unshift('R0 = R1 的前提不成立，只能复现「包内容本身」，不能复现「代码」');
  }

  return {
    packageVersion: PACKAGE_VERSION,
    packageId,
    createdAt: now,
    createdBy: 'bin/export-evolution-package.mjs',
    reproductionLevel,
    reproductionLevelReasons: r1Reasons,
    reproductionCaveats: [
      '变异由 LLM 生成，重跑结果不保证相同（R3 不可达，见规范 §2.1 三条原因）',
      '宿主私有包未随包分发，需接收方自行安装 dsh',
      '判定基准非外部锚定（NOT_ANCHORED），评估结论的可信度受限（见 03-evaluation/PROVENANCE.json）',
      hasDiffPatch
        ? 'diff.patch 只覆盖**有 preimage 备份且当前文件仍存在**的路径；未覆盖部分见 01-code/diff-manifest.json 的 skipped'
        : '本包不含 diff.patch（无可配对的 preimage）⇒ 代码复现依赖接收方自行比对 preimage',
    ],
    integrity: {
      packageHash,
      fileCount: Object.keys(fileHashes).length,
      ledgerProofAvailable: ledgerAvailable,
      ledgerProofReason: ledgerReason,
    },
    redaction: {
      performed: true,
      policy: 'docs/specs/evolution-package-v1.md#脱敏策略',
      report: '04-runtime-snapshot/REDACTION-REPORT.json',
      reversible: false,
    },
    contents: {
      '01-code': code.items.map((i) => i.path),
      '04-runtime-snapshot': runtime.items.map((i) => `agint_${i.domain}__${i.table}.json`),
    },
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
  console.log('[export-evolution-package] 可复现进化包导出');
  console.log(`  模式：${CONFIRM ? '⚠️  --confirm（真正打包）' : '--dry-run（默认，不落盘真实数据）'}`);
  console.log(`  DSH_HOME ${DSH_HOME}`);
  console.log(`  storages ${STORAGES}`);

  const runtime = collectRuntime();
  const code = collectCode();

  // 演化 Ledger 可用性 —— 必须查生产存储，不能假设
  const evo = readStorage('agint_evolution');
  const evoTables = tablesOf(evo.data);
  // ⚠️ 必须用 rowCountOf（认 dict），不能用 Array.isArray —— 见该函数头注的实测 bug。
  const ledgerRows = rowCountOf(evoTables.evolution_ledger);
  const ledgerAnchored = countAnchoredLedgerRows(evoTables.evolution_ledger);
  // ⛔ 判据是「有**已锚定**条目」，不是「表非空」（K138：函数名承诺的覆盖面 = 实际覆盖面）。
  //   `ledgerProofAvailable` 承诺的是「包里有可验证的 Merkle proof」，而 proof 的价值
  //   恰恰在于它对**链外**的锚点成立。6 条全 PENDING 时给 true，等于把一份
  //   「谁都能改的链」包装成「可外部验证的信任锚」—— 比报 false 更危险，
  //   因为它让人以为 R2 已解锁。现状实测（2026-10-03）：6 条 / 0 ANCHORED。
  const ledgerAvailable = ledgerAnchored > 0;
  const ledgerReason = ledgerAvailable
    ? null
    : `生产 agint_evolution.json 的 evolution_ledger 表 ${ledgerRows} 行、其中已锚定 ${ledgerAnchored} 条`
      + `（2026-10-03 实测）⇒ 无带外部锚点的 Merkle proof`;

  console.log(`\n  ── 收集结果 ──`);
  console.log(`  runtime 表 ${runtime.items.length} 张 · 排除 ${runtime.excluded.length} 项`);
  console.log(`  code 文件 ${code.items.length} 个 · preimage ${code.preimageCount} 份`);
  console.log(`  Ledger proof：${ledgerAvailable ? '可用' : `不可用（${ledgerReason}）`}`);

  // ── D3 二次扫描：整包文本再扫一遍 ──
  // 理由：D1 逐行扫描只覆盖 runtime 表。01-code 的 git-commit / 清单文本
  // 也可能含路径。D2 泛化 + D3 扫描必须对**最终包内容**跑一遍。
  const allItems = [];
  let pathTotal = 0;
  const appliedRules = [];

  for (const it of code.items) {
    const r = redactText(it.content);
    pathTotal += r.pathCount;
    if (r.pathCount > 0) appliedRules.push({ file: it.path, pathCount: r.pathCount });
    allItems.push({ path: it.path, content: r.text });
  }

  for (const it of runtime.items) {
    // 表级导出：只导白名单表，且路径先泛化
    const payload = { domain: it.domain, table: it.table, rows: it.rows };
    const rawText = JSON.stringify(payload, null, 2);
    const scan = scanSensitiveDeep(JSON.parse(rawText));
    if (scan.sensitive) {
      // ⛔ 理论上不会发生（collectRuntime 已逐行扫过），但**必须再兜一层**：
      //    逐行扫描漏掉的可能包括「跨行拼出的凭据」。这里 fail-closed。
      console.error(`  ❌ ${it.domain}.${it.table} 在整包扫描中仍命中敏感模式：${JSON.stringify(scan.hits)}`);
      console.error('     ⇒ 拒绝导出（fail-closed）。这说明逐行扫描有漏，需修 collectRuntime。');
      process.exit(1);
    }
    const r = redactText(rawText);
    pathTotal += r.pathCount;
    if (r.pathCount > 0) appliedRules.push({ file: `${it.domain}.${it.table}`, pathCount: r.pathCount });
    allItems.push({
      // ⚠️ 文件名必须带表名：同域的多个表（evolution_log / failure_pattern /
      //    success_template）若共用一个文件名，打包时会**互相覆盖**，
      //    接收方只拿到最后一张 —— 而 manifest 的 contents 里三条路径完全相同，
      //    校验也会「通过」。这是打包类代码最容易漏的一类 bug。
      path: `04-runtime-snapshot/agint_${it.domain}__${it.table}.json`,
      content: r.text,
    });
  }

  // PROVENANCE —— G1 缺口如实上报（规范 §6）
  allItems.push({
    path: '03-evaluation/PROVENANCE.json',
    content: `${JSON.stringify(
      {
        baselineSource: 'agint_evolution.success_template',
        baselineAnchored: false,
        baselineProvenance: 'NOT_ANCHORED',
        why:
          '判定基准与被评对象同池（success_template 有 model-visible 写工具 evolution_addSuccess）、' +
          '上限 50、无 provenance 记录 ⇒ 接收方无法验证「该次进化通过了基准评估」这一声明。',
        consequence:
          '导出包的评估结论可信度受限。**不得声称其「不可篡改」。** ' +
          '完整信任模型需等 external-anchor 提案实施（老板 2026-10-01 已拍板存档，Phase 3 不实施）。',
        honestDegradation: true,
      },
      null,
      2,
    )}\n`,
  });

  // 脱敏报告 —— D5 要求强制产出，空报告 = 导出失败
  const redactionReport = {
    performed: true,
    irreversible: true,
    policy: 'docs/specs/evolution-package-v1.md#4-脱敏策略本规范最高风险点',
    ruleD1_excludedDomains: NEVER_EXPORT.map((x) => ({ domain: x.domain, why: x.why })),
    ruleD1_excluded: runtime.excluded,
    ruleD2_generalizedPaths: pathTotal,
    ruleD2_appliedByFile: appliedRules,
    ruleD3_excludedRecords:
      runtime.excluded.filter((x) => x.rule === 'D3').length,
    /**
     * ⭐ 已知残留（不是漏洞，但要写明以免接收方误判）：
     * 自由文本（mutation prompt、提案正文）里可能出现**运行期知识库的路径引用**，
     * 形如 `wiki/AGINT/<文档名>.md`。包内只有**路径字符串**，没有文件内容
     * ⇒ 泄露面是「内部文档的命名」，不是「文档内容」。
     *
     * 为什么不整条排除：mutation prompt 是复现 R1 的核心材料
     * （去掉它就无法理解「为什么这么改」），而路径字符串的敏感性远低于内容。
     * 若后续判定不可接受，处理方式是在 D3 加一条 pattern，而非删整表。
     */
    knownResiduals: [
      {
        what: '运行期知识库路径引用（wiki/AGINT/*.md 形态）',
        why: 'mutation prompt / 提案正文里的引用，只含路径字符串不含内容',
        risk: '低 —— 泄露内部文档命名，不泄露内容',
        decision: '保留（D3 只处理凭据形态，不处理路径引用）',
      },
    ],
    note:
      '⚠️ 脱敏不可逆：接收方无法还原原文。' +
      'D1 排除的域（memory / ov-strategy / session-extract）**根本没进包**，不是「进包后被删」。',
  };
  // ⛔ 脱敏报告自身也必须过一遍 D2。
  //    它的 ruleD1_excluded[].why 里写着「路径不在 C:\Users\<name>\.dsh\storages」
  //    —— 而那正是本机绝对路径。**报告是导出包的一部分，报告泄露 = 包泄露。**
  //    （这是本脚本第一轮端到端验收时被抓到的真漏洞，测试已钉住。）
  const reportText = redactText(JSON.stringify(redactionReport, null, 2));
  allItems.push({
    path: '04-runtime-snapshot/REDACTION-REPORT.json',
    content: `${reportText.text}\n`,
  });
  pathTotal += reportText.pathCount;
  if (reportText.pathCount > 0) {
    appliedRules.push({ file: '04-runtime-snapshot/REDACTION-REPORT.json', pathCount: reportText.pathCount });
  }

  // NOT-REPRODUCIBLE
  const diffCount = code.items.find((it) => it.path === '01-code/diff-manifest.json')
    ? JSON.parse(code.items.find((it) => it.path === '01-code/diff-manifest.json').content).count
    : 0;
  const skippedCount = code.items.find((it) => it.path === '01-code/diff-manifest.json')
    ? JSON.parse(code.items.find((it) => it.path === '01-code/diff-manifest.json').content).skipped.length
    : 0;
  const diffSection = diffCount > 0
      ? `## 2. 代码 diff —— 本包含 \`01-code/diff.patch\`（${diffCount} 个文件）\n\n` +
        `每条 diff 生成后都跑过 \`apply\` 往返自检：反向应用后必须逐字节等于 preimage 备份，否则导出器拒绝出包。\n` +
        (skippedCount > 0
          ? `\n⚠️ 另有 ${skippedCount} 份 preimage 未能配对（原因见 \`01-code/diff-manifest.json\` 的 \`skipped\`），` +
            '这些路径**不在** diff 覆盖范围内。\n'
          : '\n') +
        `\n**局限**：diff 只覆盖「有 preimage 且当前文件仍在」的路径。preimage 保留期是 ≥90 天或 ≥20 期` +
        `（\`docs/known-limitations\` 同级规范），超期清理后旧期 diff 将不可用。\n`
      : '## 2. 代码 diff —— 本包不含 diff.patch\n\n' +
        '无可配对的 preimage 备份（或全部配对失败），因此无 diff。接收方只能依据 `01-code/preimage-manifest.json` 自行比对。\n\n';
  allItems.push({
    path: '05-environment/NOT-REPRODUCIBLE.md',
    content:
      '# 不可复现的部分\n\n' +
      '## 1. 完整重演化（R3）—— **结构性不可达**\n\n' +
      '1. 变异由 LLM 生成，非确定性（同 prompt + 同模型 ≠ 同输出）\n' +
      '2. 模型侧不可复现：AGINT 运行时解析 provider/model，接收方默认模型几乎必然不同\n' +
      '3. 时间维度不可复现：工具链、网络、外部服务状态随时间变\n\n' +
    diffSection +
      '## 3. 评估结论 —— 基准非外部锚定\n\n' +
      '见 `03-evaluation/PROVENANCE.json`。基准存于 `success_template`（同池可写、无 provenance）。\n\n' +
      '## 4. 路径已泛化\n\n' +
      `D2 规则共泛化 ${pathTotal} 处绝对路径。**因此不能用本包直接回滚** —— ` +
      '路径需人工适配（规范 §9 已知限制第 4 条）。\n',
  });

  // 环境信息
  const VERSION_TEXT = existsSync(join(REPO_ROOT, 'VERSION'))
    ? readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8')
    : '';
  const dshRow = VERSION_TEXT.match(/^\|\s*v\d+\.\d+\.\d+\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|/m);
  allItems.push({
    path: '05-environment/dsh-compat.json',
    content: `${JSON.stringify(
      {
        agintVersion: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version,
        dshMinimum: dshRow ? dshRow[1] : 'UNKNOWN',
        dshTested: dshRow ? dshRow[2] : 'UNKNOWN',
        source: 'VERSION 文件的「## 当前」表首行',
      },
      null,
      2,
    )}\n`,
  });

  // 逐文件 hash
  const fileHashes = {};
  for (const it of allItems) {
    fileHashes[it.path] = textHash(it.content, { prefix: true });
  }

  const manifest = buildManifest({
    runtime,
    code,
    preimageCount: code.preimageCount,
    hasDiffPatch: code.items.some((it) => it.path === '01-code/diff.patch'),
    fileHashes,
    ledgerAvailable,
    ledgerReason,
  });

  // manifest 与 package-hash 自身也要进包
  allItems.push({ path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
  fileHashes['manifest.json'] = textHash(
    `${JSON.stringify(manifest, null, 2)}\n`,
    { prefix: true },
  );
  fileHashes['06-verification/package-hash.json'] = 'sha256:self-referential-skipped';
  allItems.push({
    path: '06-verification/package-hash.json',
    content: `${JSON.stringify(
      {
        _note: '本文件列出包内全部文件的 sha256。manifest.json 的 integrity.packageHash 是这些 hash 的 Merkle root。',
        algorithm: 'sha256',
        files: fileHashes,
      },
      null,
      2,
    )}\n`,
  });

  // 包内 verify.mjs —— 零依赖，接收方可直接跑
  allItems.push({ path: '06-verification/verify.mjs', content: buildVerifyScript() });

  // ⛔⛔ verify.mjs 必须进 hash 表，且必须**在 manifest 之后**入表。
  //   漏掉这一步的后果很隐蔽：verify.mjs 是「唯一被接收方执行的代码」，
  //   它不在 hash 表里 ⇒ 攻击者换掉它、让它输出「校验通过」，哈希校验抓不到。
  //   **自己验自己不算校验。** 这是本脚本第三轮验收才暴露的漏洞
  //   （由 bin/verify-evolution-package.mjs 的「未受完整性保护文件」检查抓出）。
  //
  //   代价：manifest 的 Merkle root 必须同步更新（它是对 fileHashes 的汇总）。
  //   顺序因此固定为：全部内容 → verify.mjs → 重算 fileHashes → 重算 Merkle
  //   → 重写 manifest → 再把 manifest 自己的 hash 补进表。
  const verifyContent = buildVerifyScript();
  const verifyItem = allItems.find((i) => i.path === '06-verification/verify.mjs');
  fileHashes['06-verification/verify.mjs'] = textHash(verifyItem.content, { prefix: true });
  // Merkle root 变了 ⇒ manifest 必须重写，否则 root 与表不一致（包内 verify 会报 INFO）
  const newRoot = merkleRoot(fileHashes);
  if (newRoot !== manifest.integrity.packageHash) {
    manifest.integrity.packageHash = newRoot;
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const mi = allItems.find((i) => i.path === 'manifest.json');
    mi.content = manifestText;
    fileHashes['manifest.json'] = textHash(manifestText, { prefix: true });
    // manifest 变了 ⇒ Merkle root 又变一次。做两轮即收敛（第二遍 root 稳定）。
    fileHashes['06-verification/package-hash.json'] = 'sha256:self-referential-skipped';
    allItems.find((i) => i.path === '06-verification/package-hash.json').content =
      `${JSON.stringify({
        _note: '本文件列出包内全部文件的 sha256。manifest.json 的 integrity.packageHash 是这些 hash 的 Merkle root。'
          + '注：verify.mjs 也在表内 —— 它是接收方唯一会执行的代码，不受保护等于校验形同虚设。',
        algorithm: 'sha256',
        files: fileHashes,
      }, null, 2)}\n`;
  }

  // ⛔ 重复路径自检：同路径出现两次 ⇒ 打包时后者覆盖前者，且 manifest 与
  //    package-hash 都会「一致地错」。这类 bug 不会报错，只会静默丢数据。
  //    （本脚本第一版就踩过：同域三张表共用一个文件名。）
  const seen = new Map();
  for (const it of allItems) {
    if (seen.has(it.path)) {
      console.error(`  ❌ 包内路径重复：${it.path}`);
      console.error('     ⇒ 打包会互相覆盖导致静默丢数据，拒绝导出。');
      process.exit(1);
    }
    seen.set(it.path, true);
  }

  // ── dry-run 清单 ──
  const totalBytes = allItems.reduce((n, i) => n + Buffer.byteLength(i.content, 'utf8'), 0);
  console.log(`\n  ── 将要导出的内容（${allItems.length} 个文件，${(totalBytes / 1024).toFixed(1)} KB）──`);
  for (const it of allItems) {
    const kb = (Buffer.byteLength(it.content, 'utf8') / 1024).toFixed(1);
    console.log(`    ${it.path.padEnd(48)} ${kb.padStart(8)} KB`);
  }

  console.log(`\n  ── 脱敏动作预览 ──`);
  console.log(`    D1 排除的域：${NEVER_EXPORT.map((x) => x.domain).join(', ')}`);
  console.log(`    D1/D3 排除项：${runtime.excluded.length} 条`);
  for (const e of runtime.excluded.slice(0, 6)) {
    console.log(`       [${e.rule}] ${e.what} —— ${e.why.slice(0, 80)}`);
  }
  if (runtime.excluded.length > 6) console.log(`       … 另有 ${runtime.excluded.length - 6} 条`);
  console.log(`    D2 泛化路径：${pathTotal} 处`);
  console.log(`    D3 整条排除：${redactionReport.ruleD3_excludedRecords} 张表`);
  console.log(`    D5 脱敏报告：04-runtime-snapshot/REDACTION-REPORT.json（${Buffer.byteLength(allItems.find((i) => i.path.endsWith('REDACTION-REPORT.json')).content, 'utf8')} 字节）`);
  console.log(`    D6 发布动作：无（本脚本不含任何网络调用）`);

  // ⚠️ 等级来自 manifest（实算），不是这里写死 —— 打印的与包里的必须一致。
  console.log(`\n  reproductionLevel = ${manifest.reproductionLevel}（实算）`);
  for (const r of manifest.reproductionLevelReasons) console.log(`     · ${r}`);
  console.log(`  ledgerProofAvailable = ${ledgerAvailable}${ledgerAvailable ? '' : `（${ledgerReason}）`}`);

  if (DRY_RUN) {
    console.log('\n  ── dry-run 结束，未落盘任何数据 ──');
    console.log('  ⛔ D4 人工确认闸门：真正打包需要显式 --confirm');
    console.log('     审阅上面清单后，确认无误再执行：');
    console.log(`       node bin/export-evolution-package.mjs --confirm --out=<路径>.tar.gz`);
    process.exit(0);
  }

  // ── --confirm：真正打包 ──
  if (!OUT_PATH) {
    console.error('\n  ❌ --confirm 必须配 --out=<路径>（不默认写盘，避免覆盖意外位置）');
    process.exit(1);
  }
  const tarEntries = allItems.map((i) => ({
    path: i.path,
    content: Buffer.from(i.content, 'utf8'),
    type: 'file',
  }));
  const gz = packTarGz(tarEntries);
  // 目标目录可能不存在（packages/ 是 gitignore 的 runtime 目录，首次导出时尚未建）
  const outDir = dirname(OUT_PATH);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(OUT_PATH, gz);
  console.log(`\n  ✅ 已写出 ${OUT_PATH}`);
  console.log(`     ${(gz.length / 1024).toFixed(1)} KB · ${allItems.length} 个文件`);
  console.log(`     packageHash ${manifest.integrity.packageHash}`);
  console.log('\n  接收方校验：tar -xzf <包> && node 06-verification/verify.mjs');
  process.exit(0);
}

/**
 * Merkle root：把「路径 → hash」表按路径排序后，把 hash 值依次拼接再哈希。
 *
 * ⭐⭐ 为什么排除 manifest.json 与 package-hash.json 这两项 ——
 *   这不是偷懒，是**固定点问题**：manifest.json 里装着 root，
 *   而 root 若把 manifest.json 算进去，则「改 root ⇒ 改 manifest ⇒ 改 root」
 *   无解，永远收敛不了。
 *   `package-hash.json` 同理（它是那张表本身，且自身是自指占位符）。
 *   ⇒ root 的定义域是**除两个载体之外的全部文件**。这样：
 *     · verify.mjs 入表后重算一次即收敛（它不是载体）；
 *     · manifest 重写不影响 root。
 *   载体自身由「逐文件 hash 校验」保护，不靠 root。
 *
 * ⭐ 为什么单独抽成函数：verify.mjs 入包后要**重算一次 root 并回写 manifest**。
 *   算法写两处必然分叉 —— 分叉后表现为「表与 root 差一项」，
 *   而这种错误在包内 verify 里只是 INFO 级提示，不会报错 ⇒ 静默不可信。
 */
const ROOT_EXCLUDED = new Set(['manifest.json', '06-verification/package-hash.json']);
function merkleRoot(fileHashes) {
  const sortedHashes = Object.entries(fileHashes)
    .filter(([p, h]) => !ROOT_EXCLUDED.has(p) && h !== 'sha256:self-referential-skipped')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, h]) => h);
  return textHash(sortedHashes.join('\n'), { prefix: true });
}

/** 生成包内 verify.mjs（零依赖，接收方直接跑）。 */function buildVerifyScript() {
  return `#!/usr/bin/env node
// 06-verification/verify.mjs —— 接收方校验脚本（零依赖，只用 node 内置模块）
//
// ⚠️ 本脚本【不输出】FULLY_REPRODUCIBLE —— R3 结构性不可达（见 05-environment/NOT-REPRODUCIBLE.md）。
//
// 用法：node verify.mjs            # 在解包后的包根目录运行
//      node verify.mjs --root=DIR  # 指定包根目录

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const rootArg = argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : process.cwd();

const findings = [];
const ok = (m) => findings.push({ level: 'OK', msg: m });
const fail = (m) => findings.push({ level: 'FAIL', msg: m });
const info = (m) => findings.push({ level: 'INFO', msg: m });

function sha256(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

console.log('[verify] 可复现进化包校验');
console.log('  包根 ' + ROOT);

// ① manifest
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  ok('manifest.json 可解析（packageId ' + manifest.packageId + '）');
} catch (e) {
  fail('manifest.json 读取失败：' + e.message);
}

// ② 逐文件 hash
if (manifest) {
  let ph;
  try {
    ph = JSON.parse(readFileSync(join(ROOT, '06-verification/package-hash.json'), 'utf8'));
  } catch (e) {
    fail('package-hash.json 读取失败：' + e.message);
  }
  if (ph) {
    let bad = 0;
    let missing = 0;
    for (const [p, expected] of Object.entries(ph.files)) {
      if (expected === 'sha256:self-referential-skipped') continue;
      const fp = join(ROOT, p);
      if (!existsSafe(fp)) { missing++; fail('缺文件：' + p); continue; }
      const actual = sha256(readFileSync(fp, 'utf8'));
      if (actual !== expected) { bad++; fail('hash 不符：' + p); }
    }
    if (bad === 0 && missing === 0) {
      ok('全部 ' + Object.keys(ph.files).length + ' 个文件 hash 一致 ⇒ INTEGRITY_VERIFIED');
    }
  }
}

// ③ Merkle root
// ⭐ 口径必须与导出侧 merkleRoot() 完全一致，三处对齐：
//   ① 排除 manifest.json（它装着 root，算进去就是固定点方程 ⇒ 无解）
//   ② 排除 package-hash.json（表自身，自指占位）
//   ③ 保留 'sha256:' 前缀
//   第一版三条全没做 ⇒ root 永远对不上 ⇒ 长期只报 INFO。
//   **一个永远对不上的校验等于没有校验**，只是没人看出来。
//   现在 root 已收敛，不等就是真不一致，必须 fail。
if (manifest && manifest.integrity) {
  try {
    const ph = JSON.parse(readFileSync(join(ROOT, '06-verification/package-hash.json'), 'utf8'));
    const sorted = Object.entries(ph.files)
      .filter(([p, h]) => p !== 'manifest.json'
        && p !== '06-verification/package-hash.json'
        && h !== 'sha256:self-referential-skipped')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, h]) => h);
    // ⚠️ 本脚本内的 sha256() **已返回带 'sha256:' 前缀的串**，不要再拼一次 ——
    //   拼两次会得到 'sha256:sha256:…'，而这是个 fail 级断言 ⇒ 假失败且极难定位。
    const root = sha256(sorted.join('\\n'));
    if (root === manifest.integrity.packageHash) {
      ok('Merkle root 一致 ⇒ 内容未被替换');
    } else {
      fail('Merkle root 与 manifest 记录不一致（算出 ' + root + '，清单记 '
        + manifest.integrity.packageHash + '）⇒ 有内容文件在成表之后被改动过');
    }
  } catch (e) {
    fail('Merkle root 校验失败：' + e.message);
  }
}

// ④ 脱敏报告非空（D5）
try {
  const rr = JSON.parse(readFileSync(join(ROOT, '04-runtime-snapshot/REDACTION-REPORT.json'), 'utf8'));
  if (rr.performed === true && rr.irreversible === true) {
    ok('脱敏报告非空且声明不可逆（规则 D5 满足）');
  } else {
    fail('脱敏报告缺少 performed/irreversible 声明 ⇒ 脱敏可能未执行');
  }
} catch (e) {
  fail('脱敏报告缺失（D5 要求强制产出）');
}

// ⑤ 路径泄露检查
const leaks = [];
scanForLeak(ROOT, leaks);
if (leaks.length === 0) {
  ok('未发现未泛化的绝对路径 ⇒ 规则 D2 生效');
} else {
  fail('发现疑似未泛化的绝对路径 ' + leaks.length + ' 处：' + leaks.slice(0, 5).join(', '));
}

// ⑥ Ledger proof
if (manifest && manifest.integrity) {
  if (manifest.integrity.ledgerProofAvailable) {
    info('Ledger proof 标为可用 —— 但本脚本未实现 Merkle proof 验证（Phase 1 收口后补）');
  } else {
    info('Ledger proof：NOT_AVAILABLE —— ' + (manifest.integrity.ledgerProofReason || '未说明原因'));
  }
}

function existsSafe(p) { try { statSync(p); return true; } catch { return false; } }

function scanForLeak(dir, out) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { scanForLeak(p, out); continue; }
    if (!/\\.(json|md|txt|patch)$/.test(e)) continue;
    const text = readFileSync(p, 'utf8');
    for (const re of [/[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/\\s"']+/g, /[A-Za-z]:[\\\\/]DSH/g, /[/\\\\]home[/\\\\][^/\\\\\\s"']+/g]) {
      const m = text.match(re);
      if (m) out.push(e + ':' + m[0].slice(0, 40));
    }
  }
}

console.log('');
for (const f of findings) {
  const tag = f.level === 'OK' ? '  ✓' : f.level === 'FAIL' ? '  ✗' : '  ·';
  console.log(tag + ' ' + f.msg);
}
const fails = findings.filter((f) => f.level === 'FAIL').length;
console.log('');
console.log('[verify] 结论');
if (fails === 0) {
  const level = manifest ? manifest.reproductionLevel : 'UNKNOWN';
  console.log('  INTEGRITY_VERIFIED · STRUCTURE_VERIFIED');
  console.log('  可达复现级别：' + level);
  console.log('  ⛔ 不提供 FULLY_REPRODUCIBLE —— R3 结构性不可达（见 05-environment/NOT-REPRODUCIBLE.md）');
  process.exit(0);
} else {
  console.log('  ❌ ' + fails + ' 项校验失败 —— 不可声称包完整');
  process.exit(1);
}
`;
}

main();
