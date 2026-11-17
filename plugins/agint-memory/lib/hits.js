/**
 * agint-memory: 召回命中计数（旁路 JSONL，append-only）
 *
 * 为什么计数不写 memory 表（2026-11-07 实测）：
 * - memory 表是 single-layout 单元（`<DSH_HOME>/storages/agint.json`，869 条 ≈ 879KB），
 *   每一次 putRecord 都要整体重写那个文件。
 * - 实测单行写延迟（工具统计 agint_tool_stats.jsonl）：memory_write 平均 764ms、
 *   memory_remove 平均 1015ms。一次检索命中 20 条 ⇒ 20 次写 ≈ 15 秒，模型等不起
 *   ⇒ 写回型计数在生产上不可行。
 * - 所以计数落旁路文件：一次检索写一行（append，O(1)），读侧在内存里合并。
 *
 * 口径（什么算一次召回）：
 * - 只有**模型面向的检索**命中才算：memory_search 工具、agint_search 工具。
 * - 后台自检检索不算：provider prefetch、诊断反事实、质量评估信任分、压缩兜底
 *   （agint-compress-guard 明确要求「单次单向不回写记忆库」，计数不得破坏它）。
 * - read / list / forget_scan 不算 —— 读不是用。
 *
 * 读侧合并口径：表内 legacy recalls（recall() 写的）+ 本文件命中数。
 * 合并值只在读接口（list / search）呈现，不回写 memory 表 ⇒ 排序与衰减口径不变。
 *
 * 文件形状：一行 = 一次检索 = { version, ts, ids: [...] }。
 * 尾部半行 / 坏行在读时丢弃（partial write 保护）。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const HITS_STORE_VERSION = 1;
export const HITS_STORE_FILENAME = 'agint_memory_hits.jsonl';

/** 路径：`<DSH_HOME>/storages/agint_memory_hits.jsonl`（跟 tool-stats / dream recall 同规范）。 */
export function defaultHitsPath(home = process.env.DSH_HOME || '') {
  const base = home || join(process.env.HOME || process.cwd(), '.dsh');
  return join(resolve(base), 'storages', HITS_STORE_FILENAME);
}

/**
 * 命中计数存储。
 * @param {string} path JSONL 文件路径
 */
export function createHitStore(path) {
  let counts = null;   // Map<id, number>
  let loading = null;  // 并发 load 共享同一个 promise

  /** 读全量计数（首次读文件，之后走内存）。文件不存在 = 零命中。 */
  async function load() {
    if (counts) return counts;
    if (!loading) {
      loading = (async () => {
        const map = new Map();
        let text = '';
        try {
          text = await readFile(path, 'utf8');
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;   // 尾部半行 / 坏行：跳过，不让脏行吃掉整份计数
          }
          const ids = Array.isArray(rec?.ids) ? rec.ids : [];
          for (const id of ids) {
            if (typeof id !== 'string' || !id) continue;
            map.set(id, (map.get(id) ?? 0) + 1);
          }
        }
        counts = map;
        return map;
      })().catch((err) => {
        loading = null;   // 读失败允许下次重试
        throw err;
      });
    }
    return loading;
  }

  /**
   * 记一次检索命中的 id 列表。
   * @returns {Promise<number>} 记账条数；写失败返回 0（不抛，不阻断检索）
   */
  async function note(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x))];
    if (list.length === 0) return 0;
    const map = await load();
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(
        path,
        JSON.stringify({ version: HITS_STORE_VERSION, ts: Date.now(), ids: list }) + '\n',
        'utf8',
      );
    } catch {
      return 0;   // 记账失败不能拖垮检索
    }
    for (const id of list) map.set(id, (map.get(id) ?? 0) + 1);
    return list.length;
  }

  /** 计数快照：Map<id, number>。 */
  async function snapshot() {
    return load();
  }

  return { path, load, note, snapshot };
}
