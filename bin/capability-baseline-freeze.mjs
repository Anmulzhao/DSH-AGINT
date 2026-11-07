#!/usr/bin/env node
/**
 * bin/capability-baseline-freeze.mjs —— 冻结金标「就绪包」（模板 / 校验 / 密封）
 *
 * 2026-11-07「授权让最后一盏灯亮起来」：G2 是唯一剩下的闸，而 G2 的真值
 * 按定义必须由**授权人工**给出。本脚本把 A1～A3 的手工活压成三条命令，
 * 但 ⛔ 绝不代填任何真值：
 *
 *   - 不写 samples / label / labelAuthority / description / mechanicalCheck；
 *   - 不写 frozenBy / frozenAt（署名与时间必须由人给，占位值一律拒）；
 *   - 唯一被脚本写入的字段是 `contentHash` = canonicalHash(samples)，
 *     这是对**人已经填好的 samples** 做密封，不是生成内容。
 *
 * 用法：
 *   node bin/capability-baseline-freeze.mjs --template            # 打印单条样本形状，不写文件
 *   node bin/capability-baseline-freeze.mjs --check               # 只读体检（含治理校验）
 *   node bin/capability-baseline-freeze.mjs --seal gold           # 人填完后密封（只写 contentHash）
 *   node bin/capability-baseline-freeze.mjs --seal gold --dir <dir>
 *
 * ⛔ 密封后 `verifyBaseline()` 才可能判 READY；空集密封、未署名密封一律拒。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSet, checkSet, verifyBaseline, DEFAULT_SETS_DIR,
  SET_NAMES, EXTERNAL_AUTHORITIES, LAYERS,
} from './capability-baseline.mjs';
import { canonicalHash } from './lib/canonical-json.mjs';
import { LABEL_AUTHORITY_VALUES } from './lib/scenario-tier.mjs';

export const FREEZE_SCHEMA = '1.0';
export const SEALABLE_FIELD = 'contentHash';

/** ⛔ 这些署名一律视为「系统代签」，拒绝密封。人必须用可追溯的真实署名。 */
export const FORBIDDEN_FROZEN_BY = Object.freeze([
  '', 'agent', 'system', 'auto', 'script', 'ai', 'assistant', 'llm', 'model',
  'bot', 'generated', 'todo', 'tbd', '系统', '自动', '模型', '待填',
]);

/** 单条样本的形状说明（__EXAMPLE_ONLY__，绝不当作真实样本落盘）。 */
export const SAMPLE_TEMPLATE = Object.freeze({
  __EXAMPLE_ONLY__: true,
  id: 'cap-<L层>-<序号，如 cap-L3-001>',
  layer: 'L0 | L1 | L2 | L3 | L4 | L5',
  kind: 'mutator | integration | wiring | ...（自由描述，不参与校验）',
  description: '<机械可验证的任务描述，由人出题>',
  mechanicalCheck: '<怎么机械判定 PASS / REJECT，由人写清楚>',
  label: 'PASS | REJECT | null（⛔ 真值，必须人给）',
  labelAuthority: 'gold/heldout 用 GOLD 或 HELDOUT；verify 用 SILVER/UNSET（⛔ 绝不代填）',
  frozenBy: '<你的真实署名，⛔ 脚本拒绝代填>',
  frozenAt: '<ISO8601 时间，由人填>',
});

export function isPlaceholderSignature(v) {
  return FORBIDDEN_FROZEN_BY.includes(String(v ?? '').trim().toLowerCase());
}

/** ⛔ 路径硬判据：只许密封三份 set 文件，不许越出 sets 目录。 */
export function assertSealTarget(dir, name) {
  if (!SET_NAMES.includes(name)) {
    throw new Error(`SEAL_TARGET_NOT_ALLOWED: ${JSON.stringify(name)} 不在 ${SET_NAMES.join('/')}`);
  }
  const root = resolve(dir);
  const p = resolve(join(root, `${name}.json`));
  if (p !== join(root, `${name}.json`) || !p.startsWith(`${root}${sep}`)) {
    throw new Error(`SEAL_PATH_ESCAPE: ${p} 越出 sets 目录`);
  }
  if (!existsSync(p)) throw new Error(`SEAL_FILE_MISSING: ${p} 不存在`);
  return { ok: true, path: p, dir: root };
}

/**
 * 治理校验（比 verifyBaseline 多查「判定权来源」）。只读。
 * ⛔ verifyBaseline 只查密封/形状/交集，不查署名 —— 署名由本层补上。
 */
export function inspectSetGovernance(dir = DEFAULT_SETS_DIR) {
  const errors = [];
  const warnings = [];
  const perSet = {};

  for (const name of SET_NAMES) {
    const loaded = loadSet(dir, name);
    const checked = checkSet(loaded);
    const d = loaded.data ?? {};
    const setErrors = [];
    const authority = typeof d.authority === 'string' ? d.authority : '';

    if (name === 'verify' && EXTERNAL_AUTHORITIES.includes(authority)) {
      setErrors.push(`verify.authority=${authority} 不应是外部权威（避免验证集冒充冻结真值）`);
    }
    if ((name === 'gold' || name === 'heldout') && !EXTERNAL_AUTHORITIES.includes(authority)) {
      setErrors.push(`${name}.authority=${JSON.stringify(authority)} 须为 GOLD/HELDOUT（deriveAnchorAuthority 读它）`);
    }
    if (typeof authority !== 'string' || !authority.trim()) {
      setErrors.push(`${name}.authority 为空`);
    }
    // ⚠ verify 顶层 authority 是**用途标记**（真实既有值 "VERIFY"），
    //   deriveAnchorAuthority 只读 gold/heldout，不读它 ⇒ 不要求落在 labelAuthority 枚举内，
    //   ⛔ 工具不得倒逼人改既有数据。

    if (!loaded.exists || loaded.parseError || !Array.isArray(d.samples)) {
      setErrors.push(`${name}: 文件不可读或 samples 不是数组`);
      perSet[name] = { sealed: checked.sealed, samples: 0, authority, errors: setErrors, frozenSigned: false };
      errors.push(...setErrors.map((e) => `${name}: ${e}`));
      continue;
    }

    let signed = true;
    for (const [i, s] of d.samples.entries()) {
      const tag = `${name}.samples[${i}]`;
      if (!s || typeof s !== 'object') { setErrors.push(`${tag} 非对象`); continue; }
      if (typeof s.description !== 'string' || !s.description.trim()) setErrors.push(`${tag}.description 空：题目须由人出`);
      if (typeof s.mechanicalCheck !== 'string' || !s.mechanicalCheck.trim()) setErrors.push(`${tag}.mechanicalCheck 空：通过判据须由人写`);
      if (!LAYERS.includes(s.layer)) setErrors.push(`${tag}.layer 非法`);
      if (!LABEL_AUTHORITY_VALUES.includes(s.labelAuthority)) setErrors.push(`${tag}.labelAuthority 非法枚举`);
      if (!(s.label === 'PASS' || s.label === 'REJECT' || s.label === null)) setErrors.push(`${tag}.label 非法`);
      if (name === 'verify' && EXTERNAL_AUTHORITIES.includes(s.labelAuthority)) {
        setErrors.push(`${tag}.labelAuthority=${s.labelAuthority} ⇒ ⛔ verify 样本混进可用冻结标签分母`);
      }
      if (isPlaceholderSignature(s.frozenBy)) {
        signed = false;
        setErrors.push(`${tag}.frozenBy 缺失或为系统占位署名 ⇒ ⛔ 真值必须由人署名`);
      }
      if (typeof s.frozenAt !== 'string' || Number.isNaN(Date.parse(s.frozenAt))) {
        setErrors.push(`${tag}.frozenAt 缺失或不是 ISO8601 ⇒ 冻结时间必须由人填`);
      }
    }

    if (d.samples.length === 0) warnings.push(`${name}: 当前为空集（UNSEALED 合法，但密封前须先填样本）`);
    if (d.contentHash && d.contentHash !== canonicalHash(d.samples)) {
      setErrors.push(`${name}.contentHash 与 samples 不符 ⇒ 疑似篡改，请重新密封`);
    }
    // ⛔ 「有样本但 contentHash 为空」是**待密封的正常态**，不是治理违规：
    //    verifyBaseline 会把它记成 CORRUPT，但那正是 --seal 要修的状态，
    //    若当违规会让密封永远进不去（逻辑死锁）。
    for (const e of checked.errors.filter((x) => !/未密封/.test(x))) setErrors.push(`${name}: ${e}`);
    const needsSeal = d.samples.length > 0 && !d.contentHash;
    if (needsSeal) warnings.push(`${name}: 样本已填但未密封 ⇒ 运行 --seal ${name}`);

    perSet[name] = {
      sealed: needsSeal ? 'UNSEALED_PENDING' : checked.sealed,
      samples: d.samples.length,
      authority,
      contentHash: d.contentHash ?? '',
      expectedHash: d.samples.length ? canonicalHash(d.samples) : '',
      frozenSigned: signed && d.samples.length > 0,
      needsSeal,
      errors: setErrors,
    };
    errors.push(...setErrors.map((e) => `${name}: ${e}`));
  }

  const baseline = verifyBaseline(dir);
  const goldIds = new Set((loadSet(dir, 'gold').data?.samples ?? [])
    .map((s) => s?.id).filter(Boolean));
  const heldoutIds = (loadSet(dir, 'heldout').data?.samples ?? []).map((s) => s?.id).filter(Boolean);
  const overlap = heldoutIds.filter((id) => goldIds.has(id));
  if (overlap.length) errors.push(`GOLD_HELD_OUT_OVERLAP: ${overlap.join(', ')}（必须为空）`);

  return {
    schemaVersion: FREEZE_SCHEMA,
    dir,
    ok: errors.length === 0,
    errors,
    warnings,
    perSet,
    baselineVerdict: baseline.verdict,
    usableFrozenLabels: baseline.usableFrozenLabels,
    goldHeldoutOverlap: overlap,
    note: '⛔ 本层只读校验，不产出任何标签、不代替人署名、不评估能力。',
  };
}

/**
 * 密封一份 set：⛔ 唯一写入字段 contentHash。
 * 前置：治理校验全绿、该集 samples>0、人已署名。
 */
export function sealSet(dir, name) {
  const guard = assertSealTarget(dir, name);
  const gov = inspectSetGovernance(guard.dir);
  if (!gov.ok) return { ok: false, reason: 'GOVERNANCE_NOT_READY', errors: gov.errors, writes: 0 };

  const before = JSON.parse(readFileSync(guard.path, 'utf8'));
  if (!Array.isArray(before.samples) || before.samples.length === 0) {
    return { ok: false, reason: 'EMPTY_SET: 空集不密封（UNSEALED 是合法未就绪态）', writes: 0 };
  }
  const hash = canonicalHash(before.samples);
  const after = { ...before, [SEALABLE_FIELD]: hash };
  // ⛔ 逐字段对拍：除 contentHash 外任何字段都不许变。
  for (const k of Object.keys(before)) {
    if (k !== SEALABLE_FIELD && JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      return { ok: false, reason: `SEAL_WOULD_MODIFY_${k}: 拒绝改写任何非哈希字段`, writes: 0 };
    }
  }

  writeFileSync(guard.path, `${JSON.stringify(after, null, 2)}\n`, 'utf8');
  const confirm = JSON.parse(readFileSync(guard.path, 'utf8'));
  const baseline = verifyBaseline(guard.dir);
  return {
    ok: confirm.contentHash === canonicalHash(confirm.samples),
    writes: 1,
    path: guard.path,
    name,
    samples: confirm.samples.length,
    contentHash: confirm.contentHash,
    baselineVerdict: baseline.verdict,
    usableFrozenLabels: baseline.usableFrozenLabels.value ?? null,
    changedFields: [SEALABLE_FIELD],
    note: `⛔ 只写了 ${SEALABLE_FIELD}；samples / label / labelAuthority / frozenBy / frozenAt / authority 一律未动。`,
  };
}

function renderCheck(gov) {
  const L = [];
  L.push('冻结金标 · 就绪体检（只读）');
  L.push(`  判词 verifyBaseline=${gov.baselineVerdict} ｜ 可用冻结标签 ${gov.usableFrozenLabels.value ?? '无数据'}`);
  L.push(`  治理：${gov.ok ? '✓ 通过' : `x 未通过（${gov.errors.length} 项）`}`);
  for (const n of SET_NAMES) {
    const s = gov.perSet[n];
    L.push(`  ${n}: ${s.sealed} ｜ 样本 ${s.samples} ｜ authority=${s.authority} ｜ 已署名 ${s.frozenSigned ? '是' : '否'}`);
  }
  if (gov.goldHeldoutOverlap.length) L.push(`  ⛔ gold ∩ heldout = ${gov.goldHeldoutOverlap.join(', ')}`);
  for (const e of gov.errors) L.push(`    x ${e}`);
  for (const w of gov.warnings) L.push(`    ! ${w}`);
  L.push(`  ${gov.note}`);
  return `${L.join('\n')}\n`;
}

function parseArgs(argv) {
  const o = { mode: 'check', dir: DEFAULT_SETS_DIR, name: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--template') o.mode = 'template';
    else if (a === '--check') o.mode = 'check';
    else if (a === '--seal') { o.mode = 'seal'; o.name = argv[++i] ?? null; }
    else if (a === '--dir') o.dir = argv[++i] ?? DEFAULT_SETS_DIR;
    else if (a === '--json') o.json = true;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  let out;
  if (o.mode === 'template') {
    out = {
      schemaVersion: FREEZE_SCHEMA,
      __EXAMPLE_ONLY__: true,
      sampleShape: SAMPLE_TEMPLATE,
      topLevel: {
        authority: 'gold/heldout 用 GOLD 或 HELDOUT；verify 用 SILVER/UNSET',
        frozenBy: '<你的真实署名>',
        frozenAt: '<ISO8601>',
        contentHash: '<⛔ 不要手填，由 --seal 计算>',
        samples: '[] —— 把填好的样本对象放进这个数组',
      },
      steps: [
        '1. 按 L0–L5 逐层出 20–30 条机械可验证题目（见 eval/capability-baseline/README.md §2）',
        '2. 每条亲自给 label(PASS/REJECT) 与 labelAuthority；verify 绝不标 GOLD/HELDOUT',
        '3. 每条填 frozenBy（真实署名）与 frozenAt（ISO8601）',
        '4. 三份都填完 → node bin/capability-baseline-freeze.mjs --check',
        '5. 逐份 --seal gold / --seal verify / --seal heldout',
        '6. node bin/capability-baseline.mjs --json 判 READY；再跑心跳看 G2',
      ],
      note: '⛔ 模板不产生任何样本、不写任何文件；真值与署名必须由人给。',
      writes: 0,
    };
  } else if (o.mode === 'seal') {
    try { out = sealSet(o.dir, o.name); }
    catch (e) { out = { ok: false, reason: e.message, writes: 0, errors: [e.message] }; }
  } else {
    out = inspectSetGovernance(o.dir);
  }

  if (o.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else if (o.mode === 'check') process.stdout.write(renderCheck(out));
  else if (o.mode === 'seal') {
    process.stdout.write(`冻结金标 · 密封 ${o.name ?? '(未指定)'}\n`);
    process.stdout.write(`  结果：${out.ok ? '✓ 已密封' : 'x 拒绝'} ｜ 写入 ${out.writes} ｜ 理由 ${out.reason ?? 'OK'}\n`);
    if (out.ok) {
      process.stdout.write(`  contentHash=${out.contentHash} ｜ 样本 ${out.samples} ｜ verifyBaseline=${out.baselineVerdict}\n`);
      process.stdout.write(`  可用冻结标签 ${out.usableFrozenLabels} ｜ 改动字段 [${out.changedFields.join(', ')}]\n`);
      process.stdout.write(`  ${out.note}\n`);
    } else for (const e of out.errors ?? []) process.stdout.write(`    x ${e}\n`);
  } else {
    process.stdout.write('冻结金标 · 待填模板（⛔ 只是形状说明，不产生样本）\n');
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  }
  if (o.mode === 'seal' && !out.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
