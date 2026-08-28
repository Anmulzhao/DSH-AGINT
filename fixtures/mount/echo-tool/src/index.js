/**
 * agint-synth-echo: Sprint 11 合规测试 fixture（最小 Cordis 插件包）
 * ==========================================================================
 *
 * 【本文件的特殊身份】
 *   这不是可挂载到 dsh runtime 的真实插件。它是 Sprint 11 §4.4 设计稿指定的
 *   "人工白名单测试变异 (compliant fixture)"，仅用于：
 *     - S11-01 快乐路径：合规 TOOL_SYNTHESIS 变异走完 static → sandbox → mount
 *     - S11-08 同名插件重复挂载：幂等拒绝
 *
 *   它**绝不**被加载到 dsh runtime：
 *     - 不被 cordis.patch.yml 顶层挂载
 *     - 不被 cordis_define / cordis_run / cordis_inspect_self 加载
 *     - 不进入 agint-population 的真实锦标赛统计
 *
 *   e2e 工具通过【静态扫描】消费它：
 *     - fs.readFileSync('./fixtures/mount/echo-tool/manifest.json') + JSON.parse
 *     - fs.readFileSync('./fixtures/mount/echo-tool/cordis.patch.yml') + yaml.parse
 *     - fs.readFileSync('./fixtures/mount/echo-tool/src/index.js') + 正则/词法扫描
 *
 * 【与 FROZEN 契约的兼容性】
 *   本 fixture 提供 `agint.synth.echo` Service（命名空间 `agint.synth.*`，
 *   与 agint_synth_* 存储域前缀语义对齐）。它的形态约定：
 *     - 单一 agint.* 命名空间入口（FROZEN：与 agint.quality 一致）
 *     - 暴露 schemas（Input / Output）字段（FROZEN：与 agint.quality.schemas 一致）
 *     - 暴露 version() 元信息（FROZEN：与 QualityEvaluatorIface.version 字段一致）
 *     - **不实现** FROZEN 方法体（getConfig / setConfig / validatePatch 等）——
 *       避免误以为它是契约实例；它只是【形态对齐】的合规 fixture
 *
 * 【L0 隔离三项检查的合规证据】
 *   1. 签名兼容：Service 形态（provide + schemas + version）= 0 差异（与 FROZEN）
 *   2. 域隔离：存储域 = `agint_synth_echo`（全新 `agint_synth_*` 前缀，不撞 agint_meta）
 *   3. 依赖白名单：inject = ['storageDomain']（仅 dsh runtime 注入；零 agint.* 依赖）
 *
 * Row (loader 形态，e2e 离线读取用):
 *   - insert:
 *       - id: agint-synth-echo
 *         name: ./fixtures/mount/echo-tool/src/index.js
 *         config: {}
 */

// ────────────────────────────────────────────────────────────────────────────
//  依赖导入：与既有 agint-* 插件一致（zod 校验 + dsh-storage-domain 域定义）
// ────────────────────────────────────────────────────────────────────────────

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
//  Cordis 插件元数据：name / inject / Config
//  - name：与 cordis.patch.yml 的 `id:` 字段对齐（loader 用 id 索引）
//  - inject：硬依赖 dsh runtime 注入的 storageDomain Service
//           注意：这里**不**require 任何 agint.* host service（连白名单内的
//                memory/metrics/cron 都不注入）——echo 是最小自洽的 fixture，
//                "零外部依赖"本身也是白名单合规的强证据
// ────────────────────────────────────────────────────────────────────────────

const name = 'agint-synth-echo';
const inject = ['storageDomain'];

/**
 * Config schema：本 fixture 不需要任何 config，但导出 zod 占位（与既有
 * 插件惯例对齐，让 plugin-check.sh 不会因 missing Config 而误报）。
 */
const Config = z.object({}).strict();

// ────────────────────────────────────────────────────────────────────────────
//  FROZEN 形态对齐：schemas 字段
//  - FROZEN 契约（agint.quality）暴露 schemas.EvalTarget / EvalResult 等
//  - 本 fixture 暴露 schemas.Input / Output —— 形态对齐但**不**复用 FROZEN 名字
//    （避免 e2e 误以为这是契约实例）
// ────────────────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  text: z.string().min(1).max(1024),
}).strict();

const OutputSchema = z.object({
  text: z.string(),
  ts: z.string(),
  instanceId: z.string(),
}).strict();

// ────────────────────────────────────────────────────────────────────────────
//  存储域定义：全新 agint_synth_echo（符合 L0 域隔离要求：agint_synth_* 前缀）
//  - 1 张表 echo（key=echoId, value={text, ts, instanceId}）
//  - schemaVersion=1（首版；任何破环性变更需 +1）
//  - atomic="json"：单 key put/delete（不并发 append；echo 是离散记录）
// ────────────────────────────────────────────────────────────────────────────

const spec = defineDomain({
  name: 'agint_synth_echo',
  version: 1,
  tables: {
    echo: { valueSchema: OutputSchema },
  },
});

// ────────────────────────────────────────────────────────────────────────────
//  apply(ctx)：Cordis 插件主体
//  - 注册顺序：effect(dispose) → storageDomain.open → provide
//  - 关闭路径：disposed=true 后再 resolve 的 domain 被立刻 close（K8 模式）
//  - lifecycle 维度：零 setInterval / 零 ctx.on(...) / 零 tools 注册
//    所以"intervals/listeners/tools"三栏都是 "none"，disposer 只关 domain
// ────────────────────────────────────────────────────────────────────────────

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  // ctx.effect 语义：回调立即执行；返回值是 disposer（fiber dispose 时调用）
  // 这里 disposer 仅关闭已打开的 domain（如果还没打开就什么都不做）
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

  // 取 table 的统一入口：disposed / domainError / ready 都包好
  const table = async () => {
    if (disposed) throw new Error('agint-synth-echo: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-synth-echo: domain unavailable');
    return d.table('echo');
  };

  const randomId = () => {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };

  // ──────────────────────────────────────────────────────────────────────
  //  FROZEN 形态对齐：version() 方法（提供插件元信息）
  //  - 与 QualityEvaluatorIface.version 字段形态一致
  //  - kind='synth' 标识这是合成（synthesized）产物，与真实插件区分
  // ──────────────────────────────────────────────────────────────────────

  const agintSynthEcho = {
    version() {
      return {
        name: 'agint.synth.echo',
        version: '0.0.1',
        kind: 'synth',
        storageDomain: 'agint_synth_echo',
      };
    },

    // FROZEN 形态对齐：schemas 字段（与 agint.quality.schemas 命名一致）
    schemas: {
      Input: InputSchema,
      Output: OutputSchema,
    },

    /**
     * echo(input) → output
     * - 校验 input → 写 echo 表（持久化到 agint_synth_echo 域）
     * - 返回 output（含 ts 与 instanceId）
     *
     * 这是一个最小可验证 Service：e2e 可以用它证明"挂载后的产物
     * 能被同进程其他 Service 通过 ctx.get('agint.synth.echo') 调到"。
     */
    async echo(input) {
      const parsed = InputSchema.parse(input);
      const t = await table();
      const out = OutputSchema.parse({
        text: parsed.text,
        ts: new Date().toISOString(),
        instanceId: randomId(),
      });
      await t.put(out.instanceId, out);
      return { ...out };
    },

    /**
     * list() → 读所有 echo 记录（仅限测试 fixture 用，给 S11-01 验证
     * 挂载后的产物能正常读写自己的域）
     */
    async list() {
      const t = await table();
      const out = [];
      for (const [id, rec] of t.entries()) {
        out.push({ id, ...rec });
      }
      out.sort((a, b) => a.ts.localeCompare(b.ts));
      return out;
    },
  };

  ctx.provide('agint.synth.echo', agintSynthEcho);
}

export { Config, apply, inject, name };