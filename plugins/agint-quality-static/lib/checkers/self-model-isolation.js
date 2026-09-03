/**
 * lib/checkers/self-model-isolation.js — Sprint 13 v0.7.1 self-model-isolation 规则组
 *
 * 设计稿 Sprint13 §4.7（D2 哲学定位的静态强制：自我认知 ≠ 自我修改）：
 *   agint-self-model 是只读观察者，禁止借写路径 Service 或既有存储域越权。
 *
 * 两项 blocker：
 *   ① 写路径 Service 引用：扫描 agint-self-model 源码，禁止 import / inject /
 *      ctx.get / ctx.provide 引用 `agint.qualityPolicy` / `agint.mutator` /
 *      `agint.population`（元进化 / 变异 / 种群写路径）。
 *   ② 存储域越权：禁止写任何既有 `agint_*` 域（只能写独占域 `agint_self_model`）。
 *
 * 输入契约（对齐 l0-isolation）：
 *   checkSelfModelIsolation({ pluginDir, profile }) → Finding[]
 *
 * 作用范围：仅对 manifest.name === 'agint-self-model' 的插件生效；其余插件
 * 直接跳过（返回空数组），避免误伤既有的 mutator / population / quality 插件。
 *
 * L0-frozen 保护：本文件不含任何 FROZEN 契约完整字符串；仅引用 self-model 的
 * 独占域名常量（agint_self_model），不引用其他插件内部契约。
 *
 * 行数预算：单 checker ≤200 行。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectSourceFiles } from './scan-files.js';

const FAMILY = 'self-model-isolation';

/** 被禁的写路径 Service（D2：自我认知 ≠ 自我修改） */
export const FORBIDDEN_WRITE_SERVICES = Object.freeze([
  'agint.qualityPolicy',
  'agint.mutator',
  'agint.population',
]);

/** self-model 独占存储域（唯一允许写的目标） */
export const ALLOWED_SELF_MODEL_DOMAIN = 'agint_self_model';

/**
 * 入口：对 agint-self-model 插件做两项隔离检查。
 * @param {object} args
 * @param {string} args.pluginDir 插件根目录
 * @param {object} [args.profile] loadProfile 返回值（本 checker 不依赖 profile 字段）
 * @returns {Promise<Array<{family:string, severity:string, message:string, location?:string}>>}
 */
export async function checkSelfModelIsolation({ pluginDir, profile }) {
  const findings = [];
  if (!pluginDir) return findings;
  const dir = resolve(pluginDir);

  // 仅对 self-model 插件生效；其余插件跳过（不误伤）
  const manifest = readManifest(dir);
  const name = typeof manifest?.name === 'string' ? manifest.name : '';
  if (name !== 'agint-self-model') return findings;

  void profile; // 本 checker 不依赖 profile 动态配置

  findings.push(...checkWriteServiceReferences(dir));
  findings.push(...checkStorageDomainBoundary(dir));
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ①：写路径 Service 引用
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扫描源码，禁止引用被禁的写路径 Service。
 * 命中形式：ctx.get('agint.qualityPolicy') / ctx.inject(['agint.mutator']) /
 *   import ... from '...agint.population' / ctx.provide('agint.population.xxx') /
 *   以及任意源码字面量出现这些 token（防呆）。
 */
export function checkWriteServiceReferences(pluginDir) {
  const findings = [];
  const tokens = FORBIDDEN_WRITE_SERVICES;
  for (const file of collectSourceFiles(pluginDir)) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const token of tokens) {
        if (line.includes(token)) {
          findings.push({
            family: FAMILY, severity: 'blocker',
            message: `[write-service] references forbidden write-path service '${token}' (self-model is read-only observer; D2 forbids qualityPolicy/mutator/population writes)`,
            location: `${file}:${i + 1}`,
          });
        }
      }
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ②：存储域越权
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扫描源码，禁止写任何既有 `agint_*` 域（只能写独占域 agint_self_model）。
 * 命中形式：storageDomain.open({ name: 'agint_xxx' }) / defineDomain({ name: 'agint_xxx' })
 *   其中 agint_xxx !== 'agint_self_model'。
 */
export function checkStorageDomainBoundary(pluginDir) {
  const findings = [];
  const openPattern = /(?:storageDomain\.open|defineDomain)\s*\(\s*\{[^}]*?name\s*:\s*['"](agint_[a-z0-9_]+)['"]/g;
  for (const file of collectSourceFiles(pluginDir)) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = openPattern.exec(line);
      if (m) {
        const domain = m[1];
        if (domain !== ALLOWED_SELF_MODEL_DOMAIN) {
          findings.push({
            family: FAMILY, severity: 'blocker',
            message: `[storage-domain] writes non-allowed storage domain '${domain}' (self-model may only write '${ALLOWED_SELF_MODEL_DOMAIN}')`,
            location: `${file}:${i + 1}`,
          });
        }
      }
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function readManifest(pluginDir) {
  const p = resolve(pluginDir, 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  catch {
    return null;
  }
}
