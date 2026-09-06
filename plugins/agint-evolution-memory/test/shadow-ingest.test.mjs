/**
 * agint-evolution-memory: bus 影子订阅写入契约（回归防线）
 *
 * 背景（fix-20260907 / 提案 f9d8550b）：
 *   影子订阅 handler 曾往 logPhase4Buffered 传 decision='PROPOSED' 与
 *   targetKind='evolution.proposed:*'，两者都不在 evolutionLogEntrySchema 的枚举里
 *   ⇒ zod parse 必抛 ⇒ 被空 catch 吞掉。
 *   表象极具欺骗性：订阅注册成功、bus 返回 deliveredTo 包含本插件，
 *   看起来链路完全正常，但 evolution_log 永远 0 条。
 *
 * 本测试用**纯静态扫描**锁死这条契约（不依赖 zod / storage-domain，
 * 因此在无 node_modules 的仓库侧也能直接跑），确保：
 *   1. handler 写入的 decision / targetKind 必须落在 schema 枚举内
 *   2. handler 不得出现空 catch（静默失败反模式）
 *   3. 影子订阅必须保留事件原始语义（origin / kind / stage 进 tags）
 *
 * Run: node --test plugins/agint-evolution-memory/test/shadow-ingest.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const schemaSrc = readFileSync(join(here, '..', 'lib', 'schema.js'), 'utf8');
const indexSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');

/** 从 schema.js 里抽出 `key: z.enum([...])` 的枚举值 */
function extractEnum(src, key) {
  const re = new RegExp(`${key}\\s*:\\s*z\\.enum\\(\\[([^\\]]+)\\]`);
  const m = src.match(re);
  if (!m) throw new Error(`schema.js 未找到 ${key} 的 z.enum 定义`);
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** 抽出影子订阅 handler 里 logPhase4Buffered({ ... }) 的调用片段 */
function extractHandlerCall(src) {
  const start = src.indexOf('await logPhase4Buffered({');
  assert.notEqual(start, -1, 'index.js 应存在 logPhase4Buffered 调用（影子订阅写入点）');
  const end = src.indexOf('});', start);
  return src.slice(start, end);
}

const DECISION_ENUM = extractEnum(schemaSrc, 'decision');
const TARGETKIND_ENUM = extractEnum(schemaSrc, 'targetKind');

test('schema 枚举可被解析（防止本测试自己失真）', () => {
  assert.ok(DECISION_ENUM.length >= 4, `decision 枚举应至少 4 项，实得 ${DECISION_ENUM.length}`);
  assert.ok(TARGETKIND_ENUM.length >= 4, `targetKind 枚举应至少 4 项，实得 ${TARGETKIND_ENUM.length}`);
});

test('回归：影子写入的 decision 必须落在 schema 枚举内', () => {
  const call = extractHandlerCall(indexSrc);
  const m = call.match(/decision\s*:\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'handler 必须显式传 decision');
  assert.ok(
    DECISION_ENUM.includes(m[1]),
    `decision='${m[1]}' 不在 schema 枚举 ${JSON.stringify(DECISION_ENUM)} 内 —— ` +
    '这会让 zod 拒绝写入并被 catch 吞掉，evolution_log 永远 0 条',
  );
});

test('回归：影子写入的 targetKind 必须落在 schema 枚举内', () => {
  const call = extractHandlerCall(indexSrc);
  const m = call.match(/targetKind\s*:\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'handler 必须显式传 targetKind');
  assert.ok(
    TARGETKIND_ENUM.includes(m[1]),
    `targetKind='${m[1]}' 不在 schema 枚举 ${JSON.stringify(TARGETKIND_ENUM)} 内`,
  );
});

test('回归：提案阶段语义不得丢失（origin / kind / stage 进 tags）', () => {
  const call = extractHandlerCall(indexSrc);
  assert.match(call, /origin:/, 'tags 必须保留 origin（事件来源）');
  assert.match(call, /kind:/, 'tags 必须保留 kind（事件子类型）');
  assert.match(call, /stage:proposed/, 'tags 必须标注 stage:proposed，便于与 Phase 4 决策区分');
});

test('回归：影子订阅不得静默吞错（禁止空 catch 块）', () => {
  // 只看 handler 函数体（unsubscribe 清理用的空 catch 不在检查范围：dispose 阶段合理）
  const start = indexSrc.indexOf('async (envelope) =>');
  assert.notEqual(start, -1, '应存在 evolution.proposed 的 handler');
  const end = indexSrc.indexOf('\n      );', start);
  const block = indexSrc.slice(start, end === -1 ? indexSrc.length : end);
  // 空 catch：catch { } / catch (e) { } / catch { /* 只有注释 */ }
  const emptyCatch = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/;
  assert.equal(
    emptyCatch.test(block),
    false,
    '影子订阅段不得出现空 catch —— 失败必须 logger.warn 暴露（哲学：失败要暴露，不要静默）',
  );
});

test('回归：订阅取 bus 时兼容子键与 namespace 两种形态', () => {
  assert.match(indexSrc, /ctx\.get\('agint\.eventBus\.subscribe'\)/, '应先查子键（sibling 范本）');
  assert.match(indexSrc, /ctx\.get\('agint\.eventBus'\)/, '应回退查 namespace（少数 host 变体）');
});
