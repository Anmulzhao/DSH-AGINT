/**
 * agint-compress-guard: dsh 会话文件只读检索（R10 / M4「原文可检索」入口）。
 *
 * 背景（设计稿 §2.1 R10 / §〇ter 第 1 条）：dsh 会话文件是多帧 zstd 的
 * append-only 结构（K22）。宿主压缩 = surface 替换（shadowedSeqs 被移出上下文
 * 窗口），**物理事件不删除** —— 因此被压缩的原文原则上仍可从文件读回。
 * 本模块给 host-compaction 检查点引用提供「按 shadowedSeqs 回溯原文」的
 * 检索入口（recall 双通道的下钻路径之一，设计稿 §4.1 recall）。
 *
 * 格式实证（2026-09-13 探针 _r10_probe4.mjs，155 文件 / 140,109 事件全解）：
 *   - 文件 = 拼接的 zstd 帧流（magic 0x28 B5 2F FD），逐帧 zstdDecompressSync
 *   - 每帧内 = JSONL（一行一个事件记录，{seq, type, data?, ...}）
 *   - Node 原生 createZstdDecompress 流**不会**自动续解后续帧（探针 1 实测
 *     只出第一帧），必须按 magic 切帧逐帧解。
 *
 * 只读：绝不写、绝不移动、绝不删除会话文件。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 单文件解析缓存：path → { mtimeMs, size, seqMap }（进程内，防止重复解帧） */
const cache = new Map();
const CACHE_MAX = 24;

function isMagic(buf, i) {
  return buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
    && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3];
}

/**
 * 解压多帧 zstd 会话文件并按 seq 建索引。
 * 伪 magic（压缩数据中偶然出现同字节序列）由「解码成功 + JSON 可解析」双重
 * 校验筛掉 —— 与宿主 scanZstdFrames 的严格头部解析相比是保守近似，
 * 对只读检索足够（解不动的帧直接跳过，不抛错）。
 */
export function indexSessionFile(filePath) {
  let stat;
  try { stat = statSync(filePath); } catch { return null; }
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.seqMap;

  let buf;
  try { buf = readFileSync(filePath); } catch { return null; }
  if (buf.length < 8) return null;

  // 收集 magic 候选起点
  const offs = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (isMagic(buf, i)) offs.push(i);
  }

  const seqMap = new Map(); // seq → record
  for (let i = 0; i < offs.length; i++) {
    const start = offs[i];
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
    let out;
    try { out = zstdDecompressSync(buf.subarray(start, end)); } catch { continue; }
    let text;
    try { text = out.toString('utf8'); } catch { continue; }
    if (!text.includes('{')) continue;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; }
      if (rec && typeof rec === 'object' && Number.isFinite(Number(rec.seq))) {
        seqMap.set(Number(rec.seq), rec);
      }
    }
  }

  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, seqMap });
  return seqMap;
}

/** 列出 sessionsRoot 下全部 session*.jsonl.zstd 文件（只读遍历） */
export function listSessionFiles(sessionsRoot) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3 || out.length >= 400) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^session.*\.jsonl\.zstd$/.test(e.name)) out.push(p);
    }
  };
  walk(String(sessionsRoot ?? ''), 0);
  return out;
}

/**
 * 按 shadowedSeqs 回溯被压缩的原始消息。
 *
 * @param {object} args
 * @param {number[]} args.shadowedSeqs 被替换掉的消息 seq（compaction/summary 载荷）
 * @param {string} [args.sessionId] 会话 id（有则只扫该会话目录）
 * @param {string} args.sessionsRoot dsh 会话根目录（config.sessionsRoot）
 * @returns {Promise<Array<{seq: number, record: object, file: string}>>}
 */
export async function findShadowedMessages({ shadowedSeqs, sessionId, sessionsRoot }) {
  const wanted = (Array.isArray(shadowedSeqs) ? shadowedSeqs : []).map(Number).filter(Number.isFinite);
  if (wanted.length === 0) return [];

  let files = listSessionFiles(sessionsRoot);
  if (sessionId) {
    files = files.filter((f) => f.includes(String(sessionId)));
  }

  const found = [];
  const remaining = new Set(wanted);
  for (const file of files) {
    if (remaining.size === 0) break;
    const seqMap = indexSessionFile(file);
    if (!seqMap) continue;
    for (const seq of [...remaining]) {
      const rec = seqMap.get(seq);
      if (rec) {
        found.push({ seq, record: rec, file });
        remaining.delete(seq);
      }
    }
  }
  return found;
}

/** 测试钩子：清空解析缓存 */
export function clearSessionCache() {
  cache.clear();
}
