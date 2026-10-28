/**
 * agint-upstream-watch — 依赖面测量（本设计的立论所在）。
 *
 * ## 为什么必须有这一段
 *
 * 2026-10-28 的现场实例：`dsh 0.2.2-alpha.2` 的 changelog 写
 * 「插件需迁移 `tools.resolve/executable` 与提示词组装接口」。
 * 只读文字，结论必然是「AGINT 要大改」。
 *
 * 实测结果完全相反：把这个包拉下来比对 `.d.ts` ——
 *   `ctx.tools.register(def)` → `register(def, options?)`，**新增可选第二参**；
 *   `defineTool` / `DefineToolOptions` 一字未变；
 *   `subagents.startActivation` 签名不动。
 * 也就是说 140 处调用零改动。
 *
 * 所以：**结论必须由实测给出，关键词只用来决定「要不要实测得更细」**。
 * 这一段只产事实（差在哪），不下结论（该不该升）—— 那是 judge 的事。
 *
 * ## 事实的边界（诚实交代）
 *
 * 只比「类型定义里的导出符号名 + 签名行」。**语义变了但签名没变的情况抓不到**：
 * 实例是 `dsh-storage-domain` 把版本校验从「丢弃旧版本记录」改成「接受已落盘的列出旧版本」——
 * 函数签名一个没动，行为变了。这类只能靠 changelog 的判读兜，是已知缺口（设计文档 §6-2）。
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractApiSurface } from './tarball.js';
import { collectSemanticDeltas, directImpact } from './semantics.js';

/** 只测这些包的 API：AGINT 真的 import 它们。其余包只在 changelog 层面看。 */
const REGISTRY = 'https://registry.npmjs.org';

/** 单个 tarball 下载上限，防拉到大包把内存吃光 */
const MAX_TARBALL_BYTES = 24 * 1024 * 1024;
/**
 * 扫 AGINT 仓库，找出实际依赖的上游包**以及用了它们的哪些导出**。
 *
 * ⛔ 用静态扫 import 语句，不读 package.json：AGINT 的插件不各自声明对 dsh 的依赖
 *    （都靠部署位的祖先链解析），package.json 里看不出真实依赖面。
 *
 * 为什么连「用了哪些名字」一起收集：
 *    一个包的 API 大改（例如 `dsh-tools` 从 0.2.1 到 0.2.2 删了 60 个导出）不等于 AGINT 受影响 ——
 *    取决于被删的那批里有没有 AGINT 真的在用的。只报「breaking」而不看使用面，
 *    等于每次都喊「狼来了」，喊三次就没人看了。使用面是让结论有分辨力的那一维。
 *
 * @returns {Map<string, {files: Set<string>, imports: Set<string>}>}
 */
export function scanDependencyFace(repoRoot) {
  const found = new Map(); // pkg -> { files: Set, imports: Set }
  const pluginsDir = join(repoRoot, 'plugins');
  if (!existsSync(pluginsDir)) return found;

  const bump = (pkg, file, names) => {
    if (!found.has(pkg)) found.set(pkg, { files: new Set(), imports: new Set() });
    const rec = found.get(pkg);
    rec.files.add(file);
    for (const n of names) rec.imports.add(n);
  };

  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test') continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!/\.(m?js)$/.test(e.name)) continue;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      const rel = abs.slice(repoRoot.length + 1);

      // ⛔ 先剥掉注释行，再扫 import。
      //    2026-10-28 实测踩到的坑：本文件的示例注释里写着
      //    `// import { A, B as C } from '@deepseek-ai/x'`，
      //    结果扫描器把**自己文档里的示意**当成了真实依赖，多出一个不存在的包 `@deepseek-ai/x`。
      //    只按行首判断（`//` / `*` / `/*`）就够，不必做完整词法 —— 宁可漏几行注释里的假 import，
      //    也不要引进来一个不存在的包把下游判读全带偏。
      const scannable = text.split(/\r?\n/).filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      }).join('\n');
      text = scannable;

      // import { A, B as C } from '@deepseek-ai/x'
      const namedRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@deepseek-ai\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;
      let m;
      while ((m = namedRe.exec(text))) {
        const names = m[1].split(',').map((s) => {
          const t = s.trim().replace(/^type\s+/, '');
          if (!t) return null;
          return t.split(/\s+as\s+/)[0].trim();
        }).filter(Boolean);
        if (names.length) bump(m[2], rel, names);
        else bump(m[2], rel, []);
      }

      // import * as NS from '@deepseek-ai/x' / import Default from '@deepseek-ai/x'
      const starRe = /import\s+(?:type\s+)?(?:\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s*['"](@deepseek-ai\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;
      while ((m = starRe.exec(text))) bump(m[1], rel, ['*']);

      // 动态 import：拿不到具体名字，记弱标记 `~dynamic`
      //
      // ⛔ 刻意**不**记成 `*`（= 整包全用）。本机实测 `agint-memory-provider` 有一处
      //    `await import('@deepseek-ai/dsh-tools')`，只是运行时探测能力，实际取用的是一两个函数。
      //    把它当通配会让任何包的删除都判成「影响 AGINT」，结论立刻失去分辨力 ——
      //    而分辨力正是这个判读器唯一的价值。弱标记的意思是「使用面可能不完整」，如实说出来。
      const dynRe = /import\(\s*['"](@deepseek-ai\/[a-z0-9-]+)(?:\/[^'"]*)?['"]\s*\)/g;
      while ((m = dynRe.exec(text))) bump(m[1], rel, ['~dynamic']);
    }
  };
  walk(pluginsDir);
  return found;
}

/**
 * 定位 dsh 真实安装根（也就是运行时真正加载那一份）。
 *
 * ⛔ 为什么不能直接按目录优先级找包：`$DSH_HOME/profiles/node_modules/` 里可能躺着
 *    **被 App 升级甩下的遗留副本**（本机实测有 0.1.1-rc.2 的 `dsh-tools`，而运行时是 0.2.1-rc.3）。
 *    拿那份当基准做 diff，会得出「45 个导出被移除、31 个签名变化」的结论 —— 全是假的。
 *    假事实比没事实更危险：它会让人去改根本不需要改的代码。
 *    所以：**先定位 dsh 主包，再用它的版本给候选目录打分，只信版本对得上的那份。**
 *
 * 顺序：DSH_ROOT → createRequire 解析 @deepseek-ai/dsh → DSH_HOME 下逐 profile 探测
 */
export function resolveDshRoot(env = process.env) {
  const tryRoot = (d) => {
    if (!d) return null;
    try {
      const pj = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      return pj?.name === '@deepseek-ai/dsh' ? { dir: d, version: pj.version ?? null } : null;
    } catch { return null; }
  };

  if (env.DSH_ROOT) {
    const hit = tryRoot(env.DSH_ROOT);
    if (hit) return hit;
  }

  const bases = [];
  try { bases.push(fileURLToPath(import.meta.url)); } catch { /* ignore */ }
  if (process.argv[1]) bases.push(process.argv[1]);
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const hit = tryRoot(dirname(req.resolve('@deepseek-ai/dsh/package.json')));
      if (hit) return hit;
    } catch { /* 继续 */ }
  }

  // 从 node 可执行文件推导全局包根。
  // ⛔ 这一路是**离线/仓库内跑**时的主力：插件源码在仓库里时，祖先链上没有 dsh，
  //    但 dsh 是全局装的，从 node 自己的位置能反推出来。
  //    nvm / volta / 系统安装都是 bin/ 与 lib/node_modules/ 平级；Windows 是同级 node_modules。
  const execDir = dirname(process.execPath);
  for (const g of [
    join(execDir, '..', 'lib', 'node_modules'),
    join(execDir, 'node_modules'),
    join(execDir, '..', 'node_modules'),
  ]) {
    const hit = tryRoot(join(g, '@deepseek-ai', 'dsh'));
    if (hit) return hit;
  }

  const home = env.DSH_HOME;
  if (home) {
    const profilesRoot = join(home, 'profiles');
    let dirs = [];
    try {
      dirs = readdirSync(profilesRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* ignore */ }
    for (const d of dirs) {
      const hit = tryRoot(join(profilesRoot, d, 'node_modules', '@deepseek-ai', 'dsh'));
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 定位本机已装的某个上游包目录。
 *
 * 候选来源（按可信度）：dsh 主包树内 → createRequire 解析 → profile 布局。
 * **版本校验**：候选的 version 必须与 dsh 主包版本一致；一致者优先返回。
 * 都不一致时返回版本最高的那个，并在结果里带上 `versionMismatch` 让调用方知道基准可疑。
 *
 * @returns {{dir: string, version: string|null, dshVersion: string|null, versionMismatch: boolean}|null}
 */
export function resolveInstalledPackage(pkg, env = process.env) {
  const segs = pkg.split('/');
  const readVer = (d) => {
    try { return JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
  };
  const candidates = [];
  const push = (d) => {
    if (!d) return;
    if (!existsSync(join(d, 'package.json'))) return;
    if (candidates.some((c) => c.dir === d)) return;
    candidates.push({ dir: d, version: readVer(d) });
  };

  const root = resolveDshRoot(env);

  /**
   * 探测对象就是宿主主包本身 ⇒ 直接采用 `resolveDshRoot()` 的结果。
   *
   * ⛔ 2026-10-28 实测踩到：`profiles/<p>/node_modules/@deepseek-ai/dsh` 里躺着
   *    App 升级甩下的 0.1.1-rc.2，走「版本最大」兜底会选中它 —— 于是主包的
   *    `engines` 比的是 0.1.1-rc.2（那时还没有 engines 字段）vs 新版，
   *    得出「engines 从 (unset) 变成 >=24.9」这种没法处置的结论。
   * ⛔ 必须放在候选收集**之前**：全局布局下（`lib/node_modules/@deepseek-ai/dsh`），
   *    下面两条 push 的路径都撞不上，candidates 会是空的，早退就永远走不到这里。
   */
  if (pkg === '@deepseek-ai/dsh' && root) {
    return { dir: root.dir, version: root.version, dshVersion: root.version, versionMismatch: false };
  }

  // 1. dsh 主包自带依赖树（最可信）
  if (root) {
    push(join(root.dir, 'node_modules', ...segs));
    /**
     * 兄弟 hoist 位：`<prefix>/lib/node_modules/@deepseek-ai/<pkg>`。
     *
     * ⛔ 旧写法是 `join(dirname(root.dir), ...segs)`，对 scoped 包算错了一层 ——
     *    `root.dir` 已经是 `.../lib/node_modules/@deepseek-ai/dsh`，
     *    `dirname()` 落在 `.../@deepseek-ai`，再拼 `@deepseek-ai/<pkg>` 得到
     *    `.../@deepseek-ai/@deepseek-ai/<pkg>`。**全局安装布局下这两条 push 全部落空**，
     *    candidates 只剩 profiles（遗留副本）或 createRequire，实测漏掉了真实安装树。
     */
    const scopedDir = dirname(root.dir);          // .../lib/node_modules/@deepseek-ai
    push(join(scopedDir, segs[segs.length - 1])); // .../lib/node_modules/@deepseek-ai/<pkg>
  }

  // 2. createRequire 解析
  const bases = [];
  try { bases.push(fileURLToPath(import.meta.url)); } catch { /* ignore */ }
  if (process.argv[1]) bases.push(process.argv[1]);
  for (const base of bases) {
    try {
      const req = createRequire(base);
      push(dirname(req.resolve(`${pkg}/package.json`)));
    } catch { /* 继续 */ }
  }

  // 3. profile 布局（可能是遗留副本，所以放最后且要过版本校验）
  if (env.DSH_HOME) {
    const home = env.DSH_HOME;
    const profilesRoot = join(home, 'profiles');
    let dirs = [];
    try {
      dirs = readdirSync(profilesRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* ignore */ }
    for (const d of dirs) push(join(profilesRoot, d, 'node_modules', ...segs));
    push(join(home, 'profiles', 'node_modules', ...segs));
    push(join(home, 'profiles', 'web', 'node_modules', ...segs));
  }

  if (candidates.length === 0) return null;

  const dshVersion = root?.version ?? null;
  const matched = dshVersion ? candidates.find((c) => c.version === dshVersion) : null;
  if (matched) return { ...matched, dshVersion, versionMismatch: false };

  // 探测对象就是宿主主包自身、但 `resolveDshRoot()` 没命中（极端环境）⇒ 退回「版本最大」，
  // 并在结果里标 versionMismatch 让调用方知道基准可疑。

  // 没有版本对得上的：退回「版本号最大的」而不是「路径最靠前的」——
  // 遗留副本的典型特征就是版本更旧。
  const sorted = [...candidates].sort((a, b) => String(b.version ?? '').localeCompare(String(a.version ?? '')));
  // ⛔ 找不到 dsh 主包时**也算可疑**：没有比对锚，就无从判断这份是不是运行时用的那份。
  return { ...sorted[0], dshVersion, versionMismatch: true };
}

/** 读本机已装版本的 API 面（与 tarball 版同一口径：lib/types/*.d.ts + lib/index.js） */
export function readInstalledSurface(pkgDir) {
  const out = new Map();
  const typesDir = join(pkgDir, 'lib', 'types');
  if (existsSync(typesDir)) {
    for (const f of readdirSync(typesDir)) {
      if (!f.endsWith('.d.ts')) continue;
      try { out.set(`lib/types/${f}`, readFileSync(join(typesDir, f), 'utf8')); } catch { /* 跳过 */ }
    }
  }
  const idx = join(pkgDir, 'lib', 'index.js');
  if (existsSync(idx)) {
    try { out.set('lib/index.js', readFileSync(idx, 'utf8')); } catch { /* 跳过 */ }
  }
  // package.json（v0.2）：语义层要比 engines / deps / type。不读进来说不了话 ——
  // API 面完全看不到「engines 抬到 >=24.9」，而那一条直接决定装不装得上。
  // 键名与 tarball 里的路径形态对齐（tarball 是 `package/package.json`），
  // `readMetaFromFiles()` 按「层级最浅」取，所以这里放 `package.json` 也能命中。
  const pj = join(pkgDir, 'package.json');
  if (existsSync(pj)) {
    try { out.set('package.json', readFileSync(pj, 'utf8')); } catch { /* 跳过 */ }
  }
  return out;
}

/**
 * 解析「要扫哪个目录来找 AGINT 的依赖面」。
 *
 * ⛔ 这是一个**必须显式处理**的问题，不能拿 `process.cwd()` 兜底了事：
 *    插件跑在 dsh 进程里，cwd 通常是人启动 `dsh web` 时所在的目录（本机是 `/home/kylin`），
 *    那里没有 `plugins/`。`scanDependencyFace()` 遇到不存在的目录会返回空 Map，
 *    于是依赖面恒为空、每个版本都判「没有包受影响」—— 一次静默的假绿，
 *    而且它看起来完全正常（factsSummary 里只是少了几项）。
 *
 * 四路兜底（按可信度排序）：
 *   1. `AGINT_REPO_ROOT` —— 显式指定，门禁与离线测试走这条
 *   2. `AGINT_HOME` / `DSH_HOME` —— 部署位
 *   3. 从本文件往上找「同时有 `cordis.patch.yml` 与 `plugins/`」的目录
 *      （仓库位、bundle 位、profile 镜像位都满足；三处的插件副本边相同）
 *   4. cwd —— 最后兜底，并在 facts 里标 `scanSource='cwd'` 让人知道可能不对
 *
 * @param {object} [env]
 * @returns {{root:string, source:'env'|'home'|'self-path'|'cwd'}}
 */
export function resolveAgintRoot(env = process.env) {
  const isRoot = (d) => Boolean(d) && existsSync(join(d, 'cordis.patch.yml')) && existsSync(join(d, 'plugins'));

  if (env.AGINT_REPO_ROOT && isRoot(env.AGINT_REPO_ROOT)) {
    return { root: env.AGINT_REPO_ROOT, source: 'env' };
  }
  for (const key of ['AGINT_HOME', 'DSH_HOME']) {
    const home = env[key];
    if (!home) continue;
    // 部署位：<home>/.agint-bundle 是挂载源；也兼容 <home> 本身是 bundle 根
    for (const cand of [join(home, '.agint-bundle'), home]) {
      if (isRoot(cand)) return { root: cand, source: 'home' };
    }
  }

  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (isRoot(dir)) return { root: dir, source: 'self-path' };
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* 继续 */ }

  return { root: process.cwd(), source: 'cwd' };
}

/**
 * 读某包**当前已装版本**的导出符号名集合（不联网、不拉 tarball）。
 *
 * 用途：v0.3 的判读校准 —— 升级后用真实的安装树重算一次「AGINT 用到的符号还在不在」，
 * 与当时的预测对拍。这是整套仪器里唯一**能证伪**的一步：
 *   - 当时判 `breaking`（符号被删），升级后符号还在 ⇒ 误报
 *   - 当时判 `compatible/elsewhere`，升级后符号没了 ⇒ 漏报（更危险）
 *
 * ⛔ 只返回名字集合，不返回签名 —— 校准判的是「在不在」，签名变化当时的 digest 已经记过了。
 *
 * @param {string} pkgDir
 * @returns {Set<string>}
 */
export function readInstalledSymbols(pkgDir) {
  const files = readInstalledSurface(pkgDir);
  const merged = mergeSurface(files);
  return new Set(merged.keys());
}

/** 拉 npm tarball。返回 Buffer 或 null（失败不抛，由调用方判 unknown） */
export async function fetchNpmTarball(pkg, version, { timeoutMs = 20_000 } = {}) {
  const url = `${REGISTRY}/${pkg.replace('/', '%2F')}/-/${pkg.split('/').pop()}-${version}.tgz`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'agint-upstream-watch' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, url };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > MAX_TARBALL_BYTES) {
      return { ok: false, reason: `tarball 过大 ${len}B`, url };
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_TARBALL_BYTES) {
      return { ok: false, reason: `tarball 过大 ${ab.byteLength}B`, url };
    }
    return { ok: true, buf: Buffer.from(ab), url };
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : (e?.message ?? String(e));
    return { ok: false, reason: msg, url };
  }
}

/**
 * 从 .d.ts / index.js 文本里抽「对外接口面」。
 *
 * 抽三类东西：
 *   1. `export declare function/class/interface/type/const ... NAME` → kind='decl'
 *   2. `export { A, B as C }`（**含跨行块**）→ kind='ref'（只是再导出，不带签名信息）
 *   3. interface / class 内部成员（`name(...)` / `name?: Type`）→ kind='member'，键为 `Owner.name`
 *
 * ## 为什么要有 kind
 *
 * 同一个符号在不同版本里可能一处写成 `export declare const X = "..."`，
 * 另一处写成汇总式 `export { X }`。两者语义相同、文本不同。只比文本就是纯误报 ——
 * 2026-10-28 实测撞上：`TOOL_ABORTED` 被判 breaking，实际只是 export 写法换了。
 * 所以规则是：**`ref` 侧不参与签名比较**，只有两边都是 `decl` / `member` 才比。
 *
 * ## 为什么 const 要去掉初始化值
 *
 * `const TOOL_ABORTED = "ABORTED"` 改成别的值是值变化，不是 API 形状变化。
 * 值变化对 AGINT 有没有影响？有，但那属于运行时语义，不是这一层的判据（已知缺口 §6-2）。
 *
 * ## 为什么 member 也要抓
 *
 * AGINT 真正依赖的是 `ctx.tools.register(def)` 这种**接口方法**。
 * 只抓 export 行的话，`register` 从一参变两参这种变化一个都看不见 ——
 * 而那恰恰是最该看见的。
 */

/** 信息量排序：decl > member > ref，合并同名符号时留信息多的那份 */
const KIND_RANK = { decl: 3, member: 2, ref: 1 };

export function extractApiSymbols(text) {
  const out = new Map();
  const push = (key, kind, sig) => {
    const prev = out.get(key);
    if (!prev || KIND_RANK[kind] > KIND_RANK[prev.kind]) out.set(key, { kind, sig });
  };

  const lines = String(text ?? '').split(/\r?\n/);
  let braceDepth = 0;
  let owner = null;       // 当前所在 interface / class 名
  let ownerDepth = 0;
  let collecting = false; // 正在累积多行 export 块
  let buf = '';

  for (const raw of lines) {
    const line = raw
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;

    // ── 多行 export 块：累积到出现 `}` ──
    if (collecting) {
      buf += ` ${line}`;
      if (line.includes('}')) {
        collecting = false;
        const body = buf.slice(buf.indexOf('{') + 1, buf.indexOf('}'));
        for (const name of splitExportNames(body)) push(name, 'ref', 'ref');
        buf = '';
      }
      continue;
    }

    // ── 声明行 ──
    const decl = /^export\s+(?:declare\s+)?(?:abstract\s+)?(function|class|interface|type|const|enum|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (decl) {
      const [, kindWord, symName] = decl;
      push(symName, 'decl', normalizeDecl(kindWord, line));
      if ((kindWord === 'interface' || kindWord === 'class')
        && line.includes('{') && !line.includes('}')) {
        owner = symName;
        ownerDepth = braceDepth + 1;
      }
    } else if (/^export\s+(?:type\s+)?\{/.test(line)) {
      const open = line.indexOf('{');
      const rest = line.slice(open + 1);
      if (rest.includes('}')) {
        for (const name of splitExportNames(rest.slice(0, rest.indexOf('}')))) push(name, 'ref', 'ref');
        continue;
      }
      collecting = true;
      buf = rest;
      continue;
    }

    // ── 花括号记账（决定 owner 何时结束）──
    for (const ch of line) {
      if (ch === '{') braceDepth += 1;
      else if (ch === '}') braceDepth -= 1;
    }
    if (owner && braceDepth < ownerDepth) { owner = null; ownerDepth = 0; }

    // ── interface / class 成员 ──
    if (owner) {
      const mem = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*(\(|<|:)/.exec(line);
      if (mem && mem[1] !== 'constructor') {
        const sig = line.replace(/[;{]\s*$/, '').replace(/\s+/g, ' ').trim();
        push(`${owner}.${mem[1]}`, 'member', sig);
      }
    }
  }

  return out;
}

/** `A, B as C, type D` → ['A','C','D'] */
function splitExportNames(body) {
  const out = [];
  for (const piece of String(body).split(',')) {
    const p = piece.trim().replace(/^type\s+/, '');
    if (!p) continue;
    const name = p.split(/\s+as\s+/).pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
  }
  return out;
}

/** 归一化声明行：const/let/var 去掉初始化值，其余保留签名形状 */
function normalizeDecl(kindWord, line) {
  const base = line.replace(/[;{]\s*$/, '').replace(/\s+/g, ' ').trim();
  if (kindWord === 'const' || kindWord === 'let' || kindWord === 'var') {
    return base.split('=')[0].trim();
  }
  return base;
}

/** 把多份文件的接口面合并成一张表（同名取信息量大的那份） */
function mergeSurface(files) {
  const merged = new Map();
  for (const [path, text] of files) {
    if (!/\.(d\.ts|js)$/.test(path)) continue;
    for (const [key, info] of extractApiSymbols(text)) {
      const prev = merged.get(key);
      if (!prev || KIND_RANK[info.kind] > KIND_RANK[prev.kind]) {
        merged.set(key, { ...info, path });
      }
    }
  }
  return merged;
}

/**
 * 取签名里的参数表内容（`f(a: X, b?: Y): Z` → `a: X, b?: Y`）。
 * 用配对括号扫描，不靠正则 —— 参数里可能嵌泛型/函数类型。
 */
function paramList(sig) {
  const open = sig.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < sig.length; j += 1) {
    if (sig[j] === '(') depth += 1;
    else if (sig[j] === ')') {
      depth -= 1;
      if (depth === 0) return sig.slice(open + 1, j);
    }
  }
  return null;
}

/**
 * 判断签名变化是不是「变宽」（旧的参数表是新参数表的前缀，后面追加了可选参数）。
 *
 * ⛔ 不能简单用「旧签名是新签名的子串」——
 *    `register(definition: X): () => void` 变成
 *    `register(definition: X, options?: Y): () => void` 时，
 *    旧串在 `X` 后面紧跟的是 `)`，新串那里是 `,`，子串判定会失败，
 *    于是把「加了个可选参数」误报成 breaking。**必须比参数表。**
 */
function isWidening(before, after) {
  const pb = paramList(before);
  const pa = paramList(after);
  if (pb === null || pa === null) return false;
  const nb = pb.replace(/\s+/g, '');
  const na = pa.replace(/\s+/g, '');
  if (na === nb) return true;          // 参数一个没动，变的是周边（返回类型等）
  if (!na.startsWith(nb)) return false;
  // 前缀之后必须紧跟 `,`：说明是追加参数，不是把类型改了
  return na.slice(nb.length).startsWith(',');
}

/**
 * 比对两个接口面。
 *
 * verdict 判据（顺序敏感，先严后宽）：
 *   unknown   — 任一侧拿不到
 *   breaking  — 有导出被删，或签名变化**不是**「变宽」
 *   additive  — 只有新增导出，或签名变化全部是「变宽」
 *   compatible— 完全一致
 *
 * 「变宽」为什么必要：`register(def)` → `register(def, options?)` 是新增可选参数，
 * 对现有调用完全兼容。把它报成 breaking 就是制造噪声 ——
 * 2026-10-28 那次核实的结论正是这个形状（140 处调用零改动）。
 */
export function diffSurface(oldFiles, newFiles) {
  if (!oldFiles || oldFiles.size === 0 || !newFiles || newFiles.size === 0) {
    return {
      verdict: 'unknown',
      addedSymbols: [], removedSymbols: [], changedSignatures: [], widenedSignatures: [],
      changedFiles: [],
      evidence: [oldFiles?.size ? '新版本 API 面为空' : '本机已装版本 API 面为空'],
    };
  }

  const a = mergeSurface(oldFiles);
  const b = mergeSurface(newFiles);

  const addedSymbols = [];
  const removedSymbols = [];
  const changedSignatures = [];
  const widenedSignatures = [];

  for (const [name, info] of b) {
    const before = a.get(name);
    if (!before) { addedSymbols.push(name); continue; }
    // 任一侧是 ref（汇总再导出）⇒ 没有可比签名
    if (before.kind === 'ref' || info.kind === 'ref') continue;
    if (before.sig === info.sig) continue;

    if (isWidening(before.sig, info.sig)) {
      widenedSignatures.push({ name, before: before.sig, after: info.sig });
    } else {
      changedSignatures.push({ name, before: before.sig, after: info.sig });
    }
  }

  for (const name of a.keys()) {
    if (!b.has(name)) removedSymbols.push(name);
  }

  // 文件级变化：归一化后文本不同（只给「哪里变了」，不含判断）
  const changedFiles = [];
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  for (const [path, text] of newFiles) {
    const before = oldFiles.get(path);
    if (before === undefined) { changedFiles.push(`${path} (新增)`); continue; }
    if (norm(before) !== norm(text)) changedFiles.push(path);
  }

  const verdict = (removedSymbols.length > 0 || changedSignatures.length > 0)
    ? 'breaking'
    : ((addedSymbols.length > 0 || widenedSignatures.length > 0) ? 'additive' : 'compatible');

  // evidence 只留最能说明问题的几条，别把整份 diff 塞进提案正文
  const evidence = [];
  for (const c of changedSignatures.slice(0, 3)) {
    evidence.push(`签名收窄 ${c.name}: ${c.before}  →  ${c.after}`);
  }
  for (const c of widenedSignatures.slice(0, 2)) {
    evidence.push(`签名变宽 ${c.name}: ${c.before}  →  ${c.after}`);
  }
  if (removedSymbols.length) {
    evidence.push(`导出消失: ${removedSymbols.slice(0, 6).join(', ')}`);
  }
  if (addedSymbols.length) {
    evidence.push(`新增导出: ${addedSymbols.slice(0, 6).join(', ')}`);
  }

  return {
    verdict, addedSymbols, removedSymbols, changedSignatures, widenedSignatures,
    changedFiles, evidence,
  };
}

/**
 * 测一个包的 API 变化。返回纯事实。
 *
 * @param {object} p
 * @param {string} p.pkg        包名（@deepseek-ai/xxx）
 * @param {string} p.toVersion  目标版本
 * @param {object} [p.env]      环境（测试注入用）
 * @returns {Promise<object>}   { pkg, from, to, verdict, evidence, ... }
 */
/**
 * 测一个包的 API 变化。返回纯事实。
 *
 * `usedNames` 是 AGINT 在这个包里实际 import 的符号（来自 `scanDependencyFace`）。
 * 它决定了这个函数最有价值的那一维：**同样的 API 大改，用到了才是 breaking，
 * 没用到只是「别人家的事」**。不给 usedNames 时退化为「只看有没有删除」。
 *
 * @param {object} p
 * @param {string} p.pkg        包名（@deepseek-ai/xxx）
 * @param {string} p.toVersion  目标版本
 * @param {Iterable<string>} [p.usedNames] AGINT 用到的导出名；含 '*' 表示整包引入
 * @param {object} [p.env]      环境（测试注入用）
 */
export async function probePackageApi({ pkg, toVersion, usedNames = [], env = process.env }) {
  const used = new Set(usedNames ?? []);
  const located = resolveInstalledPackage(pkg, env);

  const empty = (verdict, evidence, extra = {}) => ({
    pkg, from: located?.version ?? null, to: toVersion, verdict,
    addedSymbols: [], removedSymbols: [], changedSignatures: [], widenedSignatures: [],
    changedFiles: [], usedImpact: 'none', evidence,
    baselineSuspect: located ? located.versionMismatch : true,
    // v0.2 语义面：形状必须稳定（下游 facts.js / 面板 / 校准都按字段读），
    // 拿不到时给 unknown 而不是省掉键 —— 省键会让「没测」和「没问题」长得一样。
    semanticStatus: 'unknown', semanticReason: '未比对', semanticDeltas: [], semanticBySeverity: {},
    semanticImpact: 'unknown', overallImpact: 'unknown',
    ...extra,
  });

  if (!located) {
    return empty('unknown', ['本机找不到该包的安装位置（DSH_ROOT / dsh 主包树 / profiles 均未命中）']);
  }

  const pkgDir = located.dir;
  const fromVersion = located.version;
  // 基准可疑（版本与 dsh 主包不一致）时必须说出声：diff 结果可能整份失真
  const baselineNote = located.versionMismatch
    ? `⚠ 基准版本 ${fromVersion} 与 dsh 主包 ${located.dshVersion} 不一致，diff 结果可能失真`
    : null;

  if (fromVersion === toVersion) {
    return empty('compatible', ['本机已是目标版本，无需比对'], {
      baselineSuspect: false,
      semanticStatus: 'ok', semanticReason: null, semanticImpact: 'none', overallImpact: 'none',
    });
  }

  const oldFiles = readInstalledSurface(pkgDir);
  const tar = await fetchNpmTarball(pkg, toVersion);
  if (!tar.ok) {
    return empty('unknown', [
      ...(baselineNote ? [baselineNote] : []),
      `拉取 ${toVersion} tarball 失败：${tar.reason}`,
    ]);
  }

  const newFiles = extractApiSurface(tar.buf);
  const d = diffSurface(oldFiles, newFiles);
  // ── 语义面（v0.2）：签名之外的、AGINT 会真受影响的变化 ──
  // 与 API 面共用同一次 tarball 拉取 —— 拉两遍既慢又可能拿到两个不同快照。
  const sem = collectSemanticDeltas({
    oldFiles, newFiles, selfFrom: fromVersion, selfTo: toVersion,
    // 本机实际运行时版本：把 engines 从「抬了」变成「我能不能装」（见 semantics.js）
    localEngines: { node: process.versions.node },
  });
  const semDirect = directImpact(sem.deltas);
  const semanticImpact = sem.status !== 'ok' && sem.deltas.length === 0
    ? 'unknown'
    : semDirect.length > 0
      ? 'blocker'
      : sem.deltas.some((x) => x.severity === 'warn')
        ? 'warn'
        : sem.deltas.length > 0 ? 'info' : 'none';

  // ── 使用面加权：把「API 变了」和「AGINT 受影响」分开 ──
  // ⛔ 判据只看**被删/被收窄**的符号在不在使用面里。
  //    新增符号再多也不构成风险；ref 形式的变化已经在 diffSurface 里滤掉了。
  const wildcard = used.has('*');
  const isUsed = (name) => wildcard || used.has(name) || used.has(String(name).split('.').pop());
  const usedRemoved = d.removedSymbols.filter(isUsed);
  const usedNarrowed = d.changedSignatures.filter((c) => isUsed(c.name));
  const usedWidened = d.widenedSignatures.filter((c) => isUsed(c.name));

  let usedImpact = 'none';
  if (usedRemoved.length > 0 || usedNarrowed.length > 0) usedImpact = 'breaking';
  else if (usedWidened.length > 0) usedImpact = 'additive';
  else if (d.removedSymbols.length > 0 || d.changedSignatures.length > 0) usedImpact = 'elsewhere';
  else if (d.addedSymbols.length > 0 || d.widenedSignatures.length > 0) usedImpact = 'additive';

  const impactNote = usedImpact === 'elsewhere'
    ? `本包 API 有删除/收窄（${d.removedSymbols.length + d.changedSignatures.length} 处），但都不在 AGINT 的使用面上`
    : null;

  /**
   * 总判定：把 API 面与语义面里**能定档**的部分合成一档，取最严。
   *
   * 值域与 `usedImpact` 同构，只多一个 `blocking`：
   *   blocking > breaking > elsewhere > additive > none > unknown
   *
   * `blocking` 单列的理由：`engines.node` 抬高、`type` 改成 ESM 这类变化
   * **与「AGINT 用没用到某个导出」无关** —— 它决定装不装得上。折进 breaking
   * 会让「本包 API 完全没动、只是引擎抬了」被显示成 API 破坏，归因就错了。
   *
   * 语义面的 warn/info **不参与定档**（它们不改变「API 面变没变」这个事实），
   * 而是通过 `semanticImpact` 单独表达 —— 一个字段只说一件事，别让两个语义
   * 挤在同一个枚举里（否则面板上永远分不清是「签名破了」还是「引擎抬了」）。
   */
  const RANK = { blocking: 0, breaking: 1, elsewhere: 2, additive: 3, none: 4, unknown: 5 };
  let overallImpact = usedImpact;
  if (semanticImpact === 'blocker') overallImpact = 'blocking';
  if (RANK[overallImpact] === undefined) overallImpact = 'unknown';

  const semanticNote = sem.status !== 'ok'
    ? `语义面未能比对：${sem.reason}`
    : sem.deltas.length === 0
      ? null
      : `语义面 ${sem.deltas.length} 条（${Object.entries(sem.bySeverity).map(([k, v]) => `${k} ${v}`).join(' / ')}）`;

  const evidence = [
    ...(baselineNote ? [baselineNote] : []),
    ...(impactNote ? [impactNote] : []),
    ...(semanticNote ? [semanticNote] : []),
    ...d.evidence,
  ];

  return {
    pkg, from: fromVersion, to: toVersion, ...d,
    usedImpact,
    usedRemoved, usedNarrowed, usedWidened,
    usedCount: used.size,
    semanticStatus: sem.status,
    semanticReason: sem.reason,
    semanticDeltas: sem.deltas,
    semanticBySeverity: sem.bySeverity,
    semanticImpact,
    overallImpact,
    evidence,
    baselineSuspect: located.versionMismatch,
  };
}
