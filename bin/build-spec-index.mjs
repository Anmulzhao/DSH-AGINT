#!/usr/bin/env node
// bin/build-spec-index.mjs —— 协议索引生成/校验器（Phase 3 交付物一，Tier A）
//
// 职责：扫描 docs/specs/，生成或校验 INDEX.json。
//
// ⛔ 形态决策（Phase 3 设计 §6.5）：协议是**仓库内的文档资产 + 一个索引文件**，
//    **不是运行时服务**。不新建插件、不新建存储域。
//    依据：路线图.md:271 红线「不引入新的中心化宏观架构层」。
//
// ⭐ 核心价值：把「规范文件」与「代码实况」的对应关系变成**可自动校验的**。
//    本系列方案反复查出的问题就是文档与代码脱节（Phase 2 §0 查出 3 处矛盾、
//    §0.1 查出场景基线过期）。索引里的 status / implementedBy 字段是
//    **诚实性载体** —— 每个字段都必须经代码核实后填写。
//
// 用法：
//   node bin/build-spec-index.mjs            # 生成/更新 INDEX.json
//   node bin/build-spec-index.mjs --check    # 只校验不写盘（CI / 门禁用）
//
// ⚠️ --check 必须早于写盘，否则它会拿刚生成的版本跟自己对账 ⇒ 永远「一致」
//    ⇒ 门禁变成自证循环。这个坑是本脚本第一版的真实 bug，已修并有单测钉住。

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash, textHash } from './lib/canonical-json.mjs';
import { computeSpecHash } from './lib/spec-hash.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SPECS_DIR = join(REPO_ROOT, 'docs', 'specs');
const INDEX_PATH = join(SPECS_DIR, 'INDEX.json');
const MATRIX_PATH = join(SPECS_DIR, 'compatibility-matrix.json');
const VERSION_PATH = join(REPO_ROOT, 'VERSION');

const INDEX_VERSION = '1.0';
const GENERATED_BY = 'bin/build-spec-index.mjs';

/** status 枚举。语义严格 —— 见 statusLegend。 */
const STATUS_VALUES = ['ACTIVE', 'DESIGN', 'BLOCKED', 'ARCHIVED'];

/**
 * 「不是规范」的磁盘文件白名单 —— 生成器与一致性门禁**必须共用同一份**。
 *
 * ⭐ 踩过的坑：两份各写一份判据 ⇒ 生成器认为 X 是孤儿、`--check` 却认为 X 已登记
 *   （或反过来）。表现为「刚跑完生成器，`--check` 立刻报错」，看起来像生成器坏了，
 *   实际是两个判据分叉了 —— 与 K133 的「同源共用」是同一类问题。
 *
 * ⛔ 每个条目都必须能回答「它为什么不是一份 spec」。答不上来就不该加。
 */
export const NON_SPEC_FILES = new Set([
  'INDEX.json',                 // 索引本身
  'compatibility-matrix.json',  // 版本兼容规则（非能力契约）
  'dependency-inventory.json',  // 依赖清单（非行为约定）
  'market-readiness-gaps.md',   // 缺口台账：**待办清单**不是契约（登记成 spec 会让 Blocked 像已定规范）
]);

/**
 * 规范登记表 —— 单一事实源。
 *
 * ⭐ 这里的每一项都必须经**代码核实**后填写，不能凭「文件存在」推断能力已具备。
 *    `implementedBy` 尤其重要：文件存在 ≠ 运行时已挂载 ≠ 有生产数据。
 *    三者是三件事（K129：看到一个差异先问「为什么」）。
 *
 * 填表纪律：
 *   status=ACTIVE  ⇒ 必须有生产数据或运行时已挂载，二者至少其一，并写进 evidence
 *   status=DESIGN  ⇒ 规范已定，实现未落地。**这是最容易被虚报的状态**
 *   status=BLOCKED ⇒ 被外部条件阻塞，规范先行（写清阻塞源）
 *   status=ARCHIVED⇒ 已存档，不在当前周期实施
 */
const REGISTRY = [
  {
    id: 'evolution-contract',
    version: '1.0',
    status: 'DESIGN',
    files: ['evolution-contract-v1.schema.json', 'evolution-contract-v1.md'],
    owner: 'agint-evolution-driver',
    machineReadable: true,
    dependencies: [],
    consumers: ['bin/validate-contract-schema.mjs', 'agint-evolution-driver/lib/contract-manager.js'],
    implementedBy:
      '⚠️ schema 校验器已实装（bin/validate-contract-schema.mjs，含 20 用例自测）；' +
      'contract-manager.js 存在于 plugins/agint-evolution-driver/lib/，' +
      '但**未被 index.js import**（实测 grep 零命中）⇒ 未挂载为运行时服务。' +
      '生产 contract_locks 表 0 行。⇒ 判 DESIGN，不判 ACTIVE。',
    evidence: [
      'bin/validate-contract-schema.mjs 存在且 --fixtures 20 用例',
      'plugins/agint-evolution-driver/lib/contract-manager.js 存在（216 行）',
      'grep "contract-manager" plugins/ 仅命中自身与 prediction-scoring.js 的一句注释',
      '生产 ~/.dsh/storages/agint_evolution.json 的 tables 只有 3 张（evolution_log / failure_pattern / success_template），无 contract_locks',
    ],
  },
  {
    id: 'evaluation-protocol',
    version: '1.0',
    status: 'DESIGN',
    files: ['evaluation-protocol-v1.md'],
    owner: 'agint-evolution-driver',
    machineReadable: false,
    dependencies: [],
    consumers: ['bin/build-scenario-inventory.mjs', 'bin/check-spec-consistency.mjs'],
    implementedBy:
      '⚠️ **协议已实装，能力未落地**（这是本条判 DESIGN 的原因）：' +
      'inventory.json 的 123 个单元已带 visibility + labelAuthority 两字段，' +
      '生成器 --check 可校验枚举合法性；但 visibility 全为 EVOLUTION' +
      '（Phase 0 三层隔离未落地）、labelAuthority 全为 UNSET' +
      '（external-anchor 提案 2026-10-01 已存档）⇒ **字段存在 ≠ 能力具备**。',
    evidence: [
      'eval/scenarios/inventory.json 123/123 单元含 visibility 与 labelAuthority',
      'bin/build-scenario-inventory.mjs --check 枚举校验生效（5 个新单测钉住，含防自证循环）',
      'eval/scenarios/ 下只有 dedicated/ 与 mocks/，无三层目录（实测）',
    ],
    conflictsResolved: ['phase0-frozen-vs-anchor-heldout'],
  },
  {
    id: 'evolution-package',
    version: '1.0',
    status: 'DESIGN',
    files: ['evolution-package-v1.md'],
    owner: 'agint-evolution-driver',
    machineReadable: false,
    dependencies: ['evolution-contract', 'evaluation-protocol'],
    consumers: ['bin/export-evolution-package.mjs', 'bin/verify-evolution-package.mjs'],
    implementedBy:
      '⚠️ **部分实施**（2026-10-03 端到端实跑）。已实施：D1–D6 脱敏闸门、可复现打包' +
      '（tar+gzip 定 mtime=0 / level=9 ⇒ 同输入同字节）、逐文件 sha256、Merkle root、' +
      '包内 verify.mjs 与外部 bin/verify-evolution-package.mjs 双路校验（13 项测试）。' +
      '未实施：01-code/diff.patch（只给 preimage-manifest.json 清单）、02-contract/ 与 ' +
      '03-evaluation/benchmark-results.json 分区（依赖 contract-manager 挂载与 Evolution Ledger）。' +
      'reproductionLevel 为**实算**：git HEAD + preimage 同时成立才给 R1，否则降 R0。' +
      'ledgerProofAvailable 恒为 false ⇒ R2 不可达。',
    evidence: [
      'node bin/export-evolution-package.test.mjs ⇒ 19/19 PASS',
      'node bin/verify-evolution-package.test.mjs ⇒ 13/13 PASS（每个用例都先篡改再断言报红）',
      '2026-10-03 端到端：packages/test-R1.tar.gz 48.5 KB · 15 文件 · 内外双路 INTEGRITY_VERIFIED',
      '生产 agint_evolution.json 无 evolution_ledger 表 ⇒ 无 Merkle proof 可用（2026-10-03 实测）',
    ],
    blockedBy: ['evolution-ledger'],
  },
];

/**
 * 阻塞关系（登记但未建规范者）。
 *
 * ⭐ 为什么要显式登记「已识别但未落地」的规范：
 *    否则后来者 grep docs/specs/ 会以为「没登记 = 不存在」，
 *    从而重新设计一遍 —— 这正是 Phase 2 §5.1「按类推填空」的同型风险（K129）。
 */
const PENDING = [
  {
    id: 'evolution-ledger',
    version: '1.0',
    status: 'DESIGN',
    plannedFiles: ['evolution-ledger-v1.md'],
    owner: 'agint-evolution-memory',
    blockedBy: [],
    note:
      '⚠️ **代码全套已实装但生产零落行**（Phase 3 启动时实测）：' +
      'lib/ledger.js + ledger-hash.js + ledger-anchor.js + ledger-rebuild.js，' +
      'bin/verify-ledger-chain.mjs + anchor-ledger.mjs + rebuild-ledger-history.mjs，' +
      'cron job `ledger-anchor` 已在 jobs.js 声明。' +
      '但生产 evolution_ledger 表 0 行、`verify-ledger-chain.mjs` 报 LEDGER_EMPTY ⇒ ' +
      '**已实装 ≠ 已跑通**。规范化时必须核实这两件事，不能只看代码存在。',
  },
  {
    id: 'benchmark-isolation',
    version: '1.0',
    status: 'DESIGN',
    plannedFiles: ['benchmark-isolation-v1.md'],
    owner: 'agint-evolution-driver',
    note: 'Phase 0 §3 三层隔离的规范化。⚠️ 三层目录实测未落地，规范化会固化一个不存在的机制。',
  },
  {
    id: 'prediction-scoring',
    version: '1.0',
    status: 'DESIGN',
    plannedFiles: ['prediction-scoring-v1.md'],
    owner: 'agint-evolution-driver',
    note: 'Phase 1 §2。prediction-scoring.js 存在（纯函数），但宿主 contract-manager 未挂载 ⇒ 链路未通。',
  },
  {
    id: 'strategy-space',
    version: '1.0',
    status: 'BLOCKED',
    plannedFiles: ['strategy-space-v1.md'],
    owner: 'agint-evolution-driver',
    blockedBy: ['Phase 2 未启动'],
    note: 'Phase 2 §3。Phase 2 整体未启动 ⇒ 规范先行。',
  },
  {
    id: 'memory-utility',
    version: '1.0',
    status: 'BLOCKED',
    plannedFiles: ['memory-utility-v1.md'],
    owner: 'agint-evolution-memory',
    blockedBy: ['Phase 2 未启动'],
    note: 'Phase 2 §2。Phase 2 整体未启动 ⇒ 规范先行。',
  },
  {
    id: 'cross-model-validation',
    version: '1.0',
    status: 'BLOCKED',
    plannedFiles: ['cross-model-validation-v1.md'],
    owner: 'agint-evolution-driver',
    blockedBy: ['dsh 官方市场 GA', '第二个真实使用方'],
    note:
      'Phase 2 §4。**外部硬阻塞**（Phase 3 §0.4）—— ' +
      '只做协议预留，不做接入设计。当前本机模型 = minimax-cn / MiniMax-M3.1-Flash-Preview。',
  },
  {
    // ⭐ Phase-3 设计稿 §4 整章（交付物四）此前**在索引里没有条目**——
    //   后果是「市场接入是 Blocked」这个判定只活在设计稿正文里，
    //   任何只看 INDEX.json 的人会以为 Phase 3 只有三个交付物。
    //   §4.4 验收项 7 要求的正是这条登记，故补上。
    id: 'market-integration',
    version: '0.0',
    status: 'BLOCKED',
    plannedFiles: ['market-integration-v1.md'],
    owner: '(未指派 —— 依赖 dsh 官方定标准)',
    blockedBy: [
      'B1 private:true 未解除（AGINT）',
      'B2 dsh 官方市场未 GA（dsh）',
      'B3 无第二个真实使用方（外部）',
      'B4 无 SBOM / 签名格式标准（dsh 定标准）',
    ],
    note:
      'Phase 3 §4 交付物四。**Blocked，只做元数据补全与缺口清单，不做接入设计。** ' +
      '已完成的可执行部分：`repository`/`files`/`keywords`/`engines`/`bugs`/`homepage` 已补全并由 ' +
      '`check-publish-safety.mjs` 机器校验；`private:true` 按 B1 保留；B1~B8 缺口见 ' +
      '`docs/specs/market-readiness-gaps.md`。⛔ 仓库内无 Registry 客户端 / 市场接入 / 上传代码 —— ' +
      '若出现即违反 §4.4 验收项 6。',
  },
];

/**
 * 「已被登记」的磁盘文件全集 = specs 的 files + pendingSpecs 的 plannedFiles。
 *
 * ⭐ 两个段都要算：第一版只算 specs.files ⇒ 未落地规范的 plannedFiles
 *   被报成「未登记」，而它明明在索引里 pendingSpecs 段写着。
 *   孤儿检查的判据错了，比没有孤儿检查更糟 —— 它会训练人忽略这条告警。
 */
const REGISTERED_FILES = new Set([
  ...REGISTRY.flatMap((s) => s.files),
  ...PENDING.flatMap((s) => s.plannedFiles || []),
]);
function readDshCompat() {
  const text = readFileSync(VERSION_PATH, 'utf8');
  // 匹配形如：| v0.9.0 | 0.1.7-rc.1   | 0.2.0-rc.2  | ... |
  const row = text.match(/^\|\s*v\d+\.\d+\.\d+\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|/m);
  if (!row) return { minimum: 'UNKNOWN', tested: 'UNKNOWN' };
  return { minimum: row[1], tested: row[2] };
}

function readAgintVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

/**
 * 算 spec 的 machineReadable 文件 hash（schemaHash）。
 *
 * ⭐ 实现抽到 bin/lib/spec-hash.mjs —— 生成器与 check-spec-consistency.mjs 共用。
 *    两份实现必然会分叉（改一处忘另一处 ⇒ 门禁永远绿或永远红），K110 同源。
 */
function schemaHashOf(files) {
  return computeSpecHash({ files }, SPECS_DIR);
}

/** 列出 docs/specs/ 下应被索引的实体文件（排除索引与矩阵自身）。 */
function listSpecFiles() {
  if (!existsSync(SPECS_DIR)) return [];
  // ⛔ 这里曾有第三份硬编码排除（INDEX.json / compatibility-matrix.json / dependency-inventory.json），
  //   与 NON_SPEC_FILES 并存 ⇒ 新增白名单项时只改一处就分叉。
  //   现在唯一来源是 NON_SPEC_FILES —— 加白名单只改一个地方。
  return readdirSync(SPECS_DIR)
    .filter((f) => /\.(md|json)$/.test(f) && !NON_SPEC_FILES.has(f))
    .sort();
}

function buildIndex() {
  const specs = REGISTRY.map((s) => ({
    ...s,
    schemaHash: schemaHashOf(s.files),
  }));

  return {
    indexVersion: INDEX_VERSION,
    generatedBy: GENERATED_BY,
    agintVersion: readAgintVersion(),
    dshCompat: readDshCompat(),
    statusLegend: {
      ACTIVE: '已实施且有生产数据或运行时已挂载（evidence 段必须给出依据）',
      DESIGN: '规范已定，实现未落地 —— ⚠️ 最容易被虚报的状态',
      BLOCKED: '被外部条件阻塞，规范先行',
      ARCHIVED: '已存档（如 external-anchor 提案），不在当前周期实施',
    },
    honestyNote:
      '⚠️ 本索引由脚本从 REGISTRY 生成，REGISTRY 的每个字段须经代码核实后填写。' +
      '「文件存在」≠「运行时已挂载」≠「有生产数据」—— 这是三件事。' +
      '判 ACTIVE 必须能指出后两者之一，并写进 evidence。',
    specs,
    pendingSpecs: PENDING,
    untrackedSpecFiles: listSpecFiles().filter(
      (f) => !REGISTERED_FILES.has(f) && !NON_SPEC_FILES.has(f),
    ),
  };
}

/** 校验逻辑抽出来，供 --check 与 check-spec-consistency.mjs 复用。 */
export function validateIndex(index, specFilesOnDisk) {
  const errors = [];

  for (const s of index.specs ?? []) {
    if (!STATUS_VALUES.includes(s.status)) {
      errors.push(`${s.id}：status = ${JSON.stringify(s.status)} 不在枚举 ${STATUS_VALUES.join('/')}`);
    }
    for (const dep of s.dependencies ?? []) {
      if (!(index.specs ?? []).some((x) => x.id === dep)) {
        errors.push(`${s.id}：dependencies 里的 ${dep} 未在本索引登记（悬空依赖）`);
      }
    }
    for (const f of s.files ?? []) {
      if (!specFilesOnDisk.includes(f)) {
        errors.push(`${s.id}：files 里的 ${f} 在 docs/specs/ 下不存在（悬空引用）`);
      }
    }
    if (s.status === 'ACTIVE' && !(s.evidence ?? []).length) {
      errors.push(`${s.id}：status=ACTIVE 但 evidence 为空 —— ACTIVE 必须给出依据，否则视为虚报`);
    }
  }

  // 反向：磁盘上的 spec 文件必须被索引（防孤儿规范）
  const indexed = new Set(index.specs.flatMap((s) => s.files ?? []));
  for (const f of specFilesOnDisk) {
    if (!indexed.has(f)) {
      errors.push(`孤儿规范：docs/specs/${f} 未被 INDEX.json 登记`);
    }
  }

  return errors;
}

/**
 * schemaHash 漂移检查 —— 「规范改了但索引没重新生成」。
 *
 * ⭐ 为什么要单独抽出来（2026-10-03 实施 cron 巡检时暴露）：
 *   这段判据原先**只写在 main() 的 --check 分支里**，没被导出。于是
 *   `validateIndex` 这个名字听起来像「全部校验」，实际不含漂移检查 ——
 *   任何按名字复用它的调用方（本次是 cron 的 spec-index-refresh）都会
 *   **查不出最常见的那种漂移**，且一路绿灯 ⇒ 一道假防线。
 *   「函数名承诺的覆盖面」必须等于「实际覆盖面」，否则复用即埋雷。
 *
 * @param {object} index    磁盘上的 INDEX.json（已解析）
 * @param {object} fresh    buildIndex() 的结果（用于取重算后的 schemaHash）
 * @returns {string[]} 错误列表
 */
export function validateSchemaHashDrift(index, fresh) {
  const errors = [];
  const byId = new Map((fresh.specs ?? []).map((s) => [s.id, s.schemaHash]));
  for (const s of index.specs ?? []) {
    if (byId.has(s.id) && s.schemaHash !== byId.get(s.id)) {
      errors.push(
        `${s.id}：schemaHash 与磁盘文件不一致（索引 ${s.schemaHash} vs 实际 ${byId.get(s.id)}）` +
          ` ⇒ 规范改了但索引未重新生成`,
      );
    }
  }
  return errors;
}

/** 按磁盘现状重算一份索引（不写盘）。审计与 --check 共用同一份判据来源。 */
export function computeIndex() {
  return buildIndex();
}

/** 列出 docs/specs/ 下应被索引的实体文件（排除索引与矩阵自身）。 */
export function listSpecFilesOnDisk() {
  return listSpecFiles();
}

function main() {
  const CHECK_ONLY = process.argv.includes('--check');
  const onDisk = listSpecFiles();
  const index = buildIndex();

  if (CHECK_ONLY) {
    // ⚠️ 必须早于写盘（本脚本第一版的真实 bug —— 详见文件头注释）
    if (!existsSync(INDEX_PATH)) {
      console.error('[build-spec-index] ❌ INDEX.json 不存在。修法：跑 `node bin/build-spec-index.mjs`');
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    // ⛔ 判据必须与 cron 巡检共用同一份（validateSchemaHashDrift / validateIndex）。
    //   这里自己写一遍就是分叉的起点 —— 而分叉的方向恰好是「--check 能查出的
    //   漂移，cron 查不出」，也就是巡检永远绿灯。
    const errors = [
      ...validateIndex(existing, onDisk),
      ...validateSchemaHashDrift(existing, buildIndex()),
    ];
    if (errors.length > 0) {
      console.error(`[build-spec-index] ❌ 索引校验失败（${errors.length} 处）：`);
      for (const e of errors) console.error(`  - ${e}`);
      console.error('\n⇒ 修法：改规范后跑 `node bin/build-spec-index.mjs` 重新生成。');
      process.exit(1);
    }
    console.log(
      `[build-spec-index] ✅ --check 通过：${existing.specs.length} 份规范已登记` +
        `${(existing.pendingSpecs ?? []).length ? ` · ${existing.pendingSpecs.length} 份已识别未落地` : ''}`,
    );
    process.exit(0);
  }

  writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`[build-spec-index] 已写入 ${INDEX_PATH}`);
  // ⭐ 状态分布必须**两段都数**。第一版只数 specs 段 ⇒ 打印「BLOCKED 0」，
  //   而 pendingSpecs 里躺着 6 份 BLOCKED —— 摘要行会让人以为「没有阻塞项」，
  //   恰好把最该被看见的信息藏起来了（观测字段按「最能归因」设计，K116 纪律 B）。
  const tally = (list) =>
    STATUS_VALUES.reduce((acc, s) => ({ ...acc, [s]: list.filter((x) => x.status === s).length }), {});
  const a = tally(index.specs);
  const b = tally(index.pendingSpecs);
  const fmt = (t) => STATUS_VALUES.map((s) => `${s} ${t[s]}`).join(' / ');
  console.log(`  已落地规范 ${index.specs.length} 份（${fmt(a)}）`);
  console.log(`  已识别未落地 ${index.pendingSpecs.length} 份（${fmt(b)}）` +
    `${index.pendingSpecs.some((p) => p.status === 'BLOCKED') ? ' ⛔ 有 BLOCKED 项，见 blockedBy' : ''}`);
  console.log(`    ↑ 未落地项不占 implementedBy，防「没登记=不存在」误判`);
  console.log(`  AGINT ${index.agintVersion} · dsh ${index.dshCompat.minimum} / tested ${index.dshCompat.tested}`);
  if (index.untrackedSpecFiles.length > 0) {
    console.warn(`  ⚠️ 未登记的 spec 文件 ${index.untrackedSpecFiles.length} 个：${index.untrackedSpecFiles.join(', ')}`);
  }
  process.exit(0);
}

// 仅在直接运行时执行（被 import 时只导出 validateIndex）
if (process.argv[1] && process.argv[1].endsWith('build-spec-index.mjs')) {
  main();
}
