/**
 * agint-evolution-memory: canonical serialization + hash-input normalization
 * （Phase 1 交付物 3 §4.3.1）
 *
 * ## 为什么插件里要有第三份 canonical 实现
 *
 * 本仓已有两份确定性序列化：
 *   - `bin/lib/canonical-json.mjs`（Phase 0，Frozen manifest / unit contentHash）
 *   - `plugins/agint-evolution-driver/lib/predictor.js:198`（交付物 1 的 hypothesisLock）
 *
 * ⛔ 插件**不能** import `bin/lib/canonical-json.mjs`：`install/` 只把 `plugins/`
 * + `cordis.patch.yml` + `package.json` 同步进 bundle，`bin/` **不随包部署**
 * （设计 §4 取证表），插件里 import 它会在生产直接 `ERR_MODULE_NOT_FOUND`。
 * driver 侧当年正是因此自实现了一份（见 predictor.js 头注第 2 条）。Ledger 的
 * owner 在 evolution-memory，跨插件 import lib 又违反本仓零跨插件耦合纪律
 * ⇒ 第三份副本不可避免，于是**防漂移**变成硬要求：
 * `fixtures/ledger-hash-vectors.json` 由三份实现各自跑同一份向量，
 * 任一方改序列化行为即变红（§4.3.1「两份 canonical 实现的防漂移要求」，
 * 实测仓内是三份）。
 *
 * ## 确定性契约（与上述两份逐条一致）
 *
 *   1. 对象 key 按 Unicode **码点**升序（不是 UTF-16 码元序 —— 代理对会排错位）
 *   2. 无缩进、无多余空格
 *   3. 字符串原样 UTF-8（非 ASCII 不转义，中文/emoji 跨环境一致）
 *   4. `-0` 归一为 `0`
 *   5. 非有限数字（NaN/Infinity）抛错，不静默变 `null`
 *      —— `JSON.stringify(NaN) === 'null'`，撞 hash 即漏检，宁可 fail-closed
 *   6. 值为 `undefined` 的键整个省略（与 JSON 语义对齐）
 *
 * ## 哈希入参的三个附加规则（§4.3.1「确定性的四个真实来源」中的 ②③④）
 *
 * 纯序列化本身不足以让 hash 跨环境稳定，Ledger 还需要在**入哈希前**把
 * 「同一事实的多种写法」归一。⚠️ 这些规则只作用于 `prepareHashInput`
 * 的输出，**不改写存储值**（存储保持原值以便复算审计）。
 *
 * 它们绝不允许塞进 `canonicalStringify` 本体：Merkle 内部节点、proof 的
 * 兄弟节点序列都是**顺序有意义**的数组，一旦被排序，同一棵树会算出两个根，
 * 而报错形态与真篡改一模一样。
 */

import { createHash } from 'node:crypto';

/** 摘要算法前缀标识（与 `contract_locks.lockAlgorithm` / LOCK_ALGORITHM 同格式）。 */
export const HASH_ALGORITHM = 'sha256';

/**
 * 哈希入参的数字量化精度（小数位数）。
 *
 * 依据 §4.3.1 ②：`0.6 * 0.94 + 0.4 * 0` 这类浮点算式的**末位**在不同 V8
 * 版本/优化路径下并不保证一致，而 0.94 与 0.9400000000000001 序列化字节不同
 * ⇒ 同一条目在两台机器上算出两个 entryHash ⇒ 假 ANCHOR_MISMATCH。
 * 业务上 ledger 里的数字（predictedDelta / actualDelta / predictionQuality）
 * 精度远粗于 1e-4，量化到 4 位不损失信息。
 */
export const HASH_DECIMALS = 4;

/**
 * 数字量化后仍走定点表示的上界。
 *
 * ⛔ 超出即抛错而不是"想办法表示一下"：`JSON.stringify(1e21)` 产出 `"1e+21"`
 * （指数计数法），而 §4.3.1 ② 明确要求哈希入参不用指数形态。ledger 的任何
 * 字段都不可能到这个量级，走到这里说明数据本身有问题（fail-closed）。
 */
export const HASH_ABS_UPPER_BOUND = 1e21;

/**
 * `GENESIS_PARENT_HASH` —— 创世前驱常量（§4.3.2）。
 *
 * ⛔ 禁止由代码推导或从文件读取：这个常量一旦被改写，整条链即可整体伪造
 * （重算所有 hash 时把 seq=1 的 parentHash 也一起改掉）。校验器与写入侧
 * 各自硬编码同一字面量，并由向量表锁定，不接受任何外部输入。
 */
export const GENESIS_PARENT_HASH = `sha256:${'0'.repeat(64)}`;

// ── 确定性序列化 ──────────────────────────────────────────────────────────

/**
 * 按 Unicode 码点比较两个字符串（`Array#sort` 默认是 UTF-16 码元序）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareByCodePoint(a, b) {
  if (a === b) return 0;
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i].codePointAt(0);
    const y = B[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return A.length - B.length;
}

function serializeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `canonicalStringify: 非有限数字不能参与 hash（会得到与 null 相同的摘要）: ${String(n)}`,
    );
  }
  return JSON.stringify(n === 0 ? 0 : n);
}

function serialize(value) {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'undefined') return 'null'; // 数组槽位/裸值：与 JSON.stringify 对齐
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return serializeNumber(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') {
    throw new TypeError('canonicalStringify: bigint 无 JSON 表示，请先显式转换为字符串');
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalStringify: ${t} 不可序列化`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(',')}]`;
  }

  const parts = [];
  for (const k of Object.keys(value).sort(compareByCodePoint)) {
    const v = value[k];
    if (v === undefined) continue; // ④ 禁止 undefined 值键（JSON 语义整个省略）
    parts.push(`${JSON.stringify(k)}:${serialize(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 规范化 JSON（确定性序列化）。契约见文件头六条。
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {TypeError} 非有限数字 / bigint / function / symbol
 */
export function canonicalStringify(value) {
  return serialize(value);
}

/**
 * `sha256:<hex>`（对规范化序列化结果取摘要）。
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalHash(value) {
  const hex = createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
  return `${HASH_ALGORITHM}:${hex}`;
}

/** 拼接两个摘要为一个内部节点（Merkle / roll-up 共用同一原语）。 */
export function concatHash(left, right) {
  return canonicalHash([left, right]);
}

// ── §4.3.1 哈希入参归一（量化 + 列表排序 + 时间戳校验）──────────────────

/**
 * 量化单个数字：四舍五入到 {@link HASH_DECIMALS} 位、归一 -0、限定点表示。
 *
 * 用 `toFixed` 而非 `Math.round(n * 1e4) / 1e4`：后者会先引入一次乘法误差再除回来，
 * `1.00005` 这类正好落在进位边界上的值可能在两台机器上进到不同结果，
 * 而这正是我们想消除的那一类末位不确定性。`toFixed` 按 IEEE-754 双精度的
 * **精确十进制值**舍入，同一 double 在任何环境产出同一串。
 *
 * @param {number} n
 * @returns {number} 量化后的数字（仍是 number，保持哈希入参的类型不漂移）
 */
export function quantizeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TypeError(`quantizeNumber: 非有限数字不能入哈希: ${String(n)}`);
  }
  if (Math.abs(n) >= HASH_ABS_UPPER_BOUND) {
    throw new TypeError(
      `quantizeNumber: |${String(n)}| >= ${HASH_ABS_UPPER_BOUND} 会用指数计数法表示，违反 §4.3.1 ②`,
    );
  }
  const q = Number(n.toFixed(HASH_DECIMALS));
  return q === 0 ? 0 : q; // -0 归一
}

/**
 * 归一「哈希入参」：递归量化数字 + 对**纯字符串数组**按码点排序。
 *
 * 为什么排序规则按"元素全为字符串"判定，而不是维护一份字段白名单：
 * 白名单是一份需要三处实现同步的隐藏状态 —— 新增字段时漏加即静默不排序，
 * 而 `["a","b"]` 与 `["b","a"]` 在语义上是同一事实（§4.3.1 ③），
 * 不排序就是往哈希里注入随机性。判据写成结构规则，行为对调用方无感知。
 *
 * ⛔ 顺序有意义的序列（Merkle 叶子、proof 兄弟路径）**必须走
 * `canonicalStringify`/`concatHash`，不得经过本函数** —— 那些数组的元素也是
 * 字符串，会被这里排掉。
 *
 * @param {unknown} value
 * @returns {unknown} 归一后的副本（不修改入参：存储值保持原样）
 */
export function prepareHashInput(value) {
  if (value === null) return null;

  const t = typeof value;
  if (t === 'number') return quantizeNumber(value);
  if (t === 'string' || t === 'boolean' || t === 'undefined') return value;
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new TypeError(`prepareHashInput: ${t} 不可入哈希`);
  }

  if (Array.isArray(value)) {
    const mapped = value.map((v) => prepareHashInput(v));
    const allStrings = mapped.every((v) => typeof v === 'string');
    if (allStrings) mapped.sort(compareByCodePoint);
    return mapped;
  }

  if (value instanceof Map) {
    // Map 不参与序列化（canonical 只认 plain object）；显式拒绝而非静默出 `{}`。
    throw new TypeError('prepareHashInput: Map 无 JSON 表示，请先转成普通对象');
  }
  if (value instanceof Set) {
    // Set 的迭代顺序是插入顺序 ⇒ 同一集合两种插入顺序两个 hash，正是 §4.3.1 ③
    // 要消除的那类不确定性。转成排序数组后语义等价且确定。
    return [...value].map((v) => prepareHashInput(v)).sort(compareByCodePoint);
  }

  const out = {};
  for (const k of Object.keys(value)) {
    if (value[k] === undefined) continue; // ④ undefined 值键省略
    out[k] = prepareHashInput(value[k]);
  }
  return out;
}

/**
 * `new Date().toISOString()` 形态校验（§4.3.1 ①：UTC + 3 位毫秒 + 字面 Z）。
 *
 * Windows 与 CI ubuntu 的本地时区串/毫秒位数差异足以让同一条目算出两个 hash，
 * 所以**落库前**校验格式，不合即拒绝写入（fail-closed），而不是等到锚定时
 * 才发现"跨环境不一致"这种最难排查的形态。
 *
 * @param {string} timestamp
 * @param {string} [field] 出错信息里的字段名
 * @returns {string} 原值（便于内联使用）
 * @throws {TypeError} 格式不合
 */
export function assertUtcMillisIso(timestamp, field = 'timestamp') {
  if (typeof timestamp !== 'string') {
    throw new TypeError(`${field}: 时间戳必须是字符串`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new TypeError(
      `${field}: 时间戳必须是 UTC + 毫秒 + Z 形态（new Date().toISOString()），收到 ${JSON.stringify(timestamp)}`,
    );
  }
  // 正则放行的是「形状」，还要确认它是真实时刻：V8 对 `2026-02-31` 会**顺延到 3 月 3 日**
  // 而不是判 NaN（实测 Date.parse 得到有限值），所以只能用往返等值判定 ——
  // 规范化后再打印必须与原串逐字符相同，否则那个输入并不存在。
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new TypeError(`${field}: 不是真实时刻（规范化后为 ${new Date(timestamp).toISOString()}）: ${timestamp}`);
  }
  return timestamp;
}
