/**
 * lib/synth.js — TOOL_SYNTHESIS 合成器（骨架 + stubs）
 *
 * **2026-10-25 老板拍板**：移除原 ADR-11-2 的两条约束
 *   ——「必须模板生成」「禁止自由生成任意代码」。方法体来自 payload 的 stubs，
 *   生成方式不受限。
 *
 * 骨架仍然固定（改本文件前先读，每条都有测试钉着）：
 *   1. **骨架**：import / name / inject / 存储域定义 / apply 收尾固定。
 *      这是产物能被 dsh 加载的最低形态，不是内容约束。
 *   2. **命名**：服务键落 `agint.synth.*`、存储域落 `agint_synth_*`、
 *      插件 id 落 `agint-synth-*`。命中保留词一律拒（避免撞 L0 FROZEN 签名空间）。
 *   3. ⛔ **方法体内容不审查**：stubs 原样拼进 service 对象。
 *      内容引入的 import / 域名 / 权限由**下游 quality-static 与 quality-sandbox 真拦**。
 *      前置约束移除后，它们是唯一防线 —— 本模块不做静态审查，也不要在这里补。
 *
 * 纯函数 + 可注入 fs：本模块**不落盘**，只返回文件清单。落盘是调用方的事。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolSynthesisPayloadSchema } from './schema.js';

export const SYNTH_TEMPLATE_VERSION = '1';

/**
 * 保留词：toolName 命中任一项 ⇒ 拒绝。
 * 理由：这些词属于既有插件/契约的签名空间，合成产物撞上去会直接违反
 * l0-isolation 的 signatureCompatibility 子项。前置拦截比事后门禁更省钱，
 * 且能给出明确 reason。
 */
export const RESERVED_TOOL_WORDS = Object.freeze([
  'quality', 'mutator', 'population', 'mount', 'abtest', 'sandbox', 'static',
  'eval', 'report', 'policy', 'curriculum', 'diagnosis', 'dream', 'evolve',
  'evolution', 'memory', 'metrics', 'cron', 'synth', 'meta', 'contract',
]);

const DOMAIN_RE = /^agint_synth_[a-z][a-z0-9_]*$/;
const SERVICE_KEY_RE = /^agint\.synth\.[a-z][a-z0-9-]+$/;
const PLUGIN_ID_RE = /^agint-synth-[a-z][a-z0-9-]+$/;
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

const TEMPLATE_FILES = Object.freeze([
  { tpl: 'manifest.json.tpl', out: 'manifest.json' },
  { tpl: 'package.json.tpl', out: 'package.json' },
  { tpl: 'cordis.patch.yml.tpl', out: 'cordis.patch.yml' },
  // ⛔ 产物源码必须在 lib/ 下：agint-quality-static 的 collectSourceFiles 只扫
  //    pluginDir/lib/** 与根 index.js。放 src/ 会让 dependencyWhitelist 子检查
  //    扫到 0 个文件 ⇒ 该子检查对产物形同虚设（实测 2026-10-25）。
  //    AGINT 全仓插件也都是 lib/index.js，产物形态跟全仓保持一致。
  { tpl: 'lib/index.js.tpl', out: 'lib/index.js' },
  { tpl: 'README.md.tpl', out: 'README.md' },
]);

/**
 * 由 toolName 派生全部产物标识符。纯函数，绝不抛。
 * @returns {{toolName:string, pluginId:string, serviceKey:string, domain:string, table:string}}
 */
export function deriveSynthNames(toolName) {
  const snake = String(toolName ?? '').replace(/-/g, '_');
  return {
    toolName: String(toolName ?? ''),
    pluginId: `agint-synth-${toolName}`,
    serviceKey: `agint.synth.${toolName}`,
    domain: `agint_synth_${snake}`,
    table: snake,
  };
}

/**
 * 净化进 JSON 字符串值的文本：去换行 + 转义 JSON 特殊字符。
 * 防止 intent 里的引号/换行把 manifest.json 撑坏（注入面 = 产物字节）。
 */
export function sanitizeForJsonString(input) {
  return String(input ?? '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
}

/**
 * 净化进块注释的文本：去掉会提前闭合块注释的结束序列（星号紧跟斜杠），换行压成空格。
 *
 * ⛔ 本文件任何注释里都**不许写出那个结束序列的字面量**——写了就把本注释提前闭合，
 *    后面的文本变成代码，整个文件语法崩掉（2026-10-25 实测，报的错会漂到几十行之外）。
 */
export function sanitizeForBlockComment(input) {
  return String(input ?? '')
    .replace(/\*\//g, '')
    .replace(/\r\n|\r|\n/g, ' ')
    .trim();
}

/**
 * 占位替换。只认 {{VAR}} 形态，未提供的变量保持原样（便于测试发现漏替）。
 */
export function renderTemplate(text, vars) {
  return String(text ?? '').replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  ));
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * 从一条 TOOL_SYNTHESIS proposal 合成插件包。
 *
 * 这是「PROPOSERS.TOOL_SYNTHESIS ⇒ 合成器」的接线点（B2）。
 * 只吃 kind === 'TOOL_SYNTHESIS' 的 proposal，其它 kind 一律拒
 * —— 避免把 PROMPT_MUTATION 的 payload 喂进合成器产出垃圾。
 *
 * ⛔ 不修改也不扩展 FROZEN MutationProposalSchema：proposal 只被读取。
 *
 * @param {object} proposal  FROZEN MutationProposal 行
 * @returns 同 synthPluginPackage
 */
export function synthForProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return fail('NO_PROPOSAL', 'proposal 缺失');
  }
  if (proposal.kind !== 'TOOL_SYNTHESIS') {
    return fail('NOT_TOOL_SYNTHESIS', `kind='${proposal.kind}' 不是 TOOL_SYNTHESIS，合成器不吃它`);
  }
  return synthPluginPackage({ payload: proposal.payload });
}

/**
 * 合成一个完整 Cordis 插件包（不落盘）。
 *
 * @param {object} args
 * @param {object} args.payload   TOOL_SYNTHESIS payload（先过 FROZEN 契约）
 * @param {object} [args.fs]      可注入 fs（测试用；默认只读 node:fs）
 * @param {string} [args.templatesDir] 模板目录（默认本文件旁 templates/plugin-synth）
 * @returns {{ok:true, files:Array<{path:string,content:string}>, meta:object} | {ok:false, code:string, reason:string}}
 */
export function synthPluginPackage({ payload, fs, templatesDir } = {}) {
  const parsed = ToolSynthesisPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues?.[0];
    return fail('INVALID_PAYLOAD', `payload 未过 ToolSynthesisPayloadSchema：${first?.message ?? 'unknown'}`);
  }
  const { toolName, signature, stubs, intent } = parsed.data;

  for (const word of RESERVED_TOOL_WORDS) {
    if (toolName === word || toolName.includes(`-${word}`) || toolName.includes(`${word}-`)) {
      return fail('RESERVED_TOOL_NAME', `toolName 命中保留词「${word}」，会撞 L0 FROZEN 签名空间`);
    }
  }

  const names = deriveSynthNames(toolName);
  if (!DOMAIN_RE.test(names.domain)) return fail('BAD_DOMAIN', `派生存储域非法：${names.domain}`);
  if (!SERVICE_KEY_RE.test(names.serviceKey)) return fail('BAD_SERVICE_KEY', `派生服务键非法：${names.serviceKey}`);
  if (!PLUGIN_ID_RE.test(names.pluginId)) return fail('BAD_PLUGIN_ID', `派生插件 id 非法：${names.pluginId}`);
  if (!TABLE_RE.test(names.table)) return fail('BAD_TABLE', `派生表名非法：${names.table}`);

  const defaultDir = fileURLToPath(new URL('../templates/plugin-synth/', import.meta.url));
  const dir = templatesDir ?? defaultDir;
  const io = fs ?? { readFileSync };

  const files = [];
  for (const spec of TEMPLATE_FILES) {
    let raw;
    try {
      raw = io.readFileSync(`${dir}${spec.tpl}`, 'utf8');
    } catch (error) {
      return fail('TEMPLATE_UNREADABLE', `模板缺失或不可读：${spec.tpl}（${error?.message ?? ''}）`);
    }
    files.push({
      path: spec.out,
      content: renderTemplate(raw, {
        PLUGIN_ID: names.pluginId,
        SERVICE_KEY: names.serviceKey,
        DOMAIN: names.domain,
        TABLE: names.table,
        TOOL_NAME: toolName,
        VERSION: '0.0.1',
        INTENT: sanitizeForBlockComment(intent),
        SIGNATURE: sanitizeForBlockComment(signature),
        INTENT_JSON: sanitizeForJsonString(intent),
        SIGNATURE_JSON: sanitizeForJsonString(signature),
        STUBS: stubs.map((s, i) => `${i + 1}. ${String(s).trim()}`).join('\n'),
        // 方法体 = stubs 原样（保留换行与语法），不净化、不审查。
        METHODS: stubs.map((s) => String(s).trim()).join('\n\n'),
      }),
    });
  }

  return {
    ok: true,
    files,
    meta: {
      ...names,
      skeletonVersion: SYNTH_TEMPLATE_VERSION,
      codegen: 'skeleton + stubs',
      methodSource: 'stubs',
      staticReview: 'downstream-only',
    },
  };
}
