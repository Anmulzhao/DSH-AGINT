// 规则提取器单测（Q1 / 设计稿 §1.3）：三类启发式 + 上限 + 去重 + 偏移量。

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractInsights, mapToMemoryType } from '../lib/extractors.js';

test('decision：拍板/采纳/否决句命中，带 rawOffset', () => {
  const text = '今天没有重要的事。老板拍板：P3-1 采用 B 档接线，否决 A 档替换方案。明天继续写代码。';
  const out = extractInsights(text);
  const decisions = out.filter((i) => i.type === 'decision');
  assert.ok(decisions.length >= 1, `应命中 decision，实际 ${JSON.stringify(out)}`);
  const d = decisions[0];
  assert.ok(d.content.includes('拍板'));
  // rawOffset 可回溯：切片必须还原原句
  assert.equal(text.slice(d.rawOffset.start, d.rawOffset.end), d.content);
});

test('preference：红线/不要 句命中 → 类型 preference（retention 由 engine 置 highRetention）', () => {
  const text = '日常记录一笔。不要在没有 audit 时改 cron 时间，这是红线。天气不错。';
  const out = extractInsights(text);
  const prefs = out.filter((i) => i.type === 'preference');
  assert.ok(prefs.length >= 1);
  assert.ok(prefs[0].content.includes('红线') || prefs[0].content.includes('不要'));
});

test('fact：版本号/端口 + 稳定性词命中；纯数字无稳定性词不命中', () => {
  const text = '当前宿主版本是 0.1.5，web 端口 3080。今天走了 12000 步。';
  const out = extractInsights(text);
  const facts = out.filter((i) => i.type === 'fact');
  assert.ok(facts.length >= 1);
  assert.ok(facts.every((f) => /(版本|端口|路径|阈值|默认|配置|上限|下限|安装位|目录)/.test(f.content)),
    'fact 必须同时命中数值形态 + 稳定性词');
});

test('优先级：preference > decision > fact（一句同含多类词归 preference）', () => {
  const text = '老板拍板了红线：以后一律不要用 rm -rf 删个人目录。';
  const out = extractInsights(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'preference');
});

test('max 上限：maxInsightsPerCompress 生效（防提取风暴）', () => {
  const text = Array.from({ length: 30 }, (_, i) => `老板拍板第${i}号决策：采纳方案${i}。`).join('');
  const out = extractInsights(text, { max: 5 });
  assert.equal(out.length, 5);
});

test('默认上限 = LIMITS.MAX_INSIGHTS_PER_COMPRESS（20）', async () => {
  const { LIMITS } = await import('../lib/schema.js');
  const text = Array.from({ length: 40 }, (_, i) => `老板拍板第${i}号决策：采纳方案${i}。`).join('');
  const out = extractInsights(text);
  assert.equal(out.length, LIMITS.MAX_INSIGHTS_PER_COMPRESS);
});

test('去重：同句重复出现只出一条', () => {
  const text = '老板拍板：采用方案 A。老板拍板：采用方案 A。';
  const out = extractInsights(text);
  assert.equal(out.filter((i) => i.content.includes('方案 A')).length, 1);
});

test('messages 输入：拼接后提取，角色前缀保留', () => {
  const messages = [
    { role: 'user', content: '宿主版本升级到 0.1.5，安装位在 C:\\DSH 目录。' },
    { role: 'assistant', content: '好的，已记录。' },
  ];
  const out = extractInsights(messages);
  assert.ok(out.some((i) => i.type === 'fact' && i.content.includes('0.1.5')));
});

test('空输入 / 无命中：返回空数组（不编造）', () => {
  assert.deepEqual(extractInsights(''), []);
  assert.deepEqual(extractInsights('今天天气不错，出去散步了。'), []);
  assert.deepEqual(extractInsights([]), []);
  assert.deepEqual(extractInsights(null), []);
});

test('mapToMemoryType：洞察类型 → agint-memory 类型域', () => {
  assert.equal(mapToMemoryType('decision'), 'decision');
  assert.equal(mapToMemoryType('preference'), 'preference');
  assert.equal(mapToMemoryType('fact'), 'lesson');
  assert.equal(mapToMemoryType('unknown'), 'pattern');
});
