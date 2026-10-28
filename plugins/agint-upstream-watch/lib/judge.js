/**
 * agint-upstream-watch — 段 2：LLM 判读（产结论，可失败）。
 *
 * ## 三条硬规矩
 *
 * 1. **不降级**（v0.14.0 全族原则）：模型失败/超时/输出不合 schema ⇒ 返回 `failed`，
 *    ⛔ 绝不拿关键词打分冒充判读结论。事实（段 1）照常落库，只是没有结论。
 * 2. **不编造**：prompt 把 `facts` 作为唯一事实源，并明确禁止提到 facts 之外的 API 变化。
 *    这条防的是「模型凭对 changelog 措辞的印象补脑」—— 2026-10-28 的现场教训是
 *    「需迁移 tools.resolve」这句措辞会让人（和模型）得出「AGINT 要大改」，
 *    而实测 140 处调用零改动。
 * 3. **`agentPreset` 必传**（K114）：缺它 child 是空壳 —— 会话照建、label 照写、
 *    全程不报错，但一步都跑不动。类型上可选，对 host plane 凭空 create 的临时 parent 等于必填。
 */

import { randomUUID } from 'node:crypto';

/** 默认模型参数，与 agint-dream 保持一致（同一宿主、同一套 settings.yaml） */
export const DEFAULT_PROVIDER = 'minimax-cn';
export const DEFAULT_MODEL = 'MiniMax-M3.1-Flash';
export const DEFAULT_REASONING_EFFORT = 'high';
export const DEFAULT_AGENT_PRESET = 'agint';
export const DEFAULT_TIMEOUT_MS = 90_000;

const SYSTEM_PROMPT = `你是「智进」(AGINT) 的上游判读器。AGINT 是一个跑在 DeepSeek Harness (dsh) 上的
自进化系统。dsh 是你的宿主，它频繁发版，破坏性变更会决定 AGINT 能不能装、装上了功能全不全。

你收到的是一份**机器实测出来的事实清单**（facts），不是 changelog 的转述。
这些事实由确定性代码产出：版本语义比较、release 正文条目统计、以及最重要的——
真正把上游 npm 包拉下来比对类型定义后得到的「AGINT 用到的导出有没有被删/被收窄」。

## 你必须遵守的规则

1. **只能引用 facts 里存在的信息**。facts 里没有的 API 变化、文件、数字，一律不许出现。
   如果你觉得「按经验应该还有某处变化」，不要写 —— 那是幻觉。
2. **区分「API 变了」和「AGINT 受影响」**。facts 里每个依赖包的 \`usedImpact\` 字段已经做了这个区分：
   - \`breaking\`：AGINT 真的用到的符号被删或被收窄 —— 这是必须处理的缺口
   - \`elsewhere\`：这个包的 API 有删除，但都不在 AGINT 的使用面上 —— 与 AGINT 无关
   - \`additive\` / \`compatible\`：不构成风险
   把 \`elsewhere\` 写成风险是错的。
3. \`verdict\` 四选一，语义严格：
   - \`no-impact\`：facts 显示没有任何需要 AGINT 动手的地方
   - \`opportunity\`：上游新增的能力，AGINT 可以用它改进自己（不是修 bug）
   - \`gap\`：AGINT 现在的能力与上游脱节，需要补（例如上游提供的能力 AGINT 还在自己实现）
   - \`risk\`：AGINT 用到的 API 被删/收窄，或者有硬性运行环境要求变化（Node 版本等）
4. \`proposals\` 可以为空数组。**宁可空，不要凑数** —— 一条没价值的提案会消耗人的注意力，
   比少提一条贵得多。每条提案必须能指向 facts 里的具体条目。
5. \`headline\` 一句话，不超过 80 字，**结论先行**，不要复述 facts。
6. \`rationale\` 要引用 facts 里的具体数字或条目，不超过 400 字。

## 背景：AGINT 与 dsh 的依赖面

AGINT 只 import 三个上游包：\`@deepseek-ai/dsh-tools\`（工具注册：defineTool）、
\`@deepseek-ai/dsh-storage-domain\`（存储域：defineDomain）、\`@deepseek-ai/dsh-schedule\`（排期）。
它不碰 dsh 安装目录，也不能自己升级宿主 —— 所以「升级 dsh」本身永远是人的动作。`;

/** 输出 schema：字段少而硬，便于下游直接落库 */
export const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'headline', 'rationale', 'proposals'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['no-impact', 'opportunity', 'gap', 'risk'],
      description: '整体判定',
    },
    confidence: {
      type: 'number',
      description: '0..1，对自己判断的置信度。事实不足以判断时给低分，不要硬凑高分',
    },
    headline: {
      type: 'string',
      description: '一句话结论，≤80 字，结论先行',
    },
    rationale: {
      type: 'string',
      description: '依据，必须引用 facts 里的具体数字或条目，≤400 字',
    },
    proposals: {
      type: 'array',
      description: '0..3 条提案；没有值得做的时候就给空数组',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'category'],
        properties: {
          title: { type: 'string', description: '提案标题，≤60 字' },
          body: { type: 'string', description: '正文：要改什么、为什么、怎么验收，≤1200 字' },
          category: {
            type: 'string',
            enum: ['rule', 'skill', 'doc', 'preset', 'service', 'plugin', 'other'],
            description: '与 agint-evolve 的 category 一致',
          },
        },
      },
    },
  },
};

/** 把 facts 压缩成 prompt 里能放得下的形态（去掉长数组，留关键计数与证据） */
function condenseFacts(facts) {
  return {
    tag: facts.tag,
    targetVersion: facts.targetVersion,
    installedVersion: facts.installedVersion,
    agintTestedVersion: facts.agintTestedVersion,
    level: facts.level,
    preStageChange: facts.preStageChange,
    versionTracks: facts.versionTracks,
    body: {
      entryCount: facts.body.entryCount,
      tagCounts: facts.body.tagCounts,
      breakingHits: facts.body.breakingHits,
      breakingSamples: facts.body.breakingSamples,
    },
    impactSummary: facts.impactSummary,
    depFace: facts.depFace.map((d) => ({
      pkg: d.pkg,
      from: d.from,
      to: d.to,
      verdict: d.verdict,
      usedImpact: d.usedImpact,
      usedCount: d.usedCount,
      removedCount: d.removedCount,
      narrowedCount: d.narrowedCount,
      addedCount: d.addedCount,
      usedRemoved: d.usedRemoved,
      baselineSuspect: d.baselineSuspect,
      evidence: d.evidence,
    })),
  };
}

function buildPrompt(facts) {
  return [
    `## 待判读的发行版本：${facts.tag}`,
    '',
    '## 机器实测事实（唯一事实源）',
    '```json',
    JSON.stringify(condenseFacts(facts), null, 2),
    '```',
    '',
    '请按规则输出判定。记住：`usedImpact=elsewhere` 不是风险；没有值得做的事就给空 proposals。',
  ].join('\n');
}

/**
 * 调模型做判读。
 *
 * @returns {Promise<{ok:boolean, mode:string, verdict?:object, reason?:string}>}
 *   ⛔ 失败时**不带** verdict —— 调用方据此决定「只落事实、不落结论」。
 */
export async function judgeFacts(ctx, facts, opts = {}) {
  const {
    provider = DEFAULT_PROVIDER,
    model = DEFAULT_MODEL,
    reasoningEffort = DEFAULT_REASONING_EFFORT,
    agentPreset = DEFAULT_AGENT_PRESET,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = () => {},
  } = opts;

  if (!ctx || typeof ctx.get !== 'function') {
    return { ok: false, mode: 'failed', reason: 'ctx unavailable' };
  }

  // 1. 服务可解析性（失败即 failed，不回退启发式）
  const agents = ctx.get('agents');
  const subagents = ctx.get('subagents');
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, mode: 'failed', reason: 'agents service unavailable' };
  }
  if (!subagents || typeof subagents.startActivation !== 'function') {
    return { ok: false, mode: 'failed', reason: 'subagents.startActivation unavailable' };
  }

  const abort = new AbortController();
  let rejectTimeout = null;
  const timeoutGuard = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    abort.abort('upstream-watch-timeout');
    rejectTimeout?.(new Error(`judge timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  // unref：不能让一个卡住的判读拖着进程不退出
  if (typeof timer.unref === 'function') timer.unref();

  let activation = null;
  let parentHandle = null;
  const disposeLate = (r) => { try { Promise.resolve(r?.dispose?.()).catch(() => {}); } catch { /* ignore */ } };

  try {
    parentHandle = await Promise.race([
      Promise.resolve().then(() => agents.create({
        sessionId: `upstream-watch-${facts.targetVersion}-${randomUUID().slice(0, 8)}`,
        // cwd 必给：child session 继承的 persona 段里 {{cwd}} 取不到值会直接 throw
        meta: { cwd: process.cwd(), origin: 'subagent', agentPreset },
        agentOptions: { provider, model, reasoningEffort },
        signal: abort.signal,
      })),
      timeoutGuard,
    ]);

    const startPromise = Promise.resolve().then(() => subagents.startActivation({
      provider: 'spawn',
      label: `agint-upstream-watch ${facts.tag}`,
      request: {
        parent: parentHandle.agent,
        prompt: [{ type: 'text', text: `${SYSTEM_PROMPT}\n\n${buildPrompt(facts)}` }],
        agentPreset,
        agentOptions: { provider, model, reasoningEffort },
        outputSchema: JUDGE_OUTPUT_SCHEMA,
      },
      signal: abort.signal,
      delivery: 'caller',
    }));
    startPromise.catch(() => { /* 超时胜出后 start 仍会晚到落地，吞掉它的 rejection */ });

    activation = await Promise.race([startPromise, timeoutGuard]);
    const result = await Promise.race([activation.result, timeoutGuard]);

    if (result?.stopReason !== 'completed') {
      const out = Array.isArray(result?.output) ? result.output : [];
      return {
        ok: false, mode: 'failed',
        reason: `stopReason=${result?.stopReason ?? 'unknown'} output=${JSON.stringify(out).slice(0, 300)}`,
      };
    }

    const parsed = extractJson(result.output);
    if (!parsed) {
      return { ok: false, mode: 'failed', reason: 'model output is not valid JSON' };
    }

    const invalid = validateVerdict(parsed);
    if (invalid) {
      return { ok: false, mode: 'failed', reason: `schema violation: ${invalid}` };
    }

    log(`judge ok: ${parsed.verdict} conf=${parsed.confidence} proposals=${parsed.proposals.length}`);
    return { ok: true, mode: 'judged', verdict: parsed };
  } catch (e) {
    return { ok: false, mode: 'failed', reason: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
    if (activation) disposeLate(activation);
    if (parentHandle) disposeLate(parentHandle);
  }
}

/** 从模型输出里抠 JSON（可能被 ```json 包裹，也可能直接是对象） */
export function extractJson(output) {
  if (!output) return null;
  if (typeof output === 'object' && !Array.isArray(output)) return output;
  if (Array.isArray(output)) {
    for (const block of output) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const got = extractJson(block.text);
        if (got) return got;
      }
    }
    return null;
  }
  const text = String(output);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate.trim()); } catch { /* 继续尝试抠首尾花括号 */ }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* ignore */ }
  }
  return null;
}

/** 手工校验（宿主侧 strict 校验之外再加一道，避免结构对但语义空的结论落库） */
export function validateVerdict(v) {
  const allowed = ['no-impact', 'opportunity', 'gap', 'risk'];
  if (!v || typeof v !== 'object') return 'not an object';
  if (!allowed.includes(v.verdict)) return `verdict=${v.verdict}`;
  if (typeof v.headline !== 'string' || !v.headline.trim()) return 'headline missing';
  if (v.headline.length > 200) return 'headline too long';
  if (typeof v.rationale !== 'string' || !v.rationale.trim()) return 'rationale missing';
  if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) return 'confidence out of range';
  if (!Array.isArray(v.proposals)) return 'proposals not array';
  if (v.proposals.length > 3) return 'too many proposals';
  for (const p of v.proposals) {
    if (!p || typeof p.title !== 'string' || !p.title.trim()) return 'proposal title missing';
    if (typeof p.body !== 'string' || !p.body.trim()) return 'proposal body missing';
    if (!['rule', 'skill', 'doc', 'preset', 'service', 'plugin', 'other'].includes(p.category)) {
      return `proposal category=${p.category}`;
    }
  }
  return null;
}
