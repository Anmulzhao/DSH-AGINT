#!/usr/bin/env node
/**
 * bin/dsh-surface.mjs —— dsh 能力面快照与升级承接门禁
 *
 * WHY：为什么需要它
 * ----------------
 * AGINT 是 dsh 的插件集合：我们消费 dsh 的能力，不自建宿主层能力。
 * 这意味着 dsh 每次升级，AGINT 都必须回答三问：
 *   1. 宿主换版本了吗？
 *   2. 宿主给的能力面（服务/事件/类型/包）变了吗？
 *   3. AGINT 依赖的东西还在吗？
 *
 * 在此之前这三问无人回答：AGINT 有 27 个 cron job，对能力面零覆盖；
 * 既有门禁 check-dsh-compat 只比包名与 semver，不看能力面。
 * 宿主增删一个服务键时，全部门禁静默 —— 这正是历史上两次事故的共同形状：
 * 2026-09-22 会话日志改名导致 12 天断供；2026-10-20 整张 preset 静默不挂载。
 *
 * 本脚本把三问收敛成一条命令，并给出机器可读的判定。
 *
 * 数据源（全部只读，绝不写 dsh 安装目录）
 * ------------------------------------
 *   A  asar:dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js
 *      宿主自己生成的 API 目录，导出四个常量：
 *        SERVICE_API(服务键) / EVENT_API(事件名) / TYPE_API(类型名)
 *        / INHERITED_CTX_API(继承 ctx API)
 *      这是能力面的真值，不是靠 grep 猜的。
 *   B  asar:dsh/desktop-runtime.json
 *      宿主自校验清单：release.version / release.hostProtocolVersion /
 *      sharedPackages(包名+版本) / files(逐文件 path+bytes+sha256)。
 *      它让本脚本可以自证：读到的 api-catalog 就是宿主声明的那一份。
 *   C  上述两处的交集 —— 用 B 的 files 声明核对 A 的实读字节。
 * *
 * 判据分层（对齐 check-boundary 的「基线记账」纪律）
 * ------------------------------------------------
 *  L1 升级探测：当前 release.version / hostProtocolVersion 与基线不一致
 *               ⇒ EXIT 3。这是「有新东西要承接」的信号，不是错误，
 *               所以单独分配退出码，好让 CI 与 cron 区别对待。
 *  L2 完整性  ：(a) api-catalog 实读 sha256 与 desktop-runtime.json 的
 *                 files 声明不符 ⇒ EXIT 1；
 *               (b) 四个常量任一不是非空 Array ⇒ EXIT 1；
 *               (c) api-catalog 读不到（readAsarFile 返回 null）⇒ EXIT 1
 *                   并明说读不到 —— 不许当成「跳过」。
 *  L3 差异    ：服务键 / 事件名 / 类型名 / 包 name@version 四组，
 *               与基线逐项 diff：
 *                 · 有新增或删除 ⇒ EXIT 1，打印清单；
 *                 · 仅包版本号变化 ⇒ EXIT 0，但仍打印。
 *
 * 退出码（严格）
 *   0 能力面无变化（或仅包某包版本号变化）
 *   1 能力面有增删 / 完整性失败 / 脚本自身错误
 *   2 环境不满足（找不到宿主 asar，或读不到 api-catalog）
 *   3 宿主已升级，但能力面未 diff 出增删
 *
 * 查不到 不等于 通过
 * ----------------------
 * 一个门禁最危险的失效方式不是报错，而是在没查的情况下安静地报绿。
 * 所以：找不到宿主 ⇒ EXIT 2，且输出里必须出现「没查」二字，
 * 与 bin/host-version.mjs 的既有措辞对齐（它返回 info 且明说没查，
 * 绝不把没查说成一致）。EXIT 2 就是「我没查」，不是「我查了没事」。
 *
 * 基线文件
 * ----------
 * docs/dsh-surface-baseline.json：只存数组，不存计数。
 * 原因：98/82/1054 这些数字会随宿主漂移，把它们写死进代码等于埋雷；
 * 存数组则 diff 天然可比，也能直接看出谁增谁减。
 * 用 --record 在人工确认后重新生成。
 *
 * 用法
 *   node bin/dsh-surface.mjs                 人读报告
 *   node bin/dsh-surface.mjs --json          机器读（JSON 到 stdout）
 *   node bin/dsh-surface.mjs --record        把当前能力面写入基线（人确认后执行）
 *   node bin/dsh-surface.mjs --baseline <p>  指定基线文件
 *   node bin/dsh-surface.mjs --help          本说明
 *
 * 零依赖：只用 node:fs / node:path / node:url / node:crypto。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findHostAppAsar, readAsarFile } from './asar-read.mjs';

// ---------------------------------------------------------------- 常量

/** 退出码。语义见文件头，改动前先读那段 WHY。 */
export const EXIT = Object.freeze({ OK: 0, DIFF: 1, NO_ENV: 2, UPGRADED: 3 });

/** asar 内 api-catalog 的相对路径（相对于 dsh/，与 desktop-runtime.json 的 files 一致）。 */
export const CATALOG_PATH = 'node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js';

/** asar 内宿主自校验清单的相对路径。 */
export const RUNTIME_PATH = 'desktop-runtime.json';

/**
 * 四个能力面数组：<导出常量名, 基线字段名, 该数组元素的「名字」字段>。
 * 单点定义，避免在读取 / diff / 报告里各写一份而漂移。
 */
export const SURFACES = Object.freeze([
  { exported: 'SERVICE_API', field: 'services', key: 'key', label: '服务键' },
  { exported: 'EVENT_API', field: 'events', key: 'name', label: '事件名' },
  { exported: 'TYPE_API', field: 'types', key: 'name', label: '类型名' },
  { exported: 'INHERITED_CTX_API', field: 'inheritedCtx', key: 'name', label: '继承 ctx API' },
]);

/** 默认基线文件（相对仓根）。 */
export const DEFAULT_BASELINE = join('docs', 'dsh-surface-baseline.json');

/** 基线文件里的 $comment，写进文件让后来的人知道它是干什么的。 */
export const BASELINE_COMMENT =
  'dsh 能力面基线：由 node bin/dsh-surface.mjs --record 生成，不要手改。' +
  '存数组不存计数，因为计数会漂而数组可比。' +
  '用它给 L1(版本) / L3(能力面 diff) 提供比较基准；' +
  '改动本文件等于接受一次能力面变更，须配合 docs 记录承接结论。';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓根：bin/ 的上一级。 */
export const REPO_ROOT = resolve(HERE, '..');

// ---------------------------------------------------------- 宿主定位

/**
 * 定位宿主 app.asar。
 *
 * 为什么 --host 与 env 覆盖必须比 findHostAppAsar 的回退链更严格：
 * findHostAppAsar 会依次尝试 env → AGENTS.local.md → 常见安装位扫描。
 * 那个回退链对「日常使用」是对的（找不到就换下一个线索），
 * 但对「验收」是致命的：用户把 DSH_HOST_APP_ASAR 指向一个不存在的路径，
 * 门禁若继续回退到 AGENTS.local.md 里那条真实路径，就会读到一个真宿主、
 * 报 exit 0，而用户以为自己测的是「环境不满足」分支 —— 假绿。
 * 所以：显式给了路径（--host 或 DSH_HOST_APP_ASAR）就只认这一条，
 * 不在了就报「没查」。只有两者都没给时才允许走回退链。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.host]      --host 显式指定
 * @param {object} [opts.env]            环境变量
 * @returns {{path:string,source:string}|{error:string,detail:string}}
 */
export function locateHost({ host = null, env = process.env } = {}) {
  const explicit = host || (env ?? {}).DSH_HOST_APP_ASAR || null;
  if (explicit) {
    if (existsSync(explicit)) return { path: explicit, source: host ? 'cli:--host' : 'env:DSH_HOST_APP_ASAR' };
    return {
      error: '宿主 app.asar 不存在：' + explicit,
      detail:
        '显式指定的路径不在了。按纪律**不回退**其它线索（回退会拿真宿主报绿，' +
        '让「环境不满足」这条分支永远测不到）。宿主查不到 ⇒ 我没查，不是一致。',
    };
  }
  const found = findHostAppAsar({ env });
  if (found) return found;
  return {
    error: '未找到真实宿主的 app.asar' ,
    detail:
      'DSH_HOST_APP_ASAR 未设置，AGENTS.local.md 无 hostAppAsar，常见安装位也未扫到。' +
      '本门禁**没有核对** dsh 能力面 —— 是没查，不是查过一致。' +
      '请设 DSH_HOST_APP_ASAR 指向 <安装目录>/resources/app.asar 后重跑。',
  };
}

// ------------------------------------------------------------ 读取层

/**
 * 读 api-catalog 源码。
 * 读不到返回 null（readAsarFile 的契约，不抛）。
 * 刻意不在这里兜底：调用方必须把 null 当成 EXIT 1 报出去。
 */
function readCatalogSource(asarPath) {
  return readAsarFile(asarPath, 'dsh/' + CATALOG_PATH);
}

/** 读 desktop-runtime.json 并 JSON.parse；读不到或坏掉返回 null。 */
function readRuntimeManifest(asarPath) {
  const text = readAsarFile(asarPath, 'dsh/' + RUNTIME_PATH);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 对字符串求 sha256，用于和 desktop-runtime.json 的 files 声明比对。 */
export function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * 把 api-catalog 源码变模块。
 *
 * 为什么要走 data: URL 而不是 new Function(src)：
 * 该文件是 ESM，末尾带 export 语句；new Function 的范式是函数体，
 * 遇到顶层 export 直接抛 Unexpected token 'export'。
 * data:text/javascript 会让 Node 按 ESM 解析，是唯一可行路径。
 * 663KB 的源码 base64 后约 884KB，Node 能接受。
 *
 * @param {string} src api-catalog 源码
 * @param {Function} [importer] 测试注入点（默认动态 import）
 * @returns {Promise<object>} 模块命名空间
 */
export async function importCatalog(src, importer = (spec) => import(spec)) {
  const b64 = Buffer.from(src, 'utf8').toString('base64');
  return importer('data:text/javascript;base64,' + b64);
}

// ------------------------------------------------------- 能力面快照

/**
 * 从模块命名空间里抽取四个数组，转成「名字数组」。
 * 元素是对象（SERVICE_API 用 key，其余用 name），也可能混进字符串，
 * 两种都容忍，避免宿主换形状时整个门禁崩掉 —— 但抽不出东西时
 * 必须让它变成空数组，由完整性层去报错，而不是静默跳过。
 *
 * @param {object} mod api-catalog 模块命名空间
 * @returns {Record<string, string[]>} field -> 名字数组（已排序去重）
 */
export function extractSurfaces(mod) {
  const out = {};
  for (const s of SURFACES) {
    const arr = mod?.[s.exported];
    if (!Array.isArray(arr)) { out[s.field] = []; continue; }
    const names = [];
    for (const item of arr) {
      if (typeof item === 'string') { names.push(item); continue; }
      const v = item?.[s.key];
      if (typeof v === 'string' && v) names.push(v);
    }
    out[s.field] = Array.from(new Set(names)).sort();
  }
  return out;
}

/** 从 desktop-runtime.json 抽「包 name@version」，排序去重。 */
export function extractPackages(runtime) {
  const list = Array.isArray(runtime?.sharedPackages) ? runtime.sharedPackages : [];
  const tags = [];
  for (const p of list) {
    if (p && typeof p.name === 'string' && p.name) tags.push(p.name + '@' + (p.version ?? '?'));
  }
  return Array.from(new Set(tags)).sort();
}

/** 从 name@version 里取包名（用于「仅版本号变」判定）。 */
export function pkgName(tag) {
  const at = typeof tag === 'string' ? tag.lastIndexOf('@') : -1;
  return at > 0 ? tag.slice(0, at) : tag;
}

// -------------------------------------------------------------- 差异层

/**
 * 两组字符串数组的差异。纯函数，不碰 IO —— 单测直接覆盖这里。
 * @param {string[]} current 当前（真值）
 * @param {string[]} baseline 基线（历史）
 * @returns {{added:string[], removed:string[]}} 相对基线的新增与删除
 */
export function diffList(current, baseline) {
  const cur = Array.isArray(current) ? current : [];
  const base = Array.isArray(baseline) ? baseline : [];
  const baseSet = new Set(base);
  const curSet = new Set(cur);
  return {
    added: cur.filter((x) => !baseSet.has(x)),
    removed: base.filter((x) => !curSet.has(x)),
  };
}

/**
 * 包组差异：包名层 + 版本层分开算。
 * 必须分开，因为两者结论不同：
 *   包名增删（有包没了/多了）⇒ 能力面变了 ⇒ EXIT 1
 *   只是某个已有包升了版本 ⇒ 能力面还在 ⇒ EXIT 0，但仍要打印
 * 把这两件事混成一个 diff，就再也分不出「危险」和「需要看一眼」。
 *
 * @param {string[]} current 当前 name@version
 * @param {string[]} baseline 基线 name@version
 * @returns {{addedPackages:string[], removedPackages:string[], versionChanged:Array<{name:string,from:string,to:string}>}}
 */
export function diffPackages(current, baseline) {
  const cur = Array.isArray(current) ? current : [];
  const base = Array.isArray(baseline) ? baseline : [];
  const curMap = new Map(cur.map((t) => [pkgName(t), t]));
  const baseMap = new Map(base.map((t) => [pkgName(t), t]));

  const addedPackages = [];
  const versionChanged = [];
  for (const [name, tag] of curMap) {
    if (!baseMap.has(name)) { addedPackages.push(tag); continue; }
    const from = baseMap.get(name);
    if (from !== tag) versionChanged.push({ name, from, to: tag });
  }
  const removedPackages = [];
  for (const [name, tag] of baseMap) if (!curMap.has(name)) removedPackages.push(tag);

  addedPackages.sort();
  removedPackages.sort();
  versionChanged.sort((a, b) => a.name.localeCompare(b.name));
  return { addedPackages, removedPackages, versionChanged };
}

// ------------------------------------------------------------ 判定层

/**
 * 把三层判据的原始结果映射成退出码。
 *
 * 判定顺序刻意如此，不要随意调换：
 *   1) 完整性失败先出 —— 数据本身不可信时，后面任何 diff 结论都没有意义，
 *      不能让一个坏掉的 api-catalog 走到「无变化 ⇒ exit 0」。
 *   2) 能力面增删其次 —— 这是真正的红线：AGINT 依赖的键可能已经没了。
 *   3) 宿主升级最后 —— 没有能力面增删，但版本变了，说明有东西要人看。
 *      它排在最后，是为了让前两类更严重的结论优先暴露。
 *
 * 注意：这里只做映射，不做打印。打印在 report 层，单测才能只测判定。
 *
 * @param {object} input
 * @param {boolean} input.integrityOk  L2 是否全过
 * @param {boolean} input.surfaceChanged L3 是否有服务/事件/类型的增删
 * @param {boolean} input.packageChanged L3 是否有包的增删（不含仅版本变）
 * @param {boolean} input.hostChanged  L1 版本是否与基线不一致
 * @returns {number} EXIT.* 之一
 */
export function mapExit({ integrityOk, surfaceChanged, packageChanged, hostChanged }) {
  if (!integrityOk) return EXIT.DIFF;
  if (surfaceChanged || packageChanged) return EXIT.DIFF;
  if (hostChanged) return EXIT.UPGRADED;
  return EXIT.OK;
}

// -------------------------------------------------------------- 采集层

/**
 * 采集当前宿主的完整能力面。
 * 依赖全部通过 opts 注入，好在单测里模拟「宿主缺失 / catalog 读不到」。
 *
 * 返回结构里的 ok 语义要看清：
 *   ok:false + envMissing:true  ⇒ 找不到宿主或读不到 catalog ⇒ EXIT 2（没查）
 *   ok:false + envMissing:false ⇒ 采到了但数据不完整 ⇒ EXIT 1
 * 这两种「失败」不能合并成一个 false —— 合并了就分不出「没查」和「查了不合格」。
 *
 * @param {object} opts
 * @param {string|null} [opts.host] --host
 * @param {object} [opts.env] 环境变量
 * @param {Function} [opts.readFile] 注入 readAsarFile
 * @param {Function} [opts.importer] 注入动态 import
 * @returns {Promise<object>} 采集结果
 */
export async function collectSurface({ host = null, env = process.env, readFile = readAsarFile, importer } = {}) {
  const where = locateHost({ host, env });
  if (where.error) {
    return { ok: false, envMissing: true, stage: 'host', error: where.error, detail: where.detail };
  }

  const asarPath = where.path;
  const runtime = readRuntimeManifestWith(readFile, asarPath);
  const src = readCatalogSourceWith(readFile, asarPath);

  // catalog 读不到：按纪律这是 EXIT 1 并明说读不到，不许走跳过分支。
  if (src === null || src === undefined) {
    return {
      ok: false,
      envMissing: false,
      stage: 'catalog',
      error: 'api-catalog 读不到：asar:dsh/' + CATALOG_PATH,
      detail:
        '宿主 asar 找到了（' + asarPath + '），但里面没有这个文件。' +
        '常见原因：dsh 版本把 api-catalog 挪了位置或改名。' +
        '这是能力面真值读不到 —— 门禁不能假装通过，也不能假装跳过。' +
        '请确认新版本的 api-catalog 路径后更新本脚本的 CATALOG_PATH。',
      hostPath: asarPath,
      hostSource: where.source,
    };
  }

  let mod;
  try {
    mod = await importCatalog(src, importer);
  } catch (e) {
    return {
      ok: false,
      envMissing: false,
      stage: 'catalog',
      error: 'api-catalog 无法作为 ESM 求值' ,
      detail: String(e && e.message ? e.message : e),
      hostPath: asarPath,
      hostSource: where.source,
    };
  }

  // 采到了：把 snapshot / 宿主身份 / 完整性一起交出去。
  const version = runtime?.release?.version ?? null;
  const hostProtocolVersion = runtime?.release?.hostProtocolVersion ?? null;
  return {
    ok: true,
    hostPath: asarPath,
    hostSource: where.source,
    runtime: runtime,
    src: src,
    mod: mod,
    snap: {
      version,
      hostProtocolVersion,
      ...extractSurfaces(mod),
      packages: extractPackages(runtime),
    },
  };
}

/** 注入版：读 catalog 源码，底层读函数可替换（单测用）。 */
function readCatalogSourceWith(readFile, asarPath) {
  try { return readFile(asarPath, 'dsh/' + CATALOG_PATH); } catch { return null; }
}

/** 注入版：读并解析 desktop-runtime.json；读不到或坏掉返回 null。 */
function readRuntimeManifestWith(readFile, asarPath) {
  let text;
  try { text = readFile(asarPath, 'dsh/' + RUNTIME_PATH); } catch { return null; }
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// --------------------------------------------------------- L2 完整性校验

/**
 * L2 完整性：证明「我们读到的这份 api-catalog 就是宿主声明的那一份」。
 *
 * 这一层存在的理由：能力面 diff 只有在数据可信时才有意义。
 * 如果 api-catalog 被半截读取、被别的版本覆盖、或 asar 损坏，
 * 抽样出的键集可能恰好「看起来没变化」，L3 会安静地报绿。
 * 用 desktop-runtime.json 里宿主自己写的 sha256 做交叉验证，
 * 等于让宿主替我们背书，比任何自证都强。
 *
 * 检查项：
 *   1) 实读字节的 sha256 == files[] 里该 path 的 sha256
 *   2) 实读字节数 == files[] 里该 path 的 bytes
 *   3) 四个导出常量都是非空 Array
 * 任一项不过 ⇒ ok:false（调用方据此 EXIT 1）。
 *
 * @param {object} input
 * @param {object} input.runtime desktop-runtime.json 对象（可能为 null）
 * @param {string} input.src api-catalog 源码
 * @param {object} input.mod 已求值的模块
 * @returns {{ok:boolean, checks:Array<{name:string,ok:boolean,detail:string}>}}
 */
export function checkIntegrity({ runtime, src, mod }) {
  const checks = [];

  const bytes = Buffer.from(src, 'utf8');
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  const declared = Array.isArray(runtime?.files)
    ? runtime.files.find((f) => f && f.path === CATALOG_PATH)
    : undefined;

  if (!declared) {
    checks.push({
      name: 'catalog-sha256',
      ok: false,
      detail:
        runtime
          ? 'desktop-runtime.json 的 files 里没有 ' + CATALOG_PATH + ' 的声明，无法交叉验证'
          : 'desktop-runtime.json 读不到，无法交叉验证 api-catalog 的 sha256',
    });
  } else {
    checks.push({
      name: 'catalog-sha256',
      ok: actualSha === declared.sha256,
      detail: '实读 ' + actualSha + ' / 声明 ' + declared.sha256,
    });
    checks.push({
      name: 'catalog-bytes',
      ok: bytes.length === declared.bytes,
      detail: '实读 ' + bytes.length + ' / 声明 ' + declared.bytes,
    });
  }

  for (const s of SURFACES) {
    const arr = mod?.[s.exported];
    const good = Array.isArray(arr) && arr.length > 0;
    checks.push({
      name: 'export-' + s.exported,
      ok: good,
      detail: good ? 'Array(' + arr.length + ')' : '不是非空 Array：' + (Array.isArray(arr) ? 'Array(0)' : typeof arr),
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}


// -------------------------------------------------------- 基线读写

/** 基线文件的绝对路径。 */
export function baselinePath(p) {
  return resolve(REPO_ROOT, p || DEFAULT_BASELINE);
}

/**
 * 读基线。返回 null 表示「没有基线可比较」。
 * 注意：没有基线不是错误 —— 第一次跑必然没有。
 * 调用方要把它报成「需要 --record」，而不是报成「一致」。
 */
export function readBaseline(p) {
  const f = baselinePath(p);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

/**
 * 把快照写成基线。
 * 写盘前按固定字段顺序重建对象，并排序数组，
 * 保证同一份能力面每次 --record 产出字节级相同的文件 —— 
 * 否则 git diff 会把「重排」误报成「能力面变了」。
 */
export function buildBaseline(snap, now = new Date()) {
  return {
    $comment: BASELINE_COMMENT,
    recordedAt: now.toISOString(),
    host: { version: snap.version, hostProtocolVersion: snap.hostProtocolVersion },
    services: [...(snap.services || [])],
    events: [...(snap.events || [])],
    types: [...(snap.types || [])],
    inheritedCtx: [...(snap.inheritedCtx || [])],
    packages: [...(snap.packages || [])],
  };
}

/** 写基线到磁盘，返回写入路径。 */
export function writeBaseline(snap, p, now = new Date()) {
  const f = baselinePath(p);
  mkdirSync(dirname(f), { recursive: true });
  const doc = buildBaseline(snap, now);
  writeFileSync(f, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return f;
}

// ------------------------------------------------------------ 对比层

/**
 * 当前快照 vs 基线，产出 L1 + L3 的完整结论。纯函数。
 *
 * 为什么要把 hostChanged 与能力面变化分开返回：
 * 版本变了但能力面没变，说明宿主只是修了 bug / 换了构建，
 * 承接成本低（走 EXIT 3 提醒人看一眼即可）；
 * 而能力面有增删时，AGINT 的某条依赖可能已经断了（EXIT 1，必须处理）。
 * 把这两件事塞进一个布尔值，就丢掉了「紧急程度」这个最有用的信息。
 *
 * @param {object} snap 当前快照
 * @param {object|null} base 基线（可为 null）
 * @returns {object} 结论
 */
export function compare(snap, base) {
  const hostChanged =
    !base ||
    base.host?.version !== snap.version ||
    base.host?.hostProtocolVersion !== snap.hostProtocolVersion;

  const surfaces = {};
  let surfaceChanged = false;
  for (const s of SURFACES) {
    const d = diffList(snap[s.field], base?.[s.field]);
    if (d.added.length || d.removed.length) surfaceChanged = true;
    surfaces[s.field] = { label: s.label, ...d, baseCount: (base?.[s.field] || []).length, curCount: (snap[s.field] || []).length };
  }
  const pkgs = diffPackages(snap.packages, base?.packages);
  const packageChanged = pkgs.addedPackages.length > 0 || pkgs.removedPackages.length > 0;

  return {
    hasBaseline: Boolean(base),
    baselineVersion: base?.host?.version ?? null,
    baselineHostProtocolVersion: base?.host?.hostProtocolVersion ?? null,
    hostChanged,
    surfaceChanged,
    packageChanged,
    surfaces,
    packages: pkgs,
  };
}

// -------------------------------------------------------------- 报告层

/** 把数组差异渲染成缩进清单；空则返回空数组。 */
function lines(prefix, arr, limit = 40) {
  const out = arr.slice(0, limit).map((x) => '  ' + prefix + ' ' + x);
  if (arr.length > limit) out.push('  ' + prefix + ' …… 还有 ' + (arr.length - limit) + ' 条');
  return out;
}

/**
 * 人读报告。落什么话由结论决定 —— 措辞本身就是门禁的一部分：
 * EXIT 2 的文案必须出现「没查」，否则读的人会以为查过了。
 */
export function renderReport({ collected, integrity, verdict, exit, baselineFile }) {
  const out = [];
  out.push('== dsh 能力面快照与升级承接门禁 ==');
  out.push('');

  // 环境不满足：只报「没查」，不给任何一致性结论。
  if (collected.stage === 'host') {
    out.push('[查询 ] 宿主 asar 没找到 —— 我没查，不代表一致。');
    out.push('          ' + collected.error);
    out.push('          ' + collected.detail);
    out.push('[结论 ] EXIT 2 环境不满足（没查）');
    return out.join('\n');
  }
  if (collected.stage === 'catalog') {
    out.push('[数据源] ' + collected.hostPath + '（' + collected.hostSource + '）');
    out.push('[读失败] ' + collected.error);
    out.push('          ' + collected.detail);
    out.push('[结论 ] EXIT 1 能力面真值读不到（不是通过）');
    return out.join('\n');
  }

  const s = collected.snap;
  out.push('[数据源] ' + collected.hostPath + '（' + collected.hostSource + '）');
  out.push('[宿主  ] version=' + s.version + '  hostProtocolVersion=' + s.hostProtocolVersion);
  out.push('[能力面] 服务 ' + s.services.length + ' / 事件 ' + s.events.length + ' / 类型 ' + s.types.length +
    ' / 继承ctx ' + s.inheritedCtx.length + ' / 包 ' + s.packages.length);

  // L2 完整性
  out.push('' );
  out.push('[L2 完整性] ' + (integrity.ok ? '通过' : '失败'));
  for (const c of integrity.checks) {
    if (!c.ok) out.push('  x ' + c.name + ' :: ' + c.detail);
  }
  if (integrity.ok) out.push('  v catalog sha256 与字节数均与 desktop-runtime.json 声明一致');

  // L1 升级探测
  out.push('[L1 升级探测] ' + (verdict.hasBaseline ? (verdict.hostChanged ? '宿主与基线不一致' : '宿主与基线一致') : '无基线'));
  if (!verdict.hasBaseline) {
    out.push('  基线文件不存在：' + baselineFile);
    out.push('  没有基线就没有比较基准 —— 这不算查过。请先跑 --record 落一份。');
    out.push('[结论 ] EXIT 2 无基线可比较（没查）');
    return out.join('\n');
  }
  if (verdict.hostChanged) {
    out.push('  基线 version=' + (verdict.baselineVersion ?? '?') + ' ⇒ 当前 ' + s.version);
  }

  // L3 能力面差异
  out.push('[L3 能力面差异] ' + (verdict.surfaceChanged || verdict.packageChanged ? '有增删' : '无增删'));
  for (const st of SURFACES) {
    const g = verdict.surfaces[st.field];
    if (!g.added.length && !g.removed.length) continue;
    out.push('  ' + g.label + '（基线 ' + g.baseCount + ' ⇒ 当前 ' + g.curCount + '）');
    out.push(...lines('+', g.added));
    out.push(...lines('-', g.removed));
  }
  const pk = verdict.packages;
  if (pk.addedPackages.length || pk.removedPackages.length || pk.versionChanged.length) {
    out.push('  包（新增 ' + pk.addedPackages.length + ' / 删除 ' + pk.removedPackages.length + ' / 版本变 ' + pk.versionChanged.length + '）');
    out.push(...lines('+', pk.addedPackages, 20));
    out.push(...lines('-', pk.removedPackages, 20));
    for (const v of pk.versionChanged.slice(0, 20)) out.push('  ~ ' + v.name + ' ' + v.from.split('@').pop() + ' ⇒ ' + v.to.split('@').pop());
    if (pk.versionChanged.length > 20) out.push('  ~ …… 还有 ' + (pk.versionChanged.length - 20) + ' 条版本变化');
  }

  // 结论
  out.push('');
  out.push('[结论 ] ' + conclusionText(exit));
  return out.join('\n');
}

/** 结论措辞。退出码 → 一句话。文案是门禁的一部分，改动需谨慎。 */
export function conclusionText(exit) {
  if (exit === EXIT.OK) return 'EXIT 0 能力面无变化（宿主与基线一致）';
  if (exit === EXIT.UPGRADED) return 'EXIT 3 宿主已升级，但能力面未 diff 出增删 —— 请走承接流程后 --record';
  if (exit === EXIT.NO_ENV) return 'EXIT 2 环境不满足（没查）';
  return 'EXIT 1 能力面有增删 / 完整性失败 —— 必须承接';
}

// ------------------------------------------------------------ 机器可读

/**
 * --json 的输出对象。给 CI / cron 用。
 * 与 --json 一起使用时 stdout 只有这一个 JSON，报告走 stderr，
 * 否则调用方没法直接 JSON.parse。
 */
export function toJson({ collected, integrity, verdict, exit, baselineFile }) {
  const s = collected.snap;
  const base = {
    exit,
    exitText: conclusionText(exit),
    ok: exit === EXIT.OK,
    queried: collected.ok === true,
    baselineFile,
    host: {
      path: collected.hostPath ?? null,
      source: collected.hostSource ?? null,
      version: s?.version ?? null,
      hostProtocolVersion: s?.hostProtocolVersion ?? null,
    },
    counts: s
      ? { services: s.services.length, events: s.events.length, types: s.types.length,
          inheritedCtx: s.inheritedCtx.length, packages: s.packages.length }
      : null,
    integrity: { ok: integrity.ok, checks: integrity.checks },
    upgrade: { hasBaseline: verdict.hasBaseline, hostChanged: verdict.hostChanged,
               surfaceChanged: verdict.surfaceChanged, packageChanged: verdict.packageChanged },
    diff: verdict.hasBaseline
      ? { services: verdict.surfaces.services, events: verdict.surfaces.events,
          types: verdict.surfaces.types, inheritedCtx: verdict.surfaces.inheritedCtx,
          packages: verdict.packages }
      : null,
  };
  if (!collected.ok) {
    base.error = { stage: collected.stage, message: collected.error, detail: collected.detail };
  }
  return base;
}

// ---------------------------------------------------------------- CLI

/** 解析 argv。纯函数，便于单测。 */
export function parseArgs(argv) {
  const o = { json: false, record: false, help: false, baseline: null, host: null };
  const a = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < a.length; i += 1) {
    const t = a[i];
    if (t === '--json') o.json = true;
    else if (t === '--record') o.record = true;
    else if (t === '--help' || t === '-h') o.help = true;
    else if (t === '--baseline') { o.baseline = a[i + 1] ?? null; i += 1; }
    else if (t === '--host') { o.host = a[i + 1] ?? null; i += 1; }
    else if (t.startsWith('--baseline=')) o.baseline = t.slice(11);
    else if (t.startsWith('--host=')) o.host = t.slice(7);
    else if (t === '--') break;
    else throw new Error('未知参数：' + t);
  }
  return o;
}

/**
 * 主流程。返回退出码，不直接 process.exit —— 这样单测能拿到返回值。
 *
 * 执行顺序即判据优先级：先采集，再完整性，再版本，再差异。
 * 采集都失败时后面的层不允许给结论（数据都不在，谈不上「一致」）。
 */
export async function run(argv, deps = {}) {
  const args = parseArgs(argv);
  const out = deps.out ?? process.stdout;
  const errOut = deps.err ?? process.stderr;
  const env = deps.env ?? process.env;

  if (args.help) { out.write(HELP + '\n'); return EXIT.OK; }

  // ---- 采集
  const collected = await collectSurface({
    host: args.host, env,
    readFile: deps.readFile,
    importer: deps.importer,
  });

  if (!collected.ok) {
    const integrity = { ok: false, checks: [] };
    const verdict = { hasBaseline: false, hostChanged: false, surfaceChanged: false, packageChanged: false, surfaces: {}, packages: { addedPackages: [], removedPackages: [], versionChanged: [] } };
    const exit = collected.envMissing ? EXIT.NO_ENV : EXIT.DIFF;
    emit({ args, out, errOut, collected, integrity, verdict, exit, baselineFile: baselinePath(args.baseline) });
    return exit;
  }
  // ---- L2 完整性
  const integrity = checkIntegrity({
    runtime: collected.runtime,
    src: collected.src ?? null,
    mod: collected.mod ?? null,
  });

  // ---- 记录模式：写基线后立即按新基线判（必然 exit 0）
  if (args.record) {
    const file = writeBaseline(collected.snap, args.baseline, deps.now ?? new Date());
    const verdict = compare(collected.snap, readBaseline(args.baseline));
    const exit = integrity.ok ? EXIT.OK : EXIT.DIFF;
    if (args.json) {
      out.write(JSON.stringify({ ...toJson({ collected, integrity, verdict, exit, baselineFile: file }), recorded: file }, null, 2) + '\n');
    } else {
      errOut.write('[record] 已写入基线：' + file + '\n');
      errOut.write(renderReport({ collected, integrity, verdict, exit, baselineFile: file }) + '\n');
    }
    return exit;
  }

  // ---- L1 + L3：与基线比较
  const baselineFile = baselinePath(args.baseline);
  const base = readBaseline(args.baseline);
  const verdict = compare(collected.snap, base);

  // 无基线：没有比较基准，任何 diff 结论都是假的。
  // 这里必须早退，不能落到 mapExit —— 因为 compare(snap, null) 会把全部
  // 服务键/事件名都算成「新增」，从而谎报 EXIT 1「能力面有增删」。
  // 没基线就是没查：EXIT 2，与「查不到不等于通过」同一条纪律。
  if (!base) {
    const exit = integrity.ok ? EXIT.NO_ENV : EXIT.DIFF;
    emit({ args, out, errOut, collected, integrity, verdict, exit, baselineFile });
    return exit;
  }
  const exit = integrity.ok
    ? mapExit({ integrityOk: true, surfaceChanged: verdict.surfaceChanged, packageChanged: verdict.packageChanged, hostChanged: verdict.hostChanged })
    : EXIT.DIFF;

  emit({ args, out, errOut, collected, integrity, verdict, exit, baselineFile });
  return exit;
}

/**
 * 输出分发：--json 时 stdout 只放 JSON，人读报告走 stderr。
 * 为什么这样分：CI 要能直接 JSON.parse(stdout)，而人看的是终端。
 * 两边都发会被 JSON.parse 噎到。
 */
function emit({ args, out, errOut, collected, integrity, verdict, exit, baselineFile }) {
  const json = toJson({ collected, integrity, verdict, exit, baselineFile });
  if (args.json) {
    out.write(JSON.stringify(json, null, 2) + '\n');
    errOut.write(conclusionText(exit) + '\n');
  } else {
    out.write(renderReport({ collected, integrity, verdict, exit, baselineFile }) + '\n');
  }
}

// -------------------------------------------------------------- 帮助

const HELP = [
  'dsh 能力面快照与升级承接门禁',
  '',
  '用法：',
  '  node bin/dsh-surface.mjs                 人读报告',
  '  node bin/dsh-surface.mjs --json          机器读（JSON 到 stdout，报告走 stderr）',
  '  node bin/dsh-surface.mjs --record        把当前能力面写入基线（人确认后执行）',
  '  node bin/dsh-surface.mjs --baseline <p>  指定基线文件（默认 docs/dsh-surface-baseline.json）',
  '  node bin/dsh-surface.mjs --host <asar>   指定宿主 app.asar（默认取 DSH_HOST_APP_ASAR）',
  '',
  '退出码：',
  '  0  能力面无变化（或仅包版本号变）',
  '  1  能力面有增删 / 完整性失败 / 自身错误',
  '  2  环境不满足（找不到宿主、读不到 api-catalog、无基线）—— 这是「没查」，不是「一致」',
  '  3  宿主已升级，但能力面未 diff 出增删',
  '',
  '数据源：asar 内 dsh/desktop-runtime.json 与 api-catalog.js（只读，不改安装目录）。',
  '查不到不等于通过：找不到宿主一律 EXIT 2 并在输出里明说「没查」。',
].join('\n');

// ---------------------------------------------------------------- 入口

/**
 * 只在被直接执行时跑 main。被 import（单测）时不跑，避免测试触发真实 IO。
 * 判据：process.argv[1] 解析后与 import.meta.url 指向同一文件。
 */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write('[dsh-surface] 自身错误：' + (e && e.stack ? e.stack : String(e)) + '\n');
      process.exit(EXIT.DIFF);
    },
  );
}
