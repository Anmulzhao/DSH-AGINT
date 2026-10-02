#!/usr/bin/env node
/**
 * bin/lib/canonical-json.mjs —— 规范化 JSON 序列化（hash 确定性基础设施）
 *
 * 用途：Phase 0 §3.2.6 的 canonicalStringify 要求。Frozen manifest / unit
 * contentHash / Contract hypothesisLock 全部复用同一实现；Phase 1 的 Ledger
 * entryHash 也指名复用本模块（设计 §6.5 交接清单）。
 *
 * ★ 为什么不能直接 JSON.stringify：
 *   对象 key 的插入顺序会影响输出字节 ⇒ 同一份逻辑对象在两个环境里
 *   （比如对象字面量书写顺序不同、或经过一次 spread 复制）会算出不同的
 *   sha256 ⇒ 门禁出现假 FROZEN_TAMPERED 告警，信任一旦崩了就修不回来。
 *   设计 §6.4 把这条列为「概率中 / 影响高」的风险，本模块就是对症的解。
 *
 * 确定性契约（五条，改动前先读）：
 *   1. 对象 key 按 Unicode **码点**字典序递归排序（不是 UTF-16 码元序 ——
 *      否则代理对字符会排错位）
 *   2. 无缩进、无多余空格（separators 等价于 [",", ":"]）
 *   3. 字符串 UTF-8、无 BOM（落盘侧由 writeJsonNoBom 保证；
 *      继承教训 §4：PowerShell Set-Content -Encoding UTF8 会带 BOM，
 *      下游 JSON.parse 直接拒收）
 *   4. 数字不做格式化（不补零、不转科学计数法）
 *   5. volatile 字段（generatedAt / timestamp 之类每次运行都变的）不参与 hash，
 *      由调用方通过 options.excludeKeys 显式声明 —— 见下方「为什么默认不排除」
 *
 * 为什么默认 excludeKeys = []（而不是内置一份黑名单）：
 *   这是**防篡改**用途。静默丢弃字段 = 该字段被改了也检测不出来，
 *   等于给 manifest 开了一个谁都看不见的后门（真实 > 讨好）。
 *   所以默认一个字段都不丢；只有确认「这个字段本来就该每次变」的调用点
 *   （如 Contract 整体 hash）才显式传 DEFAULT_VOLATILE_KEYS。
 *
 * 零依赖：只用 node:crypto / node:fs。
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** 建议的 volatile 字段清单。调用方显式传入才生效。 */
export const DEFAULT_VOLATILE_KEYS = ['generatedAt', 'timestamp'];

/**
 * 按 Unicode 码点序列比较两个字符串。
 * （默认的 Array#sort 是 UTF-16 码元序，遇到代理对会排错。）
 */
function compareByCodePoint(a, b) {
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

function serializeString(s) {
  // JSON.stringify(string) 的转义规则与 RFC 8259 一致，且默认不 \u 转义
  // 非 ASCII 字符 —— 中文原样保留，跨环境一致。
  return JSON.stringify(s);
}

function serializeNumber(n) {
  // ★ 不静默吞掉非有限数：JSON.stringify(NaN) === 'null'，
  //   会让 NaN / Infinity 与真正的 null 撞出同一个 hash。
  //   这是防篡改场景，撞 hash = 漏检，宁可 fail-closed 抛错。
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `canonicalStringify: 非有限数字不能参与 hash（会得到与 null 相同的摘要）: ${String(n)}`,
    );
  }
  // -0 归一为 0，避免 -0 与 0 产出不同字节。
  const v = n === 0 ? 0 : n;
  return JSON.stringify(v);
}

/**
 * 规范化序列化任意值。
 *
 * @param {unknown} value
 * @param {{ excludeKeys?: string[] }} [options]
 *        excludeKeys：递归排除的 key 名（在所有层级生效）。默认 [] —— 不丢任何字段。
 * @returns {string} 确定性 JSON 文本
 */
export function canonicalStringify(value, options = {}) {
  const exclude = Array.isArray(options.excludeKeys) ? new Set(options.excludeKeys) : new Set();
  return serialize(value, exclude);
}

function serialize(value, exclude) {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'undefined') return 'null'; // 数组槽位/裸值：与 JSON.stringify 对齐
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return serializeNumber(value);
  if (t === 'string') return serializeString(value);
  if (t === 'bigint') {
    // JSON 无 bigint；防篡改场景下不静默降级，抛错要求调用方自己转成 string。
    throw new TypeError('canonicalStringify: bigint 无 JSON 表示，请先显式转换为字符串');
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalStringify: ${t} 不可序列化`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v, exclude)).join(',')}]`;
  }

  const keys = Object.keys(value)
    .filter((k) => !exclude.has(k))
    .sort(compareByCodePoint);

  const parts = [];
  for (const k of keys) {
    const v = value[k];
    // 对象里的 undefined 值按 JSON 语义整个省略（不是写成 null）。
    if (v === undefined) continue;
    parts.push(`${serializeString(k)}:${serialize(v, exclude)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 对规范化序列化结果取 sha256。
 * @param {unknown} value
 * @param {{ excludeKeys?: string[], prefix?: boolean }} [options]
 *        prefix：是否在返回值前加 "sha256:"（Frozen manifest 的字段格式带前缀）。
 * @returns {string}
 */
export function canonicalHash(value, options = {}) {
  const hex = createHash('sha256')
    .update(canonicalStringify(value, options), 'utf8')
    .digest('hex');
  return options.prefix ? `sha256:${hex}` : hex;
}

/**
 * 对已读到的 UTF-8 文本取 sha256（用于文件级 hash，跳过 JSON 解析）。
 * @param {string} text
 * @param {{ prefix?: boolean }} [options]
 */
export function textHash(text, options = {}) {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex');
  return options.prefix ? `sha256:${hex}` : hex;
}

/**
 * 无 BOM 落盘 JSON。
 * Node 的 writeFileSync(encoding:'utf8') 本身不加 BOM；这里包一层是为了
 * 让「无 BOM」成为一处显式声明的、可被 grep 到的约束，而不是靠人记住。
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ spaces?: number }} [options] 默认 2 空格缩进（人读友好，不影响 hash）
 */
export function writeJsonNoBom(filePath, value, options = {}) {
  const spaces = options.spaces === undefined ? 2 : options.spaces;
  // \n 而非 \r\n：Windows 上 git 的 autocrlf 会把 \n 转 \r\n，
  // 但内容 hash 走的是 canonicalStringify（内存里算），不受换行符影响；
  // 这里统一 \n 只是让 diff 干净。
  writeFileSync(filePath, `${JSON.stringify(value, null, spaces)}\n`, 'utf8');
}
