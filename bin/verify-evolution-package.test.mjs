// bin/verify-evolution-package.test.mjs —— 外部校验器的测试
//
// ⭐ 重心不是「能验出好包」，而是**必须能验出坏包**。
//   一个只会通过的校验器等于没有校验器。所以每个用例都先导出真包、
//   再动手篡改，断言校验器**报红**。
//
// ⚠️ 端到端会读生产存储。本测试全部用 DSH_HOME 指向临时目录造假存储，
//    绝不碰真实数据 —— 依据「不拿生产数据当测试输入」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { unpackTar, packTarGz } from './lib/tar.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORTER = join(__dirname, 'export-evolution-package.mjs');
const VERIFIER = join(__dirname, 'verify-evolution-package.mjs');
const NODE = process.execPath;

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'evo-verify-'));
  const bin = join(root, 'bin');
  mkdirSync(join(bin, 'lib'), { recursive: true });
  cpSync(EXPORTER, join(bin, 'export-evolution-package.mjs'));
  cpSync(VERIFIER, join(bin, 'verify-evolution-package.mjs'));
  for (const f of ['tar.mjs', 'redact.mjs', 'canonical-json.mjs']) {
    cpSync(join(__dirname, 'lib', f), join(bin, 'lib', f));
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.9.0' }));
  writeFileSync(
    join(root, 'VERSION'),
    '# m\n\n## 当前\n\n| AGINT | min | tested |\n|---|---|---|\n| v0.9.0 | 0.1.7-rc.1 | 0.2.0-rc.2 |\n',
  );
  const dsh = join(root, 'dsh-home');
  const st = join(dsh, 'storages');
  mkdirSync(st, { recursive: true });
  writeFileSync(join(st, 'agint_evolution.json'), JSON.stringify({
    tables: { evolution_log: [{ id: 1, stage: 'evaluated' }] },
  }, null, 2), 'utf8');
  return { root, dsh };
}

function exportPkg(root, dsh, out) {
  const r = spawnSync(NODE, [join(root, 'bin', 'export-evolution-package.mjs'), '--confirm', `--out=${out}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: dsh },
  });
  return r;
}

function verify(root, pkg, extra = []) {
  const r = spawnSync(NODE, [join(root, 'bin', 'verify-evolution-package.mjs'), pkg, ...extra], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}` };
}

/** 重新打包（用于篡改）。保持 tar/gz 格式一致，只有内容变了。 */
function repack(srcPkg, dstPkg, mutate) {
  const entries = unpackTar(gunzipSync(readFileSync(srcPkg)));
  mutate(entries);
  writeFileSync(dstPkg, packTarGz(entries));
}

function setContent(entries, path, text) {
  const e = entries.find((x) => x.path === path);
  assert.ok(e, `样本前提：包内应存在 ${path}`);
  e.content = Buffer.from(text, 'utf8');
}

test('✅ 好包必须全绿，且如实给出等级并拒绝 FULLY_REPRODUCIBLE', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const v = verify(root, pkg);
    // ⚠️ 沙箱不是 git 仓库、无 preimage ⇒ 等级必须**降到 R0**。
    //   这里断言 R0 是在钉「等级必须实算」：第一版硬编码 'R1'，
    //   空 01-code 也宣称代码级可复现 ⇒ 接收方据此对不上任何东西。
    assert.equal(v.status, 0, v.output);
    assert.match(v.output, /INTEGRITY_VERIFIED/);
    assert.match(v.output, /STRUCTURE_VERIFIED/);
    assert.match(v.output, /可达复现级别：R0/);
    assert.match(v.output, /不提供 FULLY_REPRODUCIBLE/);
    // 降级理由必须打印出来，否则「R0」对接收方是无解释的降级
    assert.match(v.output, /降级理由/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 篡改任一内容文件必须报 hash 不一致（不许放过）', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      const target = es.find((e) => e.path.endsWith('evolution_log.json'));
      const o = JSON.parse(target.content.toString('utf8'));
      o.rows[0].stage = 'TAMPERED';
      target.content = Buffer.from(JSON.stringify(o, null, 2), 'utf8');
    });
    const v = verify(root, bad);
    assert.equal(v.status, 1, `⛔ 篡改后仍通过 —— 校验器形同虚设\n${v.output}`);
    assert.match(v.output, /hash 不一致/);
    assert.match(v.output, /不可声称该包完整/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 塞入带凭据的文件必须被 D3 复扫抓住', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      es.push({
        path: '04-runtime-snapshot/evil.json',
        content: Buffer.from(JSON.stringify({ k: 'AKIAIOSFODNN7EXAMPLE' }), 'utf8'),
        type: 'file',
      });
    });
    const v = verify(root, bad);
    assert.equal(v.status, 1, `⛔ 凭据残留未被抓住\n${v.output}`);
    // 既要报「不在 hash 表」，也要报「凭据残留」
    assert.match(v.output, /未受完整性保护|凭据形态残留/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 未泛化的绝对路径必须被泄露复扫抓住', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      const target = es.find((e) => e.path === '03-evaluation/PROVENANCE.json');
      const o = JSON.parse(target.content.toString('utf8'));
      o.why = '本机路径 C:\\Users\\Administrator\\.dsh\\storages 泄露了';
      target.content = Buffer.from(JSON.stringify(o, null, 2), 'utf8');
    });
    const v = verify(root, bad);
    assert.equal(v.status, 1, `⛔ 路径泄露未被抓住\n${v.output}`);
    assert.match(v.output, /绝对路径/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 谎报 R3（完整重演化）必须被拒 —— R3 结构性不可达', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      const mf = es.find((e) => e.path === 'manifest.json');
      const o = JSON.parse(mf.content.toString('utf8'));
      o.reproductionLevel = 'R3';
      mf.content = Buffer.from(`${JSON.stringify(o, null, 2)}\n`, 'utf8');
      // manifest 变了 ⇒ 表里的 hash 也要跟着改，否则先被 hash 校验拦下，
      // 测的就不是「R3 检查」这一条了。
      const ph = es.find((e) => e.path === '06-verification/package-hash.json');
      const p = JSON.parse(ph.content.toString('utf8'));
      p.files['manifest.json'] = 'sha256:' + createHash('sha256').update(mf.content).digest('hex');
      ph.content = Buffer.from(`${JSON.stringify(p, null, 2)}\n`, 'utf8');
    });
    const v = verify(root, bad);
    assert.equal(v.status, 1, `⛔ R3 谎报未被拒\n${v.output}`);
    assert.match(v.output, /R3|自相矛盾|Merkle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 缺必备文件（删掉脱敏报告）必须报结构不完整', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      const i = es.findIndex((e) => e.path === '04-runtime-snapshot/REDACTION-REPORT.json');
      es.splice(i, 1);
    });
    const v = verify(root, bad);
    assert.equal(v.status, 1, `⛔ 缺文件未被报出\n${v.output}`);
    assert.match(v.output, /缺少必备文件/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 不支持的哈希算法必须拒绝降级校验（不许悄悄用弱算法）', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      setContent(es, '06-verification/package-hash.json', JSON.stringify({
        algorithm: 'md5', files: {},
      }, null, 2));
    });
    const v = verify(root, bad);
    assert.equal(v.status, 1, `⛔ 弱算法未被拒\n${v.output}`);
    assert.match(v.output, /拒绝降级/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 损坏的包必须报「无法解析」而不是崩栈', () => {
  const { root } = makeSandbox();
  try {
    const junk = join(root, 'junk.tar.gz');
    // 双重破坏：gzip 头不对 + 内容不是 tar
    writeFileSync(junk, Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), gzipSync(Buffer.from('not a tar at all'))]));
    const v = verify(root, junk);
    assert.notEqual(v.status, 0, '⛔ 损坏包竟通过了');
    assert.match(v.output, /无法解析|损坏|invalid|incorrect|check/i);
    assert.doesNotMatch(v.output, /at Object\.|at Module\._compile/, '⛔ 抛了未捕获栈 —— 应转成结论');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 包不存在 / 不给参数：退出码 2，且不打印堆栈', () => {
  const { root } = makeSandbox();
  try {
    const a = verify(root, join(root, 'nope.tar.gz'));
    assert.equal(a.status, 2);
    assert.match(a.output, /包不存在/);
    const b = spawnSync(NODE, [join(root, 'bin', 'verify-evolution-package.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(b.status, 2);
    assert.match(`${b.stdout}${b.stderr}`, /用法/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ --json 输出可解析，且 passed 与退出码一致', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const v = verify(root, pkg, ['--json']);
    assert.equal(v.status, 0, v.output);
    // stdout 必须**只有** JSON（--json 模式不得混入人话）
    const j = JSON.parse(v.output.trim());
    assert.equal(j.passed, true);
    assert.equal(j.reproductionLevel, "R0");
    assert.ok(Array.isArray(j.findings) && j.findings.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ 校验器不得执行包内任何代码（只读字节）', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    // 放一个「若被执行就写文件」的探针进包
    const canary = join(root, 'CANARY');
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      es.push({
        path: '06-verification/evil.mjs',
        content: Buffer.from(`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(canary)}, 'pwned');\n`, 'utf8'),
        type: 'file',
      });
    });
    verify(root, bad);
    assert.equal(existsSync(canary), false, '⛔ 校验器执行了包内代码 —— 校验不可信');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⛔ verify.mjs 自身必须受 hash 表保护（自己验自己不算校验）', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    // 只换 verify.mjs 的内容、其余不动 —— 若它在表内，必然被逐文件校验抓住
    const bad = join(root, 'bad.tar.gz');
    repack(pkg, bad, (es) => {
      const t = es.find((e) => e.path === '06-verification/verify.mjs');
      t.content = Buffer.from(t.content.toString('utf8').replace('INTEGRITY_VERIFIED', 'ALL_GOOD_BOI'), 'utf8');
    });
    const v = verify(root, bad);
    assert.equal(v.status, 1, `⛔ 换掉 verify.mjs 未被抓 —— 包内校验器不受保护\n${v.output}`);
    assert.match(v.output, /hash 不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('✅ 内外两条校验链结论一致（同一判据、两个实现）', () => {
  const { root, dsh } = makeSandbox();
  try {
    const pkg = join(root, 'p.tar.gz');
    assert.equal(exportPkg(root, dsh, pkg).status, 0);
    const ext = verify(root, pkg);
    // 跑包内那份
    const unpackDir = join(root, 'unpacked');
    mkdirSync(unpackDir, { recursive: true });
    const entries = unpackTar(gunzipSync(readFileSync(pkg)));
    for (const e of entries) {
      const p = join(unpackDir, e.path);
      if (e.type === 'dir') { mkdirSync(p, { recursive: true }); continue; }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.content);
    }
    const inner = spawnSync(NODE, [join(unpackDir, '06-verification/verify.mjs')], { cwd: unpackDir, encoding: 'utf8' });
    assert.equal(ext.status, inner.status, `⛔ 内外结论不一致\n外部:\n${ext.output}\n内部:\n${inner.stdout}${inner.stderr}`);
    assert.equal(ext.status, 0, inner.stdout);
    // 两条链都必须独立算出同一个 Merkle root —— 这是「同一判据、两个实现」的实质。
    // ⚠️ 不能靠「输出里出现这个 hash」来判断：包内那份只在 root **不一致**时打印
    //    算出的值，一致时只打印「一致」二字。所以改为**各自独立复算后比对**。
    const mf = JSON.parse(readFileSync(join(unpackDir, 'manifest.json'), 'utf8'));
    const ph = JSON.parse(readFileSync(join(unpackDir, '06-verification/package-hash.json'), 'utf8'));
    const sorted = Object.entries(ph.files)
      .filter(([p, h]) => p !== 'manifest.json'
        && p !== '06-verification/package-hash.json'
        && h !== 'sha256:self-referential-skipped')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, h]) => h);
    // ⚠️ 变量名不能叫 `root` —— 本函数已有一个沙箱目录 root（TDZ 直接报
    //    "Cannot access 'root' before initialization"，且报错位置离病因很远）。
    const mroot = 'sha256:' + createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
    assert.equal(mroot, mf.integrity.packageHash, '独立复算的 root 应与 manifest 一致');
    // 外部链打印的 root 必须就是这个值（它的输出里有 root 片段可对）
    assert.ok(ext.output.includes(mroot.slice(7, 27)), `外部链未报出 root 片段：${mroot}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
