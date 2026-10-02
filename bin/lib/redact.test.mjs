// bin/lib/redact.test.mjs —— 脱敏原语测试（路径泛化 D2 + 敏感扫描 D3）
//
// ⭐ 重心是**顺序敏感**与**真实数据形态**：
//   · 路径规则有优先级（DSH_HOME 必须先于 HOME）—— 顺序错了会丢信息
//   · 敏感扫描宁可误报不可漏报 —— 但误报不能多到把正常数据全干掉
//   · 报告不带原文 —— 否则脱敏报告本身成为新的泄露面

import test from 'node:test';
import assert from 'node:assert/strict';
import { generalizePaths, scanSensitive, scanSensitiveDeep, redactText, PATH_RULES, SENSITIVE_PATTERNS } from './redact.mjs';

// ── D2 路径泛化 ─────────────────────────────────────────────────────────────

test('D2: Windows DSH_HOME 路径被泛化', () => {
  const r = generalizePaths('配置文件在 C:\\Users\\Administrator\\.dsh\\storages\\agint_evolution.json');
  assert.equal(r.count, 1);
  assert.ok(!r.text.includes('Administrator'), `❌ 用户名残留：${r.text}`);
  assert.ok(r.text.includes('<DSH_HOME>'), r.text);
});

test('D2: 本机仓库路径 D:/DSH/... 被泛化', () => {
  const r = generalizePaths('改的是 D:/DSH/project源码/DSH-AGINT/plugins/agint-cron/lib/jobs.js');
  assert.ok(r.count >= 1);
  assert.ok(!/D:\/DSH/.test(r.text) && !r.text.includes('D:/DSH'), `❌ 仓库路径残留：${r.text}`);
  assert.ok(r.text.includes('<AGINT_REPO>'), r.text);
});

test('D2: 容器内 /workspace/DSH-AGINT 被泛化', () => {
  const r = generalizePaths('容器里是 /workspace/DSH-AGINT/AGINT-data/wiki/x.md');
  assert.ok(r.count >= 1);
  assert.ok(!r.text.includes('/workspace/DSH-AGINT'), r.text);
});

test('D2: Linux 家目录 /home/<name> 被泛化为 <HOME>', () => {
  const r = generalizePaths('日志在 /home/openclaw/agint/logs/x.log');
  assert.ok(r.count >= 1);
  assert.ok(!r.text.includes('openclaw'), `❌ 用户名残留：${r.text}`);
  assert.ok(r.text.includes('<HOME>'));
});

test('D2: ⭐ 优先级 —— DSH_HOME 必须先于 HOME（否则丢这层信息）', () => {
  const r = generalizePaths('C:\\Users\\Bob\\.dsh\\x.json');
  // 只能泛化一次，且必须是 DSH_HOME
  assert.equal(r.count, 1, 'D:\\Users\\Bob\\.dsh 只能被一条规则吃掉，不能被两条');
  assert.ok(r.text.startsWith('<DSH_HOME>'), `❌ 被泛化成了 HOME 而非 DSH_HOME：${r.text}`);
});

test('D2: 顺序在规则表里被显式声明（前缀越具体越靠前）', () => {
  // 这条测试锁住规则表的顺序意图 —— 有人调换顺序时会被抓到
  const idx = (needle) => PATH_RULES.findIndex((r) => r.replacement === needle);
  assert.ok(idx('<DSH_HOME>') < idx('<HOME>'), 'DSH_HOME 规则必须排在 HOME 之前');
  assert.ok(
    PATH_RULES.every((r) => typeof r.why === 'string' && r.why.length > 10),
    '每条规则都必须写 why —— 没有理由的替换表就是后门',
  );
});

test('D2: 正斜杠形态（JSON 里的路径）也泛化', () => {
  const r = generalizePaths('{"file":"C:/Users/Administrator/.dsh/storages/x.json"}');
  assert.ok(r.count >= 1, 'JSON 里的正斜杠路径同样要泛化');
  assert.ok(!r.text.includes('Administrator'), r.text);
});

test('D2: 无路径时 count=0（不虚报）', () => {
  const r = generalizePaths('普通文本，没有任何路径');
  assert.equal(r.count, 0);
  assert.deepEqual(r.applied, []);
  assert.equal(r.text, '普通文本，没有任何路径');
});

test('D2: 多个路径全部泛化，计数正确', () => {
  const r = generalizePaths('a=D:/DSH/x b=C:/Users/Bob/.dsh/y c=/home/carol/z');
  assert.equal(r.count, 3, `三个路径都要泛化，applied=${JSON.stringify(r.applied)}`);
});

// ── D3 敏感扫描 ─────────────────────────────────────────────────────────────

test('D3: AWS access key 命中', () => {
  const r = scanSensitive('key=AKIAIOSFODNN7EXAMPLE');
  assert.ok(r.sensitive);
  assert.ok(r.hits.some((h) => h.id === 'aws-access-key'));
});

test('D3: PEM 私钥块命中', () => {
  const r = scanSensitive('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
  assert.ok(r.sensitive);
  assert.ok(r.hits.some((h) => h.id === 'private-key-block'));
});

test('D3: GitHub token 命中', () => {
  const r = scanSensitive('ghp_' + 'a'.repeat(36));
  assert.ok(r.sensitive);
  assert.ok(r.hits.some((h) => h.id === 'github-token'));
});

test('D3: ⛔ 报告不含原文（否则脱敏报告本身是泄露面）', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const r = scanSensitive(`key=${secret}`);
  const dumped = JSON.stringify(r);
  assert.ok(!dumped.includes(secret), '⛔ 扫描结果里绝不能出现匹配到的原文');
});

test('D3: 邮箱命中（PII）', () => {
  const r = scanSensitive('联系人 zhang.san@example.com');
  assert.ok(r.sensitive);
  assert.ok(r.hits.some((h) => h.id === 'email'));
});

test('D3: 中国大陆手机号命中（PII）', () => {
  const r = scanSensitive('老板手机 13812345678');
  assert.ok(r.sensitive);
  assert.ok(r.hits.some((h) => h.id === 'cn-mobile'));
});

test('D3: 内网地址命中', () => {
  for (const ip of ['192.168.1.88', '10.0.0.5', '172.16.1.134']) {
    assert.ok(scanSensitive(`host=${ip}`).sensitive, `${ip} 必须被识别为内网地址`);
  }
});

test('D3: ⛔ 公网地址不应误判为内网（误报率要可控）', () => {
  for (const ip of ['8.8.8.8', '142.250.72.14']) {
    const r = scanSensitive(`dns=${ip}`);
    assert.ok(!r.hits.some((h) => h.id === 'internal-host'), `${ip} 是公网地址，不该命中内网规则`);
  }
});

test('D3: 连接串内嵌凭据命中', () => {
  const r = scanSensitive('postgres://admin:s3cret@db.internal:5432/agint');
  assert.ok(r.sensitive);
  assert.ok(r.hits.some((h) => h.id === 'conn-str-with-credential'));
});

test('D3: JWT 命中', () => {
  const r = scanSensitive('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
  assert.ok(r.sensitive);
  assert.ok(r.hits.some((h) => h.id === 'jwt'));
});

test('D3: 普通技术文本不误判（否则整条排除机制会瘫痪）', () => {
  const clean = [
    'evolution_log 记录了 2026-10-03 的一次 cron job 失败',
    'composite=70 thresholds=70/60 ⇒ AUTO_DEPLOY',
    '文件 plugins/agint-cron/lib/jobs.js 第 42 行',
    'sha256:3e3ff4fc4b7eccb4674cf42e4a374a9167d88b28889cd2f14f12bc1e6a58dec1',
    'rootCause=TOOL_GAP',
  ];
  for (const t of clean) {
    const r = scanSensitive(t);
    assert.equal(r.sensitive, false, `❌ 误判：${t} ⇒ ${JSON.stringify(r.hits)}`);
  }
});

test('D3: 非字符串输入不炸（number / null / 对象）', () => {
  for (const v of [null, undefined, 42, true, {}, []]) {
    const r = scanSensitive(v);
    assert.equal(r.sensitive, false);
  }
});

// ── 深度扫描 ────────────────────────────────────────────────────────────────

test('深度扫描：对象树里的嵌套字符串能被扫到，且报出路径', () => {
  const rec = {
    id: 'x',
    meta: { author: 'zhang@example.com', tags: ['ok', 'AKIAIOSFODNN7EXAMPLE'] },
    nested: [{ note: '联系方式 13812345678' }],
  };
  const r = scanSensitiveDeep(rec);
  assert.ok(r.sensitive);
  assert.ok(r.paths.some((p) => p.includes('author')), `paths=${JSON.stringify(r.paths)}`);
  assert.ok(r.hits.some((h) => h.id === 'email'));
  assert.ok(r.hits.some((h) => h.id === 'aws-access-key'));
  assert.ok(r.hits.some((h) => h.id === 'cn-mobile'));
});

test('深度扫描：干净对象不报', () => {
  const r = scanSensitiveDeep({ a: 1, b: '普通文本', c: { d: ['x', 'y'] } });
  assert.equal(r.sensitive, false);
  assert.deepEqual(r.hits, []);
});

test('深度扫描：路径用点号 + 方括号，可直接定位到字段', () => {
  const r = scanSensitiveDeep({ a: { b: [{ c: 'mail me at x@y.cn' }] } });
  assert.ok(r.paths.some((p) => p === 'a.b[0].c'), `paths=${JSON.stringify(r.paths)}`);
});

// ── 组合 ────────────────────────────────────────────────────────────────────

test('redactText: 先泛化后扫描（顺序有意义）', () => {
  const r = redactText('凭据在 C:\\Users\\Bob\\.dsh\\x.json，邮箱 a@b.com');
  assert.ok(r.pathCount >= 1);
  assert.ok(r.sensitive);
  assert.ok(!r.text.includes('Bob'));
  assert.ok(r.sensitiveHits.some((h) => h.id === 'email'));
});

test('redactText: 干净文本两条计数都是 0', () => {
  const r = redactText('一次普通进化');
  assert.equal(r.pathCount, 0);
  assert.equal(r.sensitive, false);
});

// ── 表本身的纪律 ────────────────────────────────────────────────────────────

test('每条敏感规则都有 id 与 why（D5 报告要按 id 记账）', () => {
  for (const p of SENSITIVE_PATTERNS) {
    assert.equal(typeof p.id, 'string', '缺 id ⇒ 脱敏报告无法按规则记账');
    assert.ok(p.id.length > 0);
    assert.ok(typeof p.why === 'string' && p.why.length > 3, `${p.id} 缺 why`);
    assert.ok(p.re instanceof RegExp);
  }
});

test('敏感规则 id 唯一（否则报告里两条会混成一条）', () => {
  const ids = SENSITIVE_PATTERNS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `id 重复：${ids.join(', ')}`);
});

test('所有敏感规则都带 g 标志（否则只命中第一处 = 漏报）', () => {
  for (const p of SENSITIVE_PATTERNS) {
    assert.ok(p.re.flags.includes('g'), `${p.id} 缺 g 标志 ⇒ 只扫第一个匹配 = 漏报`);
  }
});

// ── ⭐ 回归钉：两个曾让规则「静默失效」的正则坑 ──────────────────────────────
// 这两条不是形式化断言，是**具体 bug 的回归钉**。删掉它们等于允许 bug 回来。

const WIN_FWD = 'C:/Users/Bob/.dsh/storages/x.json';
const WIN_BACK = String.raw`C:\Users\Bob\.dsh\storages\x.json`;
const LINUX_HOME = '/home/carol/x';
// 原始（未序列化）形态，供「JSON 转义」样本用
const WIN_BACK_RAW = String.raw`C:\Users\Bob\.dsh\storages\x.json`;
const WIN_REPO_RAW = String.raw`D:\DSH\project源码\DSH-AGINT\plugins\x.js`;
// ⭐ 坑 3 的样本：**不含 .dsh** 的 Windows 用户目录（JSON 转义形态）。
// 来源：REDACTION-REPORT.json 的 `why` 文本里写着「路径不在 C:\Users\…\storages」。
const WIN_USERDIR_RAW = String.raw`C:\Users\Administrator\AppData\Local\Temp\evo\dsh-home\storages`;

test('⛔ 回归：Windows 反斜杠路径必须被泛化（坑 1 —— `\\?/` 只匹配正斜杠）', () => {
  // 真实 preimage 备份里的形态（2026-10-03 实测 .agint-preimage 存在该目录）
  const real = String.raw`.agint-preimage\plugins__agint-cron__lib__jobs.js__20260929-200413.bak`;
  // ⚠️ 尾随反斜杠不能紧跟反引号（会转义反引号本身）—— 用 + 拼接分隔符
  const r = generalizePaths(String.raw`备份在 C:\Users\Administrator\.dsh` + '\\' + real);
  assert.ok(r.count >= 1, '❌ 反斜杠形态完全没匹配上 —— 这正是最初漏掉的形态');
  assert.ok(!r.text.includes('Administrator'), `❌ 用户名泄露：${r.text}`);
});

test('⛔ 回归：字符类必须正确闭合（坑 2 —— 字符串拼接把分隔符类吃坏）', () => {  // 现象：`[/\]` 里的 `\]` 被当作转义右括号 ⇒ 字符类永不闭合 ⇒ 永不匹配
  for (const r of PATH_RULES) {
    assert.ok(
      !r.pattern.source.includes(String.raw`[/\]`),
      `❌ ${r.replacement} 的 source 含坏字符类：${r.pattern.source}`,
    );
    const ruleIdx = PATH_RULES.indexOf(r);
    // 每条规则都要能匹配属于**它自己**的那个样本。
    // ⚠️ 两条 <AGINT_REPO> 规则各管一段（Windows 仓库根 / 容器 workspace），
    //    拿同一个样本去试全部规则会误报 —— 这条断言最初就是这么写错的。
    // ⚠️ 样本数组必须与 PATH_RULES **同序同长**。加规则时这里要同步加样本，
    //    否则会「按序号取错样本」报出假失败（这个坑踩过一次）。
    const samples = [
      JSON.stringify({ f: WIN_BACK_RAW }), // 0: DSH_HOME（JSON 转义）
      JSON.stringify({ f: WIN_REPO_RAW }), // 1: 仓库根（JSON 转义）
      JSON.stringify({ f: WIN_USERDIR_RAW }), // 2: Windows 用户目录（JSON 转义，坑 3）
      WIN_FWD,                            // 3: DSH_HOME（正斜杠）
      'D:/DSH/x',                         // 4: 仓库根（正斜杠）
      '/workspace/DSH-AGINT/x',           // 5: 容器 workspace
      LINUX_HOME,                         // 6: Linux home
      '/Users/carol/x',                   // 7: macOS Users
    ];
    assert.equal(samples.length, PATH_RULES.length,
      `样本数 ${samples.length} ≠ 规则数 ${PATH_RULES.length} ⇒ 加规则时忘了加样本`);
    const sample = samples[ruleIdx];
    assert.ok(sample, `❌ ${r.replacement} 规则没有对应样本，无法验证可匹配性`);
    const re = new RegExp(r.pattern.source, r.pattern.flags);
    assert.ok(
      re.test(sample),
      `❌ ${r.replacement} 规则匹配不到 ${sample}：${r.pattern.source}`,
    );
  }
});

test('⛔ 回归：JSON 形态下「不含 .dsh」的用户目录也必须泛化（坑 3 —— 惰性量被 `\\` 阻断）', () => {
  // 现象：`[/\\]Users[/\\][^/\\]+?` 在 JSON 转义文本上整条失配。
  //   因为 `[/\\]` 只吃一个 `\`（`\\` 的第一个），惰性 `+?` 又至少要吃一个
  //   非分隔符字符 ⇒ 撞上第二个 `\` 即回溯失败 ⇒ 用户名原样出包。
  // 实测（2026-10-03）：这是端到端导出抓到的真泄露，来源是脱敏报告自己的 `why`。
  const raw = JSON.stringify({ why: `路径不在 ${WIN_USERDIR_RAW}）` });
  assert.ok(raw.includes('Administrator'), '样本前提：原文确实含用户名');
  const r = generalizePaths(raw);
  assert.ok(r.count >= 1, '❌ JSON 形态的 Windows 用户目录完全没匹配上');
  assert.ok(!r.text.includes('Administrator'), `❌ 用户名泄露：${r.text}`);
  assert.ok(r.text.includes('<HOME>'), `应泛化为 <HOME>：${r.text}`);
  // ⛔ JSON 结构不能被破坏：分隔符必须仍是成对的 `\\`，否则包内 JSON 解析会崩。
  assert.ok(r.text.includes(String.raw`<HOME>\\AppData`), `分隔符被吃掉，JSON 会坏：${r.text}`);
});

test('⛔ 回归：正斜杠与反斜杠两种形态必须等价泛化', () => {
  const a = generalizePaths(WIN_FWD);
  const b = generalizePaths(WIN_BACK);
  assert.equal(a.text, '<DSH_HOME>/storages/x.json', '正斜杠形态');
  assert.equal(b.text, String.raw`<DSH_HOME>\storages\x.json`, '反斜杠形态（分隔符保留原样）');
  assert.equal(a.count, b.count, '两种形态命中数必须一致 —— 漏一个就是泄露');
});

test('⛔ 回归：仓库路径两种形态都泛化（Windows 与容器）', () => {
  const win = generalizePaths(String.raw`D:\DSH\project源码\DSH-AGINT\plugins\x.js`);
  const ctr = generalizePaths('/workspace/DSH-AGINT/AGINT-data/wiki/x.md');
  assert.equal(win.count, 1, 'Windows 仓库路径');
  assert.equal(ctr.count, 1, '容器内仓库路径');
  assert.ok(win.text.startsWith('<AGINT_REPO>'), win.text);
  assert.ok(ctr.text.startsWith('<AGINT_REPO>'), ctr.text);
});
