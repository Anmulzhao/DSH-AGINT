/**
 * agint-synth-bad-deps: Sprint 11 故意违规测试 fixture
 * ==========================================================================
 *
 * ██  WARNING — INTENTIONALLY VIOLATING FIXTURE  ██
 * ██  警告 — 故意违规 fixture，仅供离线静态扫描使用  ██
 *
 * 本文件不是可挂载插件。它是 Sprint 11 §4.4 指定的"故意违规测试变异"，
 * 仅用于 S11-02（依赖白名单违规拒绝）的 e2e。
 *
 * 故意违反的 L0 隔离项（必须被 l0-isolation 规则组 100% 检出）：
 *
 *   1. 依赖白名单违规（【唯一】违规项）：
 *      - inject 字段填入 "agint.qualitySandbox"
 *      - 白名单 = { storageDomain, memory, metrics, cron }（设计稿 §4.4）
 *      - 违规依据：Sprint11-设计稿 §4.4 / ADR-11-4 第 3 条
 *        "禁止 require 其他 agint-quality-* 内部模块"
 *
 * 故意【不】触发的 L0 隔离项（保持 PASS，让拒绝路径精准定位）：
 *   - 签名兼容：Service 形态完整（provide + schemas + version）
 *   - 域隔离：使用全新 agint_synth_bad_deps 域（不撞既有）
 *
 * 红线（与 echo-tool 完全相同）：
 *   - 永不被 cordis.patch.yml 顶层挂载
 *   - 永不被 cordis_run / cordis_define 加载
 *   - 永不被 bin/safe-update.sh 引用
 *   - 永不进入 agint-population 锦标赛统计
 *   - 永不入 FROZEN 契约（即使 Service 形态对齐也不冒充契约实例）
 *
 * e2e 消费方式（给 codex-D / codex-B）：
 *   - 静态扫描 manifest.json：
 *     assert(manifest.spec.cordis.inject.includes('agint.qualitySandbox') === true)
 *     assert(manifest.spec.storage.domains.length === 0)               // 合规：留空
 *     assert(manifest.spec.cordis.provides.includes('agint.synth.badDeps')) // 合规：签名兼容
 *     assert(l0IsolationCheck(manifest).dependencyWhitelist === false)    // 单项拒绝
 *     assert(l0IsolationCheck(manifest).signatureDiff       === true)     // PASS
 *     assert(l0IsolationCheck(manifest).domainIsolation     === true)     // PASS
 *
 *   - 静态扫描 src/index.js（本文件）：
 *     assert(sourceContains(ctx.get('agint.qualitySandbox')) === true)    // AST 命中
 */

// ────────────────────────────────────────────────────────────────────────────
//  依赖导入（与 echo-tool 一致；这些是合规的 npm 依赖，违规在 inject 字段）
// ────────────────────────────────────────────────────────────────────────────

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
//  Cordis 插件元数据
//  - inject：故意包含 'agint.qualitySandbox'（不在白名单 {memory,metrics,cron}）
//    这是【主违规点】——codex-B 的 l0-isolation 必须能精确识别并拒绝
// ────────────────────────────────────────────────────────────────────────────

const name = 'agint-synth-bad-deps';

// ⚠️ 故意违规：注入白名单外的 service
const inject = ['storageDomain', 'agint.qualitySandbox'];

const Config = z.object({}).strict();

// ────────────────────────────────────────────────────────────────────────────
//  Service 形态：故意保持完整（provide + schemas + version）
//  这样 l0-isolation 的"签名兼容"项能 PASS，把拒绝精准定位到【依赖白名单】
//  和【域隔离】两项。如果签名也故意弄坏，会让三项混杂拒绝，e2e 难以定位。
// ────────────────────────────────────────────────────────────────────────────

const InputSchema = z.object({}).strict();
const OutputSchema = z.object({
  marker: z.literal('agint-synth-bad-deps-noop'),
  ts: z.string(),
}).strict();

// ────────────────────────────────────────────────────────────────────────────
//  存储域定义：使用全新 agint_synth_bad_deps 域（合规，不触发域隔离违规）
//  故意【只】保留"依赖白名单"单项违规，让 l0-isolation 拒绝路径精准定位
// ────────────────────────────────────────────────────────────────────────────

const spec = defineDomain({
  name: 'agint_synth_bad_deps',
  version: 1,
  tables: {
    marker: { valueSchema: OutputSchema },
  },
});

// ────────────────────────────────────────────────────────────────────────────
//  apply(ctx)：Cordis 插件主体
//  - 主动调用 ctx.get('agint.qualitySandbox')——故意访问白名单外 service
//  - domain 仍正常打开（让"域隔离"成为可观察的违规，而不是启动失败）
// ────────────────────────────────────────────────────────────────────────────

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
        void d.close().catch(() => {});
        return null;
      }
      domain = d;
      return d;
    },
    (error) => {
      domainError = error;
      return null;
    },
  );

  const table = async () => {
    if (disposed) throw new Error('agint-synth-bad-deps: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-synth-bad-deps: domain unavailable');
    return d.table('marker');
  };

  // ⚠️ 故意访问白名单外 service（这是 l0-isolation 静态扫描时能看到的
  // 标识符——codex-B 的 linter 应扫描 apply 函数体中的 ctx.get('agint.*') 调用）
  // 这里不实际依赖返回值：拿不到就拿不到，本 fixture 不做事
  const _forbiddenDep = ctx.get('agint.qualitySandbox');
  void _forbiddenDep;  // 占位，避免 lint 报 unused

  const agintSynthBadDeps = {
    version() {
      return {
        name: 'agint.synth.badDeps',
        version: '0.0.1',
        kind: 'synth',
        storageDomain: 'agint_synth_bad_deps',
        intentionallyViolating: ['dependency-whitelist'],
      };
    },

    schemas: {
      Input: InputSchema,
      Output: OutputSchema,
    },

    /**
     * doNothing() → noop
     * 这是一个占位 Service，本 fixture 的真实目的不在运行时行为，
     * 而在于它的 manifest + 源码在【静态扫描】时必须被识别为违规。
     */
    async doNothing() {
      const t = await table();
      const out = OutputSchema.parse({
        marker: 'agint-synth-bad-deps-noop',
        ts: new Date().toISOString(),
      });
      await t.put(out.ts, out);
      return { ...out };
    },
  };

  ctx.provide('agint.synth.badDeps', agintSynthBadDeps);
}

export { Config, apply, inject, name };