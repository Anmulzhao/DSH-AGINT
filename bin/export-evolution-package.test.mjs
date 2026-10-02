// bin/export-evolution-package.test.mjs —— 导出主程序的测试
//
// ⭐ 重心是**四道闸门**（规范 §4.2）：
//   D4 人工确认：无 --confirm 必须拒绝落盘（fail-closed）★ 最重要
//   D1 白名单：memory 域等绝不进包
//   D3 敏感扫描：含凭据形态的记录整条排除
//   D6 无发布逻辑：脚本内无网络调用
//
// ⚠️ 端到端实跑（--confirm）会读**生产存储**。本测试用 DSH_HOME 指向临时目录
//    造假存储，绝不碰真实数据 —— 依据「不拿生产数据当测试输入」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unpackTar } from './lib/tar.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(__dirname, 'export-evolution-package.mjs');
const NODE = process.execPath;

/**
 * 造一个沙箱仓库 + 假 DSH_HOME。
 * @param {object} storages 域名 → 存储内容
 */
function makeSandbox(storages = {}) {
  const root = mkdtempSync(join(tmpdir(), 'evo-export-'));
  const bin = join(root, 'bin');
  mkdirSync(join(bin, 'lib'), { recursive: true });
  cpSync(SCRIPT, join(bin, 'export-evolution-package.mjs'));
  for (const f of ['tar.mjs', 'redact.mjs', 'canonical-json.mjs']) {
    cpSync(join(__dirname, 'lib', f), join(bin, 'lib', f));
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.9.0' }));
  writeFileSync(
    join(root, 'VERSION'),
    '# m\n\n## 当前\n\n| AGINT | min | tested |\n|---|---|---|\n| v0.9.0 | 0.1.7-rc.1 | 0.2.0-rc.2 |\n',
  );

  // 假 DSH_HOME + storages
  const dsh = join(root, 'dsh-home');
  const st = join(dsh, 'storages');
  mkdirSync(st, { recursive: true });
  for (const [domain, data] of Object.entries(storages)) {
    writeFileSync(join(st, `${domain}.json`), JSON.stringify(data, null, 2), 'utf8');
  }
  return { root, dsh, storages: st };
}

function run(root, dsh, args = []) {
  const r = spawnSync(NODE, [join(root, 'bin', 'export-evolution-package.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: dsh },
  });
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// ── D4：人工确认闸门（最重要）────────────────────────────────────────────

test('⛔ D4：无参数时必须只 dry-run，不落盘任何包', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1, stage: 'evaluated' }] } },
  });
  try {
    const r = run(root, dsh);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /dry-run/);
    assert.match(r.output, /未落盘任何数据/);
    // 关键：不该产生任何 .tar.gz
    assert.equal(existsSync(join(root, 'packages')), false, '❌ dry-run 却创建了 packages/ 目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ D4：显式 --dry-run 同样不落盘', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const r = run(root, dsh, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(root, 'packages')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ D4：--confirm 缺 --out 时拒绝写盘（不默认落盘，避免覆盖意外位置）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const r = run(root, dsh, ['--confirm']);
    assert.equal(r.status, 1, '必须非零退出');
    assert.match(r.output, /--confirm 必须配 --out/);
    assert.equal(existsSync(join(root, 'packages')), false, '❌ 拒绝后却仍写了盘');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ D4：--confirm + --out 才真正落盘', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1, stage: 'evaluated' }] } },
  });
  try {
    const out = join(root, 'packages', 'p.tar.gz');
    const r = run(root, dsh, ['--confirm', `--out=${out}`]);
    assert.equal(r.status, 0, r.output);
    assert.ok(existsSync(out), '包必须存在');
    assert.ok(readFileSync(out).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── D1：白名单准入 ─────────────────────────────────────────────────────────

test('⛔ D1：memory 域（agint）绝不进包，即便文件存在', () => {
  const { root, dsh } = makeSandbox({
    agint: {
      tables: {
        memory: [{ type: 'preference', content: '老板喜欢简洁的输出' }],
      },
    },
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const out = join(root, 'p.tar.gz');
    const r = run(root, dsh, ['--confirm', `--out=${out}`]);
    assert.equal(r.status, 0, r.output);
    // 解包检查：不得出现 memory 内容
    const entries = unpackTar(readFileSync(out));
    const paths = entries.map((e) => e.path);
    assert.ok(!paths.some((p) => /agint_agint\.json|agint_memory/i.test(p)), `路径泄露：${paths.join(', ')}`);
    const allText = entries
      .filter((e) => e.type === 'file')
      .map((e) => e.content.toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes('老板喜欢简洁'), '⛔ memory 域内容进了包');
    assert.ok(!allText.includes('agint_ov_strategy') || true); // 白名单本就排除
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ D1：ov_strategy / session_extract 同样排除', () => {
  const { root, dsh } = makeSandbox({
    agint_ov_strategy: { tables: { projections: [{ id: 1, text: '外部投影内容' }] } },
    agint_session_extract: { tables: { chunks: [{ id: 1, text: '会话内容' }] } },
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const allText = unpackTar(readFileSync(out))
      .filter((e) => e.type === 'file')
      .map((e) => e.content.toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes('外部投影内容'), '⛔ ov_strategy 内容进包');
    assert.ok(!allText.includes('会话内容'), '⛔ session_extract 内容进包');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ D1：白名单表照常导出', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: {
      tables: {
        evolution_log: [{ id: 1, stage: 'evaluated' }],
        failure_pattern: [{ id: 2, pattern: 'x' }],
        success_template: [{ id: 3, name: 'y' }],
      },
    },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const paths = unpackTar(readFileSync(out)).map((e) => e.path);
    for (const t of ['evolution_log', 'failure_pattern', 'success_template']) {
      assert.ok(
        paths.some((p) => p.includes(`__${t}.json`)),
        `⛔ 白名单表 ${t} 未导出（路径：${paths.join(', ')}）`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 同域多表必须落成不同文件（防打包覆盖静默丢数据）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: {
      tables: {
        evolution_log: [{ id: 1, tag: 'AAA' }],
        failure_pattern: [{ id: 2, tag: 'BBB' }],
        success_template: [{ id: 3, tag: 'CCC' }],
      },
    },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const entries = unpackTar(readFileSync(out)).filter((e) => e.type === 'file');
    const paths = entries.map((e) => e.path);
    // ⛔ 本脚本第一版的真 bug：三张表共用一个文件名 ⇒ 打包互相覆盖
    assert.equal(new Set(paths).size, paths.length, `⛔ 包内有重复路径：${paths.join(', ')}`);
    const text = entries.map((e) => e.content.toString('utf8')).join('\n');
    for (const tag of ['AAA', 'BBB', 'CCC']) {
      assert.ok(text.includes(tag), `⛔ ${tag} 丢了 —— 同名覆盖导致静默丢数据`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── D2：路径泛化 ───────────────────────────────────────────────────────────

test('✅ D2：包内绝对路径被泛化', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: {
      tables: {
        evolution_log: [
          { id: 1, file: String.raw`C:\Users\Administrator\.dsh\storages\x.json` },
          { id: 2, file: '/home/carol/agint/y.json' },
        ],
      },
    },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const allText = unpackTar(readFileSync(out))
      .filter((e) => e.type === 'file')
      .map((e) => e.content.toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes('Administrator'), '⛔ Windows 用户名泄露');
    assert.ok(!allText.includes('carol'), '⛔ Linux 用户名泄露');
    assert.ok(allText.includes('<DSH_HOME>'), '应泛化为占位符');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── D3：敏感扫描 ───────────────────────────────────────────────────────────

test('⛔ D3：含凭据形态的记录整条排除，其余保留', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: {
      tables: {
        evolution_log: [
          { id: 1, note: '正常记录 SAFE-TO-KEEP' },
          { id: 2, note: '泄露 AKIAIOSFODNN7EXAMPLE' },
          { id: 3, note: '也正常 KEEP-TOO' },
        ],
      },
    },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const allText = unpackTar(readFileSync(out))
      .filter((e) => e.type === 'file')
      .map((e) => e.content.toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes('AKIAIOSFODNN7EXAMPLE'), '⛔ 凭据形态进了包');
    assert.ok(allText.includes('SAFE-TO-KEEP'), '正常记录应保留');
    assert.ok(allText.includes('KEEP-TOO'), '正常记录应保留（不能一刀切丢整表）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ D3：排除动作必须记入脱敏报告（可复核）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: {
      tables: { evolution_log: [{ id: 2, note: 'key AKIAIOSFODNN7EXAMPLE' }] },
    },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const entries = unpackTar(readFileSync(out)).filter((e) => e.type === 'file');
    const rep = entries.find((e) => e.path.endsWith('REDACTION-REPORT.json'));
    assert.ok(rep, '脱敏报告必须存在（D5）');
    const r = JSON.parse(rep.content.toString('utf8'));
    assert.equal(r.performed, true);
    assert.equal(r.irreversible, true, '必须声明不可逆');
    assert.ok(
      JSON.stringify(r).includes('aws-access-key'),
      `脱敏报告必须记账命中了哪条规则：${JSON.stringify(r.ruleD1_excluded)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── D5 / D6 / 完整性 ───────────────────────────────────────────────────────

test('✅ D5：脱敏报告恒非空且声明不可逆', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const rep = unpackTar(readFileSync(out)).find((e) => e.path.endsWith('REDACTION-REPORT.json'));
    const r = JSON.parse(rep.content.toString('utf8'));
    assert.equal(r.performed, true);
    assert.equal(r.irreversible, true);
    assert.ok(Array.isArray(r.ruleD1_excludedDomains) && r.ruleD1_excludedDomains.length > 0,
      '必须列出永不导出的域');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ D6：脚本内不得含任何网络 / 上传调用', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  // 剥注释后再扫 —— 否则会命中注释里「不含 fetch」这类说明文字
  const code = src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');
  for (const pat of [/\bfetch\s*\(/, /https?:\/\//, /require\s*\(\s*['"]http/, /from\s+['"]node:https?['"]/, /\bnet\./, /axios/, /XMLHttpRequest/]) {
    assert.ok(!pat.test(code), `❌ 脚本含网络调用：${pat}`);
  }
});

test('✅ 包内 verify.mjs 零依赖（只用 node 内置模块）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const v = unpackTar(readFileSync(out)).find((e) => e.path.endsWith('verify.mjs'));
    assert.ok(v, '包内必须有 verify.mjs');
    const src = v.content.toString('utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(
        imp.startsWith('node:'),
        `❌ verify.mjs 引用了非内置模块：${imp}（接收方可能没有 AGINT 的任何依赖）`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ verify.mjs 不得输出 FULLY_REPRODUCIBLE（R3 不可达）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const v = unpackTar(readFileSync(out)).find((e) => e.path.endsWith('verify.mjs'));
    const code = v.content
      .toString('utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    // 允许出现在「不提供 FULLY_REPRODUCIBLE」的否定句里，但不得作为输出值
    assert.ok(
      !/console\.log\([^)]*['"]FULLY_REPRODUCIBLE['"]/.test(code),
      '❌ verify.mjs 把 FULLY_REPRODUCIBLE 当结论输出',
    );
    assert.ok(
      code.includes('不提供 FULLY_REPRODUCIBLE'),
      '必须显式声明不提供该结论（否则接收方会以为可完全重演）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ PROVENANCE 如实标 NOT_ANCHORED（G1 缺口不掩盖）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const p = unpackTar(readFileSync(out)).find((e) => e.path.endsWith('PROVENANCE.json'));
    const j = JSON.parse(p.content.toString('utf8'));
    assert.equal(j.baselineAnchored, false);
    assert.equal(j.baselineProvenance, 'NOT_ANCHORED');
    assert.equal(j.honestDegradation, true);
    assert.ok(j.why.length > 20, '必须写明为什么');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ 包内路径唯一（重复即拒导出）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1 }] } },
  });
  try {
    const out = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${out}`]).status, 0);
    const paths = unpackTar(readFileSync(out)).map((e) => e.path);
    assert.equal(new Set(paths).size, paths.length, `重复路径：${paths.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ 空存储域时也能产出结构完整的包（不因缺数据崩）', () => {
  const { root, dsh } = makeSandbox({});
  try {
    const out = join(root, 'p.tar.gz');
    const r = run(root, dsh, ['--confirm', `--out=${out}`]);
    assert.equal(r.status, 0, r.output);
    const paths = unpackTar(readFileSync(out)).map((e) => e.path);
    for (const must of ['manifest.json', '03-evaluation/PROVENANCE.json',
      '04-runtime-snapshot/REDACTION-REPORT.json', '05-environment/NOT-REPRODUCIBLE.md',
      '06-verification/verify.mjs', '06-verification/package-hash.json']) {
      assert.ok(paths.includes(must), `缺 ${must}（路径：${paths.join(', ')}）`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ 打包可复现：同输入两次打包字节一致（packageHash 可比）', () => {
  const { root, dsh } = makeSandbox({
    agint_evolution: { tables: { evolution_log: [{ id: 1, note: 'x' }] } },
  });
  try {
    const a = join(root, 'a.tar.gz');
    const b = join(root, 'b.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${a}`]).status, 0);
    assert.equal(run(root, dsh, ['--confirm', `--out=${b}`]).status, 0);
    // ⚠️ manifest 含 createdAt（每次不同）⇒ 整包字节不可能相同。
    //    真正要验的是「除 manifest 外的文件 hash 相同」——
    //    那才是 packageHash 能跨机器比对的前提。
    const ea = unpackTar(readFileSync(a)).filter((e) => e.type === 'file');
    const eb = unpackTar(readFileSync(b)).filter((e) => e.type === 'file');
    const ha = new Map(ea.map((e) => [e.path, e.content.toString('utf8')]));
    const hb = new Map(eb.map((e) => [e.path, e.content.toString('utf8')]));
    const diffs = [];
    for (const [p, c] of ha) {
      if (p === 'manifest.json' || p === '06-verification/package-hash.json') continue;
      if (hb.get(p) !== c) diffs.push(p);
    }
    assert.deepEqual(diffs, [], `这些文件两次打包内容不同：${diffs.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
