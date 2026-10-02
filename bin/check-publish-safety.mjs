#!/usr/bin/env node
// bin/check-publish-safety.mjs —— 发布安全门禁（Phase 3 交付物四，Tier A）
//
// 职责：在**任何**可能让包离开本机的动作之前，检查三件事。
//
//   ① `files` 白名单存在且不含危险路径
//   ② `private` 状态与发布意图一致（当前必须 private:true）
//   ③ 版本号在 package.json / VERSION / AGENTS.md 三处一致
//
// ⭐ 为什么这个门禁现在就要有（哪怕 private:true 还没移除）：
//    它的价值是**让「移除 private」这个动作必须过一次门禁**。
//    没有门禁时，摘掉 private 只是一行字的改动，出事是几个月后；
//    有门禁时，摘掉 private 会在同一刻被拦住并说明缺什么。
//    依据：路线图.md「不引入发布逻辑但补齐元数据」+ Phase 3 设计 §4.2.2。
//
// ⛔ 本门禁【不做】任何发布动作，也不改 private 字段。
//
// 用法：node bin/check-publish-safety.mjs
// 退出码：0 = 通过（可能有 WARN）；1 = ERROR

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const errors = [];
const warns = [];
const notes = [];

function err(m) {
  errors.push(m);
}
function warn(m) {
  warns.push(m);
}

// ── 读 package.json ─────────────────────────────────────────────────────────
const pkgPath = join(REPO_ROOT, 'package.json');
if (!existsSync(pkgPath)) {
  console.error('[check-publish-safety] ❌ package.json 不存在');
  process.exit(1);
}
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (e) {
  console.error(`[check-publish-safety] ❌ package.json 不是合法 JSON：${e.message}`);
  process.exit(1);
}

// ── ① files 白名单 ─────────────────────────────────────────────────────────
/**
 * ⛔ 危险路径前缀。每条都要写 reason —— 没有理由的排除名单就是后门。
 *    判据来自**实测**（ls -A 根目录），不是推理。
 */
const FORBIDDEN_PREFIXES = [
  {
    prefix: 'node_modules',
    reason: '第三方依赖 + 宿主提供包（@deepseek-ai/*）。整目录进包会有数万文件，且 install.sh 靠 junction 解析宿主依赖 —— 打进包等于把宿主依赖树冻结进 tarball。',
  },
  {
    prefix: '.agint-preimage',
    reason: '改动前文件全文备份，含**绝对路径**（Phase -1 已证多机路径硬编码问题）⇒ 泄露本机目录结构。实测根目录存在该目录。',
  },
  {
    prefix: '.agint-backups',
    reason: '安装/升级备份，性质同上。实测根目录存在该目录。',
  },
  {
    prefix: 'wiki',
    reason: '.gitignore 明确「不进版本控制」的内部知识库。实测根目录存在该目录。',
  },
  {
    prefix: 'dreams',
    reason: '梦境日记（LLM 生成的自由文本）。.gitignore 已排除。',
  },
  {
    prefix: 'reviews',
    reason: '周复盘报告，含人工评审意见。.gitignore 已排除。',
  },
  {
    prefix: '.git',
    reason: '版本控制内部结构，不该随包分发。',
  },
  {
    prefix: 'packages',
    reason: 'Phase 3 导出包落点（gitignore）。导出包含脱敏后的 runtime 数据 —— 绝不能进 git/npm 包。',
  },
];

/** 必须出现在白名单里的路径（缺了包就跑不起来）。 */
const REQUIRED_IN_FILES = [
  { path: 'cordis.patch.yml', reason: 'dsh bundle 的 patch 入口（package.json 的 dsh.bundle.patch 指向它）。缺了包完全不可用。' },
  { path: 'plugins/', reason: '全部 host 插件。缺了没有任何服务。' },
  { path: 'presets/', reason: 'preset 声明（agent.cordis.yml）。缺了智进 preset 不存在。' },
];

const files = pkg.files;
if (!Array.isArray(files) || files.length === 0) {
  err(
    'package.json 没有 `files` 白名单。' +
      '⛔ 没有白名单时 npm 会按 .gitignore 打包 —— 而 .gitignore 排除的是「不该进包」还是「该进包」' +
      '并不等价（比如 docs/ 里的规范该进包，但 .gitignore 管不到它）。' +
      '⇒ 若刻意不打包（dsh bundle 走 profile 目录而非 npm），请在本门禁里显式声明该意图。',
  );
} else {
  // ①a 危险前缀
  for (const f of files) {
    for (const bad of FORBIDDEN_PREFIXES) {
      if (f === bad.prefix || f.startsWith(`${bad.prefix}/`)) {
        err(`files 含危险路径 "${f}" —— ${bad.reason}`);
      }
    }
  }
  // ①b 备份残留（实测根目录有 *.bak-*，是最容易被 glob 捎带进去的一类）
  for (const f of files) {
    if (f.includes('bak-') || f.endsWith('.bak') || f.endsWith('~')) {
      err(`files 含备份残留 "${f}" —— 备份文件不该随包分发（实测根目录有 2 个 *.bak-*）。`);
    }
  }
  // ①c 必需项
  for (const req of REQUIRED_IN_FILES) {
    if (!files.some((f) => f === req.path || f === req.path.replace(/\/$/, ''))) {
      err(`files 缺必需路径 "${req.path}" —— ${req.reason}`);
    }
  }
  // ①d 白名单里的路径必须真实存在（防拼错后静默少打包）
  for (const f of files) {
    if (!existsSync(join(REPO_ROOT, f))) {
      err(`files 里的 "${f}" 在仓库中不存在 —— 拼错路径会让包静默少内容，不会报错。`);
    }
  }
  // ①e 包内文件数合理性（防白名单写太宽）
  let est = 0;
  for (const f of files) {
    const p = join(REPO_ROOT, f);
    if (!existsSync(p)) continue;
    est += countFiles(p);
  }
  notes.push(`白名单覆盖约 ${est} 个文件`);
  if (est > 20000) {
    err(`白名单覆盖约 ${est} 个文件 —— 疑似把实验资产（eval/ test/ fixtures/）也打进去了。`);
  }
}

// ── ② private 状态 ─────────────────────────────────────────────────────────
if (pkg.private === true) {
  notes.push('private:true —— 当前不会误发布到 npm（Phase 3 不移除此项）');
} else if (pkg.private === false) {
  // 不直接 fail，而是列出「若要移除 private 必须先具备什么」
  const missing = [];
  if (!Array.isArray(files) || files.length === 0) missing.push('`files` 白名单');
  if (!existsSync(join(REPO_ROOT, '.npmrc'))) missing.push('.npmrc（禁 publish 或限定 registry）');
  if (!existsSync(join(REPO_ROOT, '.github', 'workflows'))) {
    missing.push('.github/workflows（CI 里禁 publish 步骤）');
  }
  if (missing.length > 0) {
    err(
      `private 被设为 false，但发布前置未齐备：${missing.join(' / ')}。\n` +
        '   ⛔ 移除 private 是不可撤回动作（包一旦进 npm 缓存，删除也要等 24~72h 且无法覆盖已缓存版本）。',
    );
  } else {
    warn('private:false 且前置看起来齐备 —— 请人工复核 .npmrc 与 CI 配置真的禁了 publish');
  }
} else {
  warn('package.json 没有 private 字段 —— npm 默认 private:false，等同于「可直接发布」');
}

// ── ③ 元数据齐备度（Phase-3 设计 §4.4 验收项 1）─────────────────────────
// ⭐ 为什么把它做成门禁而不是「人工评审」：§4.4 原文写的是「人工核对」，
//   而人工核对过一次就没人再看第二次 —— 元数据是那种「删了也不会立刻出事」
//   的字段，等出事时已经在 npm 上躺了很久。
//   这里的判据是**字段存在且形状正确**，不判内容对不对（内容要人工看）。
const REQUIRED_META = [
  ['repository', (v) => typeof v === 'string' || (v && typeof v.url === 'string'), '仓库地址（§4.4-1）'],
  ['homepage', (v) => typeof v === 'string' && /^https?:\/\//.test(v), '主页（§4.4-1）'],
  ['bugs', (v) => typeof v === 'string' || (v && typeof v.url === 'string'), '问题反馈入口（§4.4-1）'],
  ['keywords', Array.isArray, '关键词数组（§4.4-1）'],
  ['engines', (v) => v && typeof v === 'object', '运行环境约束（§4.4-1）'],
];
for (const [field, shape, why] of REQUIRED_META) {
  const v = pkg[field];
  if (v === undefined || v === null) err(`package.json 缺 \`${field}\`（${why}）—— 市场接入准备项未补全`);
  else if (!shape(v)) err(`package.json 的 \`${field}\` 形状不对（${why}）`);
}
if (Array.isArray(pkg.keywords) && pkg.keywords.length < 3) {
  err(`keywords 只有 ${pkg.keywords.length} 个（§4.4-1 要求可被检索，<3 个等于没有）`);
}
// engines.node 必须真的是约束 —— 写成 "*" 等于没写
if (pkg.engines && typeof pkg.engines.node === 'string' && /^\*$|^\s*$/.test(pkg.engines.node)) {
  err(`engines.node = "${pkg.engines.node}" —— 通配等于没有约束，等于没声明`);
// ⛔ 别把 engines.node 写成与 README 冲突的值：两份各说各话时，安装器只认一份。
} else if (pkg.engines && typeof pkg.engines.node === 'string') {
  const readme = join(REPO_ROOT, 'README.md');
  if (existsSync(readme)) {
    const txt = readFileSync(readme, 'utf8');
    const declared = txt.match(/Node\.js\s*(?:≥|>=)\s*(\d+)/);
    if (declared && !pkg.engines.node.includes(declared[1])) {
      err(`engines.node = "${pkg.engines.node}" 与 README 声明的 "Node.js ≥ ${declared[1]}" 不一致 —— 两份各说各话时安装器只认一份`);
    }
  }
}

// ── ④ 版本一致性 ───────────────────────────────────────────────────────────
const versionErrors = [];
if (existsSync(join(REPO_ROOT, 'VERSION'))) {
  const v = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8');
  const m = v.match(/^\|\s*v(\d+\.\d+\.\d+)\s*\|/m);
  if (!m) {
    versionErrors.push('VERSION 的「## 当前」表首行解析不出版本号');
  } else if (m[1] !== pkg.version) {
    versionErrors.push(`package.json version=${pkg.version} ≠ VERSION 表首行 v${m[1]}`);
  }
} else {
  versionErrors.push('VERSION 文件不存在');
}

// AGENTS.md 的自动块
const agentsPath = join(REPO_ROOT, 'AGENTS.md');
if (existsSync(agentsPath)) {
  const a = readFileSync(agentsPath, 'utf8');
  const m = a.match(/AGINT v(\d+\.\d+\.\d+)/);
  if (m && m[1] !== pkg.version) {
    versionErrors.push(`package.json version=${pkg.version} ≠ AGENTS.md 自动块 v${m[1]}`);
  }
}
for (const e of versionErrors) err(`③ 版本不一致：${e}`);

// ── ─────────────────────────────────────────────────────────────────────────
function countFiles(p) {
  const st = statSync(p);
  if (st.isFile()) return 1;
  if (!st.isDirectory()) return 0;
  let n = 0;
  for (const e of readdirSync(p)) {
    if (e === '.git' || e === 'node_modules') continue;
    n += countFiles(join(p, e));
  }
  return n;
}

console.log('[check-publish-safety] 发布安全检查');
console.log(`  包名 ${pkg.name}@${pkg.version} · private=${pkg.private}`);
console.log(`  files 白名单 ${Array.isArray(files) ? files.length : 0} 条`);
for (const n of notes) console.log(`  · ${n}`);
if (warns.length > 0) {
  console.log(`\n  WARN ${warns.length} 处：`);
  for (const w of warns) console.log(`    ~ ${w}`);
}
if (errors.length > 0) {
  console.error(`\n  ❌ ERROR ${errors.length} 处：`);
  for (const e of errors) console.error(`    ✗ ${e}`);
  process.exit(1);
}
console.log('\n  ✅ 0 ERROR —— 当前状态不会导致误发布');
process.exit(0);
