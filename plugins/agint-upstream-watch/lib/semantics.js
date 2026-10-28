/**
 * agint-upstream-watch — 语义差异检测（v0.2，补设计方案 §6-2 的缺口）。
 *
 * ## 补的是什么洞
 *
 * v0.1 的 API 比对只回答「签名有没有变」。有一整类变更它会**正确地判为 compatible**，
 * 而 AGINT 会真的受影响：
 *
 *   - `engines.node` 从 `>=22` 抬到 `>=24.9` —— 签名一个没动，但装不上。
 *   - `dependencies` 多出一个必装包 —— 签名没动，但运行时 `import` 会直接炸。
 *   - `export declare const SAFETY_VETO_THRESHOLD = 0.5` 改成 `0.6` ——
 *     `normalizeDecl()` 为了躲开噪声，**主动把 const 的初始化值剥掉了**，
 *     于是值变了也判「一致」。这是阈值，改一点行为就变一片。
 *   - 某个导出标了 `@deprecated` —— 本版还能用，下一版就没；这是最早的一次预警窗口。
 *
 * 这四类都能确定性判定（不需要模型、不需要猜），所以放在段 1 而不丢给 LLM。
 * 判不出来的（比如「版本校验从丢弃旧记录改成接受旧记录」）**仍然判不出来** ——
 * 本模块不假装覆盖全部语义，只覆盖「有结构化落点」的那部分，其余照 §6-2 记作已知缺口。
 *
 * ## 三条纪律
 *
 * 1. **只报事实，不报结论。** 每条 delta 带 `severity`（blocker/warn/info）表示
 *    「这条如果为真，影响有多硬」，但不等于「AGINT 会挂」。结论由段 2 给。
 * 2. **拿不到就不报。** 任一端的元信息缺失 ⇒ 返回 `unknown`，不按「没什么变化」处理。
 *    假绿比没数据更危险 —— v0.1 的基准事故（遗留副本）就是这么来的。
 * 3. **零依赖。** `node:` 内置 + 本插件自己的 `version.js`，不引 semver 包
 *    （`docs/zero-deps-allowlist.json`）。
 */

import { compareVersion, parseVersion } from './version.js';

/** engines 依懒键里我们真正关心的那些（其余照实列出但不给 severity 判断） */
const RUNTIME_ENGINES = ['node'];

/**
 * 从 tarball / 已装目录的文件表里取出**包根**的 `package.json` 文本。
 *
 * npm tarball 的路径前缀统一是 `package/`，已装目录我们手动塞 `package.json`；
 * 两种形态都取「层级最浅的那个」，避免误取某个子包（monorepo 包会有嵌套）。
 *
 * @param {Map<string,string>} files
 * @returns {string|null}
 */
export function readMetaFromFiles(files) {
  if (!files || files.size === 0) return null;
  let best = null;
  let bestDepth = Infinity;
  for (const [path, text] of files) {
    if (!/(^|\/)package\.json$/.test(path)) continue;
    const depth = path.split('/').length;
    if (depth < bestDepth) { best = text; bestDepth = depth; }
  }
  return best;
}

/** 解析 package.json 里判读需要的字段。解析失败返回 null（⇒ 上游判 unknown）。 */
export function parseMeta(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  return {
    name: typeof j.name === 'string' ? j.name : null,
    version: typeof j.version === 'string' ? j.version : null,
    type: typeof j.type === 'string' ? j.type : null,
    engines: pick(j.engines),
    dependencies: pick(j.dependencies),
    peerDependencies: pick(j.peerDependencies),
    exports: j.exports === undefined ? null : j.exports,
  };
}

/**
 * 从 semver 范围里取「下限」。
 *
 * 支持 `>=24.9` / `>24.9` / `^24.9.0` / `~24.9.0` / `24.9.0` / `24.x` / `>=24.9 <25`。
 * 取范围里所有下限里**最高**的那个（同时含 `>=24.9 <25` 与 `>=22` 时以 24.9 为准，
 * 保守方向对：宁可多报一次「抬高」，不要漏掉一次装不上）。
 *
 * 解析不出来返回 null —— 调用方据此判 unknown，不猜。
 */
export function lowerBound(range) {
  const s = String(range ?? '').trim();
  if (!s) return null;
  if (s === '*' || s === 'x' || s === 'latest') return null;
  const parts = s.split('||').map((p) => p.trim()).filter(Boolean);
  let best = null;
  for (const alt of parts) {
    // 空格分隔的多条件（`>=24.9 <25`）：逐个 token 看
    for (const token of alt.split(/\s+/)) {
      const m = /^(>=|>|~|\^|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(token);
      if (!m) continue;
      const op = m[1] ?? '';
      if (op === '<' || op === '<=') continue; // 上界不是下限
      const major = Number(m[2]);
      const minorRaw = m[3];
      const patchRaw = m[4];
      const minor = minorRaw && minorRaw !== 'x' && minorRaw !== '*' ? Number(minorRaw) : 0;
      const patch = patchRaw && patchRaw !== 'x' && patchRaw !== '*' ? Number(patchRaw) : 0;
      if (!Number.isFinite(major)) continue;
      // `>24.9` 严格大于：抬一点点，语义上等价于「至少 24.9 之后」
      const cand = `${major}.${minor}.${patch}`;
      if (best === null || compareVersion(cand, best) > 0) best = cand;
    }
  }
  return best;
}

/**
 * 比对两端的 package.json 元信息，产出语义差异事实。
 *
 * @param {string|null} oldText 本机已装版本的 package.json
 * @param {string|null} newText 目标版本的 package.json
 * @param {{localEngines?: Record<string,string>}} [opts]
 *   `localEngines` 是本机实际运行时版本（如 `{ node: '24.21.0' }`）。
 *   给了它，`engines` 这条就能从「相对变化」升级成「我能不能装」——
 *   这是本模块里**唯一一条能确定性回答"会不会装不上"的事实**，
 *   不给就只能说「抬了」，给了才能说「抬到 24.9，本机 24.21 满足」。
 * @returns {{status:'ok'|'unknown', reason:string|null, deltas:Array}}
 */
export function diffMeta(oldText, newText, opts = {}) {
  const a = parseMeta(oldText);
  const b = parseMeta(newText);
  if (!a || !b) {
    return {
      status: 'unknown',
      reason: !a ? '本机已装版本 package.json 读不到或解析失败' : '目标版本 package.json 读不到或解析失败',
      deltas: [],
    };
  }

  const localEngines = opts.localEngines ?? null;
  const deltas = [];
  const add = (d) => deltas.push(d);

  /**
   * 本机是否满足某个下限。返回 null = 本机版本未知（不给判断，不假装满足）。
   *
   * ⛔ 未满足 ⇒ `blocker`，而不是「更高的 warn」。这一条与「AGINT 用没用到某个导出」
   *    完全无关：装不上就是装不上，任何使用面分析都救不回来。
   */
  const localCheck = (eng, floor) => {
    const local = localEngines?.[eng];
    if (!local) return null;
    return compareVersion(local, floor) >= 0;
  };

  // ── 1. 运行时最低版本（engines）──
  // 这是唯一一条会**直接决定装不装得上**的元信息，而且 API 面完全看不到它。
  for (const eng of RUNTIME_ENGINES) {
    const before = a.engines[eng];
    const after = b.engines[eng];
    if (before === undefined && after === undefined) continue;
    if (String(before ?? '') === String(after ?? '')) continue;
    const lb = lowerBound(before);
    const la = lowerBound(after);
    const ok = la ? localCheck(eng, la) : null;
    const localNote = la
      ? (ok === null
        ? '本机运行时版本未知，无法判定是否满足'
        : ok
          ? `本机 ${eng} ${localEngines[eng]} 满足新下限 ${la}`
          : `本机 ${eng} ${localEngines[eng]} **不满足**新下限 ${la} —— 直接装不上`)
      : '下限解析不出，需人看一眼';

    if (lb && la) {
      const cmp = compareVersion(la, lb);
      if (cmp > 0) {
        add({
          kind: 'engine-raised', symbol: `engines.${eng}`,
          before: String(before), after: String(after),
          severity: ok === false ? 'blocker' : 'warn',
          note: `${eng} 最低版本从 ${lb} 抬到 ${la}；${localNote}`,
        });
        continue;
      }
      if (cmp < 0) {
        add({
          kind: 'engine-lowered', symbol: `engines.${eng}`,
          before: String(before), after: String(after),
          severity: 'info', note: `${eng} 最低版本下调，对现有宿主无风险`,
        });
        continue;
      }
    }
    // 从「无约束」变成「有约束」本质上就是抬高（对旧版是放宽，对新装是收紧），
    // 口径统一记 `engine-raised` —— 否则面板与校准要为一个语义维护两个 kind。
    add({
      kind: lb === null && la !== null ? 'engine-raised' : 'engine-range-changed',
      symbol: `engines.${eng}`,
      before: String(before ?? '(unset)'), after: String(after ?? '(unset)'),
      severity: ok === false ? 'blocker' : 'warn',
      note: `engines.${eng} 范围变了；${localNote}`,
    });
  }

  // ── 2. 依赖面 ──
  // 新增「必装依赖」是本类里最容易被忽略的一种：本机没装它，运行时 import 直接炸，
  // 而它在目标包的 package.json 里只是多了一行。
  const depFields = [
    ['dependencies', 'dep'],
    ['peerDependencies', 'peer-dep'],
  ];
  for (const [field, prefix] of depFields) {
    const oldDeps = a[field];
    const newDeps = b[field];
    const all = new Set([...Object.keys(oldDeps), ...Object.keys(newDeps)]);
    for (const name of all) {
      const before = oldDeps[name];
      const after = newDeps[name];
      if (before === after) continue;
      if (before === undefined) {
        add({
          kind: `${prefix}-added`, symbol: name,
          before: null, after: String(after),
          severity: prefix === 'dep' ? 'warn' : 'warn',
          note: `${field} 新增 ${name}@${after}`,
        });
      } else if (after === undefined) {
        add({
          kind: `${prefix}-removed`, symbol: name,
          before: String(before), after: null,
          severity: 'info',
          note: `${field} 移除 ${name}（对消费方通常无影响）`,
        });
      } else {
        add({
          kind: `${prefix}-range-changed`, symbol: name,
          before: String(before), after: String(after),
          severity: 'info',
          note: `${field} 里 ${name} 的范围变了`,
        });
      }
    }
  }

  // ── 3. 模块形态 ──
  if (a.type !== b.type) {
    add({
      kind: 'module-type-changed', symbol: 'type',
      before: a.type, after: b.type,
      severity: 'blocker',
      note: `包类型从 ${a.type ?? '(commonjs)'} 改为 ${b.type ?? '(commonjs)'} —— 会改变所有 import 的解析方式`,
    });
  }

  // ── 4. exports 字段（子路径入口）──
  // 只在两端都是对象/字符串时比「键集合」，不做深度 diff：深度 diff 会把
  // 无关的版本号变化也报出来，噪声大于信号。
  const keyOf = (e) => {
    if (e === null || e === undefined) return null;
    if (typeof e === 'string') return '.';
    if (typeof e === 'object') return Object.keys(e).sort().join(',');
    return null;
  };
  const ka = keyOf(a.exports);
  const kb = keyOf(b.exports);
  if (ka !== null && kb !== null && ka !== kb) {
    add({
      kind: 'exports-keys-changed', symbol: 'exports',
      before: ka, after: kb,
      severity: 'warn',
      note: '子路径入口集合变了（AGINT 若按子路径 import，需核对这些子路径还在不在）',
    });
  }

  return { status: 'ok', reason: null, deltas };
}

/**
 * 从类型定义里抓 `export declare const X = <字面量>` 的值。
 *
 * 为什么要单独抓：`normalizeDecl()` 对 const 主动剥掉 `= ...`（否则每个导出的
 * 常量值不同都会被算成签名变化，噪声淹没信号）。代价是**值真的变了也看不出来** ——
 * 而 AGINT 依赖的偏偏是阈值类常量（`SAFETY_VETO_THRESHOLD` / `TRUST_VETO_THRESHOLD`）。
 *
 * 只收「纯字面量」（number / string / boolean / 单层数组），表达式（如 `1 << 3`）
 * 不展开 —— 展开就等于我们自己实现一个解释器，没必要且容易错。
 *
 * @param {Map<string,string>} files
 * @returns {Map<string, {value:string, path:string}>}
 */
export function extractConstValues(files) {
  const out = new Map();
  for (const [path, text] of files) {
    if (!path.endsWith('.d.ts')) continue;
    const re = /export\s+declare\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*([^;\n]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const name = m[1];
      const raw = m[2].trim();
      if (!isLiteral(raw)) continue;
      if (!out.has(name)) out.set(name, { value: raw, path });
    }
  }
  return out;
}

function isLiteral(raw) {
  const s = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/^'(?:[^'\\]|\\.)*'$/.test(s) || /^"(?:[^"\\]|\\.)*"$/.test(s)) return true;
  if (s === 'true' || s === 'false') return true;
  if (/^\[[^\]]*\]$/.test(s)) return true;
  return false;
}

/** 比对两端常量字面量值。 */
export function diffConstValues(oldFiles, newFiles) {
  const a = extractConstValues(oldFiles);
  const b = extractConstValues(newFiles);
  const deltas = [];
  for (const [name, nb] of b) {
    const ob = a.get(name);
    if (!ob) continue; // 新增常量 = 新能力，不是语义变化
    if (ob.value === nb.value) continue;
    deltas.push({
      kind: 'const-value-changed', symbol: name,
      before: ob.value, after: nb.value,
      severity: 'warn',
      note: `导出常量的值变了（${name}: ${ob.value} → ${nb.value}）—— 签名没动，行为会变`,
    });
  }
  return deltas;
}

/**
 * 抓新增的 `@deprecated` 标记。
 *
 * 这是整套判读里**唯一带前置预警价值**的一类：本版还能用，下一版就删。
 * 语义上它不算破坏（现在没坏），所以 severity 是 info，但列出来，
 * 让「下一版要删什么」提前一版进视野。
 *
 * @param {Map<string,string>} oldFiles
 * @param {Map<string,string>} newFiles
 */
export function diffDeprecations(oldFiles, newFiles) {
  const names = (files) => {
    const out = new Map();
    for (const [path, text] of files) {
      if (!path.endsWith('.d.ts')) continue;
      // JSDoc 块 + 紧随其后的声明行；只认 `@deprecated` 块
      const re = /\/\*\*([\s\S]*?)\*\/\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:function|class|interface|type|const|enum|let|var)\s+([A-Za-z_$][\w$]*)/g;
      let m;
      while ((m = re.exec(text))) {
        if (!/@deprecated/.test(m[1])) continue;
        const note = (/@deprecated\s*([^\n*]*)/.exec(m[1])?.[1] ?? '').trim().slice(0, 120);
        if (!out.has(m[2])) out.set(m[2], note);
      }
    }
    return out;
  };
  const before = names(oldFiles);
  const after = names(newFiles);
  const deltas = [];
  for (const [name, note] of after) {
    if (before.has(name)) continue;
    deltas.push({
      kind: 'deprecated-added', symbol: name,
      before: null, after: note || '(no note)',
      severity: 'info',
      note: `新增 @deprecated 标记${note ? `：${note}` : ''} —— 本版可用，下一版可能删`,
    });
  }
  return deltas;
}

/**
 * 过滤「整包联动」噪声。
 *
 * dsh 是 monorepo 出片：`dsh-tools@0.2.1-rc.3` 的 `dependencies` 里写着
 * `dsh-brand: 0.2.1-rc.3`，下一版自然变成 `dsh-brand: 0.2.2-alpha.2`。
 * 这类条目**数量最多、信息量为零** —— 它们只是跟着整包一起抬版本号。
 *
 * 判据（宁可漏一条，不要造十条噪声）：范围变化的两端恰好等于「本包自身的
 * from → to」。第三方依赖（schemastery、cordis 等）版本不同，不会被误滤。
 *
 * @param {Array} deltas
 * @param {{from?:string|null, to?:string|null}} self
 */
function dropLockstepNoise(deltas, self = {}) {
  const from = self.from ?? null;
  const to = self.to ?? null;
  if (!from || !to) return deltas;
  return deltas.filter((d) => {
    if (!/-(range-changed)$/.test(d.kind)) return true;
    return !(d.before === from && d.after === to);
  });
}

/** 严重度排序，供汇总与截断用（blocker 最先） */
const SEV_RANK = { blocker: 0, warn: 1, info: 2 };

/**
 * 一次收齐全部语义差异。
 *
 * @param {{oldFiles:Map<string,string>, newFiles:Map<string,string>,
 *          selfFrom?:string|null, selfTo?:string|null}} p
 *   `selfFrom` / `selfTo` 用于剔除「整包联动」噪声（见 `dropLockstepNoise`）。
 * @returns {{status:'ok'|'unknown', reason:string|null, deltas:Array, bySeverity:Record<string,number>}}
 */
export function collectSemanticDeltas({
  oldFiles, newFiles, selfFrom = null, selfTo = null, localEngines = null,
}) {
  if (!oldFiles || oldFiles.size === 0 || !newFiles || newFiles.size === 0) {
    return {
      status: 'unknown',
      reason: !oldFiles?.size ? '本机已装版本的接口面为空' : '目标版本的接口面为空',
      deltas: [],
      bySeverity: {},
    };
  }

  const meta = diffMeta(
    readMetaFromFiles(oldFiles), readMetaFromFiles(newFiles), { localEngines },
  );
  // 元信息拿不到：仍可跑常量与废弃标记（这两项不依赖 package.json），
  // 但**必须把 meta 的 unknown 说出来**，不能让「deltas 非空」掩盖「元信息没读到」。
  const metaDeltas = meta.status === 'ok' ? meta.deltas : [];
  const rest = [...diffConstValues(oldFiles, newFiles), ...diffDeprecations(oldFiles, newFiles)];
  const deltas = dropLockstepNoise([...metaDeltas, ...rest], { from: selfFrom, to: selfTo })
    .sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9));

  return {
    status: meta.status,
    reason: meta.reason,
    deltas,
    bySeverity: countBySeverity(deltas),
  };
}

function countBySeverity(deltas) {
  const out = {};
  for (const d of deltas) out[d.severity] = (out[d.severity] ?? 0) + 1;
  return out;
}

/**
 * 语义差异里「**确定会阻断**」的那几条（与使用面无关、也不是「值得看一眼」）。
 *
 * 与 `depface.js` 的 `usedImpact` 是同一层意思：把「上游改了什么」和
 * 「跟我有没有关系」分开。这里进一步只留「必然相关且必然阻断」的：
 *   - `module-type-changed`：改变全部 import 解析，恒 blocker
 *   - `engine-raised` **且 severity=blocker**：本机版本不满足新下限
 *
 * ⛔ 必须按 `severity` 过滤，不能只看 kind。2026-10-28 实测踩到：
 *    `engines.node (unset) → >=24.9` 在本机 node 24.21.0 上只是 `warn`（换机器的人才受影响），
 *    但初版只按 kind 判，于是 `semanticImpact='blocker'`、`hostFace.blocking=true` ——
 *    面板会把一个「本机完全能满足」的变化标成阻断。**同一条变化，本机满足与否结论相反**，
 *    这个判断已经写在 `severity` 里了，这里不该再判一遍。
 */
export function directImpact(deltas) {
  return (deltas ?? []).filter((d) => d.severity === 'blocker'
    && (d.kind === 'engine-raised' || d.kind === 'module-type-changed'));
}
