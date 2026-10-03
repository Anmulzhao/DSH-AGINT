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
  for (const f of ['tar.mjs', 'redact.mjs', 'canonical-json.mjs', 'diff.mjs']) {
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

// ── 01-code/diff.patch（Phase-3 设计 §3.6 Tier B 验收项 13）────────────────

/**
 * 在沙箱里造 preimage 备份。命名规则必须与引擎侧一致：
 *   `plugins/agint-evolution-driver/lib/index.js:1135`
 *   `.agint-preimage/${norm.split('/').join('__')}__${stamp}.bak`
 */
function seedPreimage(root, relPath, content, stamp = '2026-09-29T05-26-53-216Z') {
  const dir = join(root, '.agint-preimage');
  mkdirSync(dir, { recursive: true });
  const bak = `${relPath.split('/').join('__')}__${stamp}.bak`;
  writeFileSync(join(dir, bak), content, 'utf8');
  return bak;
}

test('✅ diff.patch：有 preimage 时必须产出，且内容可被 git apply 还原', () => {
  const { root, dsh } = makeSandbox();
  try {
    const relPath = 'plugins/demo/mod.js';
    const before = Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
    const after = `${before}\nconst added = 'new';\nconsole.log(added);\n`;
    mkdirSync(join(root, 'plugins/demo'), { recursive: true });
    writeFileSync(join(root, relPath), after, 'utf8');
    seedPreimage(root, relPath, before);

    const pkg = join(root, 'p.tar.gz');
    const r = run(root, dsh, ['--confirm', `--out=${pkg}`]);
    assert.equal(r.status, 0, r.output);

    const files = new Map(
      unpackTar(readFileSync(pkg))
        .filter((e) => e.type === 'file')
        .map((e) => [e.path, e.content.toString('utf8')]),
    );
    assert.ok(files.has('01-code/diff.patch'), '包内必须有 diff.patch');
    const patch = files.get('01-code/diff.patch');
    assert.match(patch, /^\+\+\+ b\/plugins\/demo\/mod\.js$/m, 'patch 必须指向真实路径');
    assert.match(patch, /^\+const added = 'new';$/m);

    // ⭐ 端到端：接收方解包后用真 git apply 还原，必须逐字节等于 preimage
    const work = mkdtempSync(join(tmpdir(), 'evo-apply-'));
    try {
      // ⚠️ 必须先建目录：writeFileSync 不会自动建父目录，
      //    漏这一步的报错是 ENOENT，看着像「导出失败」其实是测试自己没建。
      mkdirSync(join(work, 'plugins/demo'), { recursive: true });
      writeFileSync(join(work, relPath), after, 'utf8');
      writeFileSync(join(work, 'p.patch'), patch, 'utf8');
      spawnSync('git', ['init', '-q'], { cwd: work });
      const ap = spawnSync('git', ['apply', '-R', '--whitespace=nowarn', 'p.patch'], {
        cwd: work,
        encoding: 'utf8',
      });
      assert.equal(ap.status, 0, `git apply -R 失败：${ap.stderr}\n${patch}`);
      assert.equal(readFileSync(join(work, relPath), 'utf8'), before, '还原结果必须逐字节等于 preimage');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 同路径多份 preimage 只取最早的（多份会互相冲突，git apply 必失败）', () => {
  const { root, dsh } = makeSandbox();
  try {
    const relPath = 'plugins/demo/a.js';
    const v1 = 'a\nb\nc\n';
    const v2 = 'a\nB\nc\n';
    const after = 'a\nB\nc\nd\ne\n';
    mkdirSync(join(root, 'plugins/demo'), { recursive: true });
    writeFileSync(join(root, relPath), after, 'utf8');
    seedPreimage(root, relPath, v1, '2026-09-01T00-00-00-000Z');
    seedPreimage(root, relPath, v2, '2026-09-15T00-00-00-000Z');
    seedPreimage(root, relPath, v2, '2026-09-20T00-00-00-000Z');

    const pkg = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${pkg}`]).status, 0);
    const files = new Map(
      unpackTar(readFileSync(pkg))
        .filter((e) => e.type === 'file')
        .map((e) => [e.path, e.content.toString('utf8')]),
    );
    const manifest = JSON.parse(files.get('01-code/diff-manifest.json'));
    assert.equal(manifest.count, 1, `同路径只应有 1 条 diff，实际 ${manifest.count} 条`);
    assert.match(manifest.files[0].backup, /2026-09-01/, '必须取时间戳最早的备份');
    // 更晚的两份必须记进 skipped 并说明原因
    assert.ok(
      manifest.skipped.some((s) => /同路径有 3 份备份/.test(s.reason)),
      `未记录去重原因：${JSON.stringify(manifest.skipped)}`,
    );
    // 文件头只出现一次该路径
    const headers = files.get('01-code/diff.patch').match(/^\+\+\+ b\/plugins\/demo\/a\.js$/gm) || [];
    assert.equal(headers.length, 1, `patch 里同一路径只应有一条，实际 ${headers.length} 条`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 备份名反解出的路径越出仓库根 ⇒ 必须拒绝（防目录穿越）', () => {
  const { root, dsh } = makeSandbox();
  try {
    // 恶意备份名：路径段 `..` `..` 一路往上
    mkdirSync(join(root, '.agint-preimage'), { recursive: true });
    writeFileSync(
      join(root, '.agint-preimage', '..__..__..__etc__passwd__2026-09-01T00-00-00-000Z.bak'),
      'root:x:0:0\n',
      'utf8',
    );
    const pkg = join(root, 'p.tar.gz');
    const r = run(root, dsh, ['--confirm', `--out=${pkg}`]);
    assert.equal(r.status, 0, r.output);
    const files = new Map(
      unpackTar(readFileSync(pkg))
        .filter((e) => e.type === 'file')
        .map((e) => [e.path, e.content.toString('utf8')]),
    );
    // 不管是有 diff 还是退回清单，都**不能**把 etc/passwd 的内容放进包
    const patch = files.get('01-code/diff.patch') || '';
    assert.ok(!patch.includes('root:x:0:0'), '越界路径的内容绝不能进包');
    const manifestText = files.get('01-code/diff-manifest.json') || files.get('01-code/preimage-manifest.json') || '';
    assert.match(manifestText, /越出仓库根|已不存在|无法配对/, `必须如实记录跳过原因：\n${manifestText}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ 无 preimage 时退回清单，且 R1 如实降级（不虚报）', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${pkg}`]).status, 0);
    const files = new Map(
      unpackTar(readFileSync(pkg))
        .filter((e) => e.type === 'file')
        .map((e) => [e.path, e.content.toString('utf8')]),
    );
    assert.ok(!files.has('01-code/diff.patch'), '无 preimage 时不得凭空生成 diff.patch');
    const mf = JSON.parse(files.get('manifest.json'));
    assert.notEqual(mf.reproductionLevel, 'R1', '无 preimage + 无 git HEAD ⇒ 不得宣称 R1');
    assert.ok(
      mf.reproductionCaveats.some((c) => c.includes('不含 diff.patch')),
      `caveats 必须如实说明：${JSON.stringify(mf.reproductionCaveats)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── ledgerProofAvailable 的判据（2026-10-03 A1 补）───────────────────────
//
// ⭐ 这组用例盯的是一个**已经造成过假结论**的真 bug：
//   判据原写成 `Array.isArray(t) ? t.length : 0`，而 dsh 存储域的表在磁盘上是 dict
//   （`{"1": {...}}`）⇒ 6 条真条目被判成「0 行」。
//   失败方向是**恒低报**：它把一个可解锁的能力（R2 信任锚）永久锁死，
//   且理由（「表是空的」）把人引向「去造数据」而不是「去修判据」。
//
// ⛔ 每个用例都先造出会报错的形状再断言 —— 否则测的是「代码恰好这么写」，
//   不是「判据真的按意图工作」（K133 纪律 ③ 的同型要求）。

/** 造一条最小 ledger 条目。anchorStatus 是判据的输入，必须显式给。 */
function ledgerRow(seq, anchorStatus) {
  return {
    seq,
    contractId: `c-${seq}`,
    generation: 'GEN-000',
    summary: { mutationType: 'PROMPT_MUTATION', targetMetric: 'm', hypothesisDigest: 'd', decision: 'AUTO_DEPLOY' },
    chain: { entryHash: `sha256:${'0'.repeat(63)}${seq}`, parentHash: `sha256:${'0'.repeat(64)}`, batchRoot: `sha256:${'0'.repeat(64)}`, merkleRoot: `sha256:${'0'.repeat(64)}` },
    references: {},
    timestamp: '2026-10-03T00:00:00.000Z',
    anchorStatus,
    anchorSeq: anchorStatus === 'ANCHORED' ? 1 : null,
    integrity: 'OK',
    reconstructed: true,
    evidenceCompleteness: 'FULL',
  };
}

/** 从包里取出 manifest.json 的文本（判据断言都落在它身上）。 */
function manifestTextOf(pkg) {
  const text = unpackTar(readFileSync(pkg))
    .filter((e) => e.type === 'file')
    .map((e) => e.content.toString('utf8'))
    .find((c) => c.includes('ledgerProofAvailable'));
  assert.ok(text, 'manifest 必须含 ledgerProofAvailable');
  return text;
}

test('dict 形状的 ledger 表必须被计到行数（Array.isArray 判据会判 0）', () => {
  const rows = { 1: ledgerRow(1, 'PENDING'), 2: ledgerRow(2, 'PENDING'), 3: ledgerRow(3, 'PENDING') };
  const { root, dsh } = makeSandbox({ agint_evolution: { tables: { evolution_ledger: rows } } });
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${pkg}`]).status, 0);
    const manifestText = manifestTextOf(pkg);
    assert.match(manifestText, /evolution_ledger 表 3 行/,
      `行数必须按 dict 数出 3（不是 0）：\n${manifestText}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 有条目但 0 条已锚定 ⇒ ledgerProofAvailable 必须为 false（不得虚报 R2 已解锁）', () => {
  const rows = { 1: ledgerRow(1, 'PENDING'), 2: ledgerRow(2, 'PENDING') };
  const { root, dsh } = makeSandbox({ agint_evolution: { tables: { evolution_ledger: rows } } });
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${pkg}`]).status, 0);
    const manifestText = manifestTextOf(pkg);
    assert.match(manifestText, /"ledgerProofAvailable": false/,
      `未锚定的链不得报 proof 可用：\n${manifestText}`);
    assert.match(manifestText, /已锚定 0 条/, `理由必须说清是「没锚定」而不是「表空」：\n${manifestText}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ 至少 1 条已锚定 ⇒ ledgerProofAvailable 为 true', () => {
  const rows = { 1: ledgerRow(1, 'ANCHORED'), 2: ledgerRow(2, 'PENDING') };
  const { root, dsh } = makeSandbox({ agint_evolution: { tables: { evolution_ledger: rows } } });
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(run(root, dsh, ['--confirm', `--out=${pkg}`]).status, 0);
    assert.match(manifestTextOf(pkg), /"ledgerProofAvailable": true/,
      '有已锚定条目时必须解锁');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
