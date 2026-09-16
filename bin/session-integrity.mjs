#!/usr/bin/env node
/**
 * session-integrity.mjs — scan and repair dsh session logs that the live
 * replay/persistence layer would reject on resume/list.
 *
 * TWO INDEPENDENT FAILURE CLASSES
 * ------------------------------
 * (1) EVENT SHAPE — `assertMessageEventShape` (@deepseek-ai/dsh-session 0.1.6)
 *     For `user/message` the fields live directly on `event.data`. A message
 *     must carry a non-empty `id`, `role === 'user'`, `source.kind`, and a
 *     `content` array. Missing `id`/`role` yields, on open:
 *       "session event at seq N lacks an identified message"
 *     2026-09-16 cause: agint-rules injected `additionalContexts` as a bare
 *     `{ source, content }` object (no id, no role). The WRITE path tolerated
 *     it; the RESUME path rejected it — so damage was silent at write time.
 *
 * (2) FRAME STRUCTURE — `assertZstdHeaderFrame`
 *     (dsh-session-persistence-jsonl). The log is a container of concatenated
 *     independently-decodable zstd frames:
 *         frame 0  = ONLY the header line  (JSON… + "\n")
 *         frame 1+ = event batches, each plainly ending in "\n"
 *     The reader locates frames structurally (magic + descriptor + block
 *     chain, see scanZstdFrames below) and asserts for frame 0:
 *         plaintext.length > 0 && plaintext.indexOf(10) === plaintext.length - 1
 *     Violating it aborts BOOT, not just the session:
 *       "corrupt Zstandard session log: first frame is not exactly one header line"
 *     2026-09-16 cause: an earlier revision of THIS TOOL re-compressed the whole
 *     log into a single frame. Collapsing frames is a boot-level outage — never
 *     regenerate a log as one frame.
 *
 * REPAIR STRATEGY
 * ---------------
 * Two modes, chosen per file, both content-preserving:
 *   - in-place frame edit : when the structure is already valid, only the
 *     frames holding a patched line are re-compressed; every other frame is
 *     copied byte-for-byte.
 *   - reframe             : when the structure is invalid (collapsed frame,
 *     torn tail), re-emit as frame 0 = header line, frame 1+ = event lines
 *     chunked to FRAME_MAX_LINES / FRAME_MAX_BYTES. Line order, `seq`, and
 *     every other field are untouched.
 * Never merged into a single frame. Every write is re-validated with the same
 * two assertions before the file is accepted; on failure the backup is restored.
 *
 * USAGE
 *   node bin/session-integrity.mjs [--root <dir>] [--scan|--dry|--fix]
 *     --scan  report both failure classes (default)
 *     --dry   like --scan, plus the raw bad record JSON
 *     --fix   back up each affected file, repair it, re-validate
 *
 * NOTE ON WINDOWS PATHS: do not pass an absolute path through `--root` from a
 * POSIX shell — Git Bash splits argv on ":" and `C:/x` arrives as `C`. Use the
 * built-in default or bake the path in.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SESSIONS_ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : 'C:/Users/Administrator/.dsh/sessions';

const MODE = process.argv.includes('--fix') ? 'fix'
  : process.argv.includes('--dry') ? 'dry'
  : 'scan';

/** Little-endian uint32 of the zstd magic bytes 28 B5 2F FD. */
const ZSTD_MAGIC = 4247762216;
const MESSAGE_ROLE_BY_TYPE = {
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'user',
};
/** Re-framing chunking: keep each frame a small, indivisible synchronous decode. */
const FRAME_MAX_LINES = 64;
const FRAME_MAX_BYTES = 48 * 1024;
/** dsh's own compression options (checksum flag part of the frame descriptor). */
function zstdOptions() {
  const flag = zlib.constants.ZSTD_c_checksumFlag;
  return flag === undefined ? {} : { params: { [flag]: 1 } };
}
function compressFrame(buf) {
  return zlib.zstdCompressSync(buf, zstdOptions());
}

/**
 * Faithful copy of `scanZstdFrames` from
 * @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:1299.
 * Parses real frame structure (magic -> descriptor -> block chain -> checksum)
 * instead of scanning for magic bytes, which would false-positive on payload.
 * Returns complete `{start,end}` ranges plus `tornStart` for a truncated tail.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Mirror of `assertZstdHeaderFrame`: the first frame must be exactly one line. */
export function isHeaderOnlyFrame(plaintext) {
  return plaintext.length > 0 && plaintext.indexOf(10) === plaintext.length - 1;
}

/** Mirror of the live validator. Returns [] if valid, else violation strings. */
export function validateMessageEvent(event) {
  const type = event && event.type;
  if (!(type in MESSAGE_ROLE_BY_TYPE)) return [];
  const data = event.data;
  const record = typeof data === 'object' && data !== null ? data : undefined;
  const message = type === 'user/message' ? record : (record ? record.message : undefined);
  const subject = `seq ${event.seq}`;
  if (typeof message !== 'object' || message === null
    || typeof message.id !== 'string' || message.id === '') {
    return [`${subject} lacks an identified message`];
  }
  const errs = [];
  const expected = MESSAGE_ROLE_BY_TYPE[type];
  if (message.role !== expected) errs.push(`${subject} message must have role "${expected}"`);
  const src = message.source;
  if (typeof src !== 'object' || src === null || typeof src.kind !== 'string' || src.kind === '') {
    errs.push(`${subject} message has invalid source`);
  }
  if (!Array.isArray(message.content)) errs.push(`${subject} message has invalid content`);
  return errs;
}

/** Locate the message object that needs repair, or null if not fixable. */
function messageTarget(event) {
  const type = event.type;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return null;
  if (type === 'user/message') {
    // Guard: a hybrid (top-level fields AND data.message) is not a shape we
    // produced — refuse to guess rather than double-nest.
    if (data.message && typeof data.message === 'object') return null;
    return data;
  }
  if (typeof data.message === 'object' && data.message !== null) return data.message;
  return null;
}

function listLogs(root, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const fp = path.join(root, e.name);
    if (e.isDirectory()) listLogs(fp, out);
    else if (/^session.*\.jsonl\.zstd$/.test(e.name)) out.push(fp);
  }
  return out;
}

/**
 * Read one log completely, structurally and semantically.
 * `lines` carries every plaintext line with its source frame index; `frameRanges`
 * maps each frame to its slice of `lines`, so an in-place edit can re-compress
 * only the frames it actually touched.
 */
export function analyzeFile(file) {
  const buf = fs.readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(buf);
  const frameTexts = frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf-8'));
  const headerOnly = frameTexts.length > 0 && isHeaderOnlyFrame(Buffer.from(frameTexts[0], 'utf-8'));
  const lines = [];
  const frameRanges = [];
  frameTexts.forEach((t, fi) => {
    const parts = t.split('\n');
    // Each frame's plaintext ends with "\n" (the writer appends one); drop the
    // resulting empty tail so `lines` holds only real records.
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    const start = lines.length;
    for (const p of parts) lines.push({ frame: fi, text: p });
    frameRanges.push({ start, end: lines.length });
  });
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    if (!text.trim()) continue;
    let rec;
    try { rec = JSON.parse(text); } catch { violations.push(`line ${i + 1}: not valid JSON`); continue; }
    const v = validateMessageEvent(rec);
    if (v.length) violations.push(...v);
  }
  return {
    buf, frames, frameTexts, frameRanges, lines,
    headerOnly,
    torn: tornStart !== undefined,
    violations,
  };
}

/** Reasons a file is not acceptable, checked against the same live assertions. */
function structuralProblems(info) {
  const out = [];
  if (info.torn) out.push('torn final frame');
  if (!info.headerOnly) out.push('first frame is not exactly one header line');
  return out;
}

/**
 * Rebuild one log. Returns null when the file needs no work, otherwise the new
 * bytes plus a summary. Reframes only if the structure is broken; otherwise it
 * edits frames in place.
 */
export function rebuild(info) {
  const texts = info.lines.map((l) => l.text);
  const changed = new Set();
  let fixedEvents = 0;
  for (let i = 0; i < texts.length; i++) {
    if (!texts[i].trim()) continue;
    let rec;
    try { rec = JSON.parse(texts[i]); } catch { continue; }
    if (validateMessageEvent(rec).length === 0) continue;
    const target = messageTarget(rec);
    if (!target) continue; // unrecognized corrupt shape: leave it, report upstream
    const expected = MESSAGE_ROLE_BY_TYPE[rec.type];
    let touched = false;
    if (typeof target.id !== 'string' || target.id === '') { target.id = randomUUID(); touched = true; }
    if (target.role !== expected) { target.role = expected; touched = true; }
    if (!touched) continue;
    texts[i] = JSON.stringify(rec);
    changed.add(i);
    fixedEvents += 1;
  }

  const needsReframe = info.torn || !info.headerOnly;
  if (!needsReframe && changed.size === 0) return null;

  if (!needsReframe) {
    const out = info.frameTexts.map((t, fi) => {
      const range = info.frameRanges[fi];
      let hasChange = false;
      for (const idx of changed) if (idx >= range.start && idx < range.end) { hasChange = true; break; }
      if (!hasChange) return info.buf.subarray(info.frames[fi].start, info.frames[fi].end);
      const body = texts.slice(range.start, range.end).join('\n') + '\n';
      return compressFrame(Buffer.from(body, 'utf-8'));
    });
    return { bytes: Buffer.concat(out), fixedEvents, reframed: false, framesBefore: info.frames.length };
  }

  // Reframe. The header MUST stay alone in frame 0; verify line 1 really is one
  // before trusting the file's structure at all.
  const first = texts.length > 0 ? texts[0] : '';
  let head;
  try { head = JSON.parse(first); } catch { head = null; }
  if (!head || head.type !== 'session') {
    throw new Error('refused to reframe: first line is not a session header');
  }
  const parts = [compressFrame(Buffer.from(first + '\n', 'utf-8'))];
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    parts.push(compressFrame(Buffer.from(batch.join('\n') + '\n', 'utf-8')));
    batch = [];
    bytes = 0;
  };
  for (let i = 1; i < texts.length; i++) {
    const size = Buffer.byteLength(texts[i], 'utf-8') + 1;
    if (batch.length > 0 && (batch.length >= FRAME_MAX_LINES || bytes + size > FRAME_MAX_BYTES)) flush();
    batch.push(texts[i]);
    bytes += size;
  }
  flush();
  return { bytes: Buffer.concat(parts), fixedEvents, reframed: true, framesBefore: info.frames.length };
}

function main() {
  const files = listLogs(SESSIONS_ROOT);
  const report = [];
  for (const f of files) {
    let info;
    try { info = analyzeFile(f); } catch (err) {
      report.push({ file: f, readError: err.message, info: null });
      continue;
    }
    const structural = structuralProblems(info);
    if (structural.length === 0 && info.violations.length === 0) continue;
    report.push({ file: f, structural, info, badLines: null });
  }

  console.log(`sessions root : ${SESSIONS_ROOT}`);
  console.log(`logs scanned  : ${files.length}`);
  console.log(`need repair   : ${report.length}`);
  for (const r of report) {
    const rel = path.relative(SESSIONS_ROOT, r.file);
    console.log('---');
    console.log(rel);
    if (r.readError) { console.log(`  READ ERROR: ${r.readError}`); continue; }
    for (const s of r.structural) console.log(`  [structure] ${s}`);
    for (const v of r.info.violations) console.log(`  [event] ${v}`);
    if (MODE === 'dry') {
      for (let i = 0; i < r.info.lines.length; i++) {
        const t = r.info.lines[i].text;
        if (!t.trim()) continue;
        let rec;
        try { rec = JSON.parse(t); } catch { continue; }
        if (validateMessageEvent(rec).length === 0) continue;
        console.log('  RAW: ' + JSON.stringify(rec).slice(0, 400));
      }
    }
  }

  if (MODE !== 'fix') {
    console.log(`\n(fixable-by-reframe: ${report.filter((r) => r.info && r.structural.length > 0 && r.info.violations.length === 0).length})`);
    process.exit(0);
  }

  if (report.length === 0) { console.log('\nnothing to fix.'); process.exit(0); }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Backups live OUTSIDE the sessions tree. Keeping them underneath makes every
  // later --scan treat the corrupt originals as real sessions (observed
  // 2026-09-16), which is both confusing and unsafe.
  const backupDir = path.join(path.dirname(SESSIONS_ROOT), `session-backups-${ts}`);
  fs.mkdirSync(backupDir, { recursive: true });

  let fixedFiles = 0;
  let fixedEvents = 0;
  let reframed = 0;
  for (const r of report) {
    const rel = path.relative(SESSIONS_ROOT, r.file);
    if (r.readError) { console.log(`  SKIP ${rel}: ${r.readError}`); continue; }
    let plan;
    try { plan = rebuild(r.info); } catch (err) {
      console.log(`  SKIP ${rel}: ${err.message}`);
      continue;
    }
    if (!plan) { console.log(`  SKIP ${rel}: nothing to change`); continue; }

    // Back up by session UUID only. NEVER let a Windows drive colon ("C:") or a
    // separator reach the name: fs writes like "dir/C:__Users__…" silently
    // become an NTFS alternate data stream on a file named "C" instead of a real
    // backup (observed 2026-09-16 — originals recovered only via ADS).
    const uuid = path.basename(path.dirname(r.file));
    const backupPath = path.join(backupDir, `${uuid}.jsonl.zstd`);
    fs.copyFileSync(r.file, backupPath);
    const expectedLines = r.info.lines.length;
    fs.writeFileSync(r.file, plan.bytes);

    // Re-validate the written file against both live assertions before accepting.
    const check = analyzeFile(r.file);
    const problems = [...structuralProblems(check), ...check.violations];
    if (check.lines.length !== expectedLines) {
      problems.push(`line count changed: ${expectedLines} -> ${check.lines.length}`);
    }
    if (problems.length > 0) {
      console.log(`  ✗ ${rel}: rewrite rejected (${problems.join('; ')}) — RESTORING BACKUP`);
      fs.copyFileSync(backupPath, r.file);
      continue;
    }
    const what = [
      plan.reframed ? `reframed ${plan.framesBefore}->${check.frames.length} frames` : 'frames preserved',
      plan.fixedEvents > 0 ? `patched ${plan.fixedEvents} event(s)` : 'no event patch needed',
    ].join(', ');
    console.log(`  ✓ ${rel}: ${what} (backup ${path.basename(backupPath)})`);
    fixedFiles += 1;
    fixedEvents += plan.fixedEvents;
    if (plan.reframed) reframed += 1;
  }
  console.log(`\nrepaired files  : ${fixedFiles}`);
  console.log(`reframed files  : ${reframed}`);
  console.log(`patched events  : ${fixedEvents}`);
  console.log(`backups at      : ${backupDir}`);
  process.exit(0);
}

main();
