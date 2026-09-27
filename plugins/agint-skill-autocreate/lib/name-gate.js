/**
 * agint-skill-autocreate: name-gate — 语义命名门禁（2026-09-27）。
 *
 * ## 为什么要有这道门
 *
 * 2026-09-27 取证：已发布的 3 个技能叫
 *   `pwsh-pwsh-pwsh-pwsh` / `pwsh-glob-webfetch-webfetch` / `agintsearch-pwsh-askuserquestion-pwsh`
 * 描述是「pwsh → pwsh → pwsh → …（参数：command/description）」——**名字和描述就是工具调用序列
 * 原样拼出来的**，没有任何语义抽象。
 *
 * 技能被发现靠的是模型读 name + description 判断"这条用不用得上"。没有任何模型会看着
 * `pwsh-pwsh-pwsh-pwsh` 认为它适用于当前任务 ⇒ **0 调用是设计出来的，不是运气差**。
 *
 * 这道门只做一件事：**名字必须表达"做什么"，而不是"用了哪些工具"**。
 *
 * ## 判据（全部是结构性规则 + 一张可注入的工具名表）
 *
 * 1. 非 kebab-case → 拒（格式）
 * 2. 任一 token 连续重复 ≥2 次 → 拒（`pwsh-pwsh-pwsh-pwsh`）
 * 3. 非重复 token 全是工具名 → 拒（`pwsh-glob-webfetch-webfetch`）
 * 4. token 数 ≥3 且工具名占比 ≥2/3 → 拒（`agintsearch-pwsh-askuserquestion-pwsh`）
 * 5. 描述是工具序列（"a → b → c" 骨架，且骨架里全是工具名）→ 拒
 *
 * ⛔ 边界：这道门**只挡"明显是工具序列"的命名**，不判断名字好不好。
 * 语义质量交给 LLM 评审（llm-verdict），这里只做确定性拦截。
 */

/** 已知工具名（小写，含下划线/连字符两种写法都会先归一）。可注入扩展。 */
export const KNOWN_TOOLS = Object.freeze([
  'pwsh', 'powershell', 'bash', 'shell', 'sh',
  'read', 'write', 'edit', 'glob', 'grep', 'find', 'ls', 'cat', 'sed', 'awk', 'mv', 'cp', 'rm', 'mkdir',
  'webfetch', 'web_fetch', 'websearch', 'web_search', 'fetch', 'curl',
  'askuserquestion', 'ask_user_question', 'todowrite', 'todo_write', 'task',
  'agintsearch', 'agint_search', 'search',
]);

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 归一：下划线/点 → 连字符，去掉非字母数字。 */
export function normalizeToken(t) {
  return String(t ?? '').toLowerCase().replace(/[_.]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * @param {string} name 技能名（kebab-case）
 * @param {string} [description] 技能描述
 * @param {{extraTools?: string[]}} [opts]
 * @returns {{ok: boolean, code: string|null, reason: string|null}}
 */
export function judgeSkillIdentity(name, description = '', opts = {}) {
  const raw = String(name ?? '').trim();
  if (!raw) return { ok: false, code: 'empty', reason: '技能名为空' };
  if (!KEBAB.test(raw)) {
    return { ok: false, code: 'format', reason: `技能名 "${raw}" 不是 kebab-case` };
  }

  const tools = new Set([...KNOWN_TOOLS, ...(opts.extraTools ?? []).map(normalizeToken)].filter(Boolean));
  const tokens = raw.split('-').filter(Boolean);
  if (!tokens.length) return { ok: false, code: 'empty', reason: '技能名无有效 token' };

  // 规则 2：连续重复
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i] === tokens[i - 1]) {
      return {
        ok: false,
        code: 'repeated-token',
        reason: `技能名含连续重复 token "${tokens[i]}" —— 这是工具调用序列，不是用途`,
      };
    }
  }

  const uniq = [...new Set(tokens)];
  const toolTokens = uniq.filter((t) => tools.has(t));

  // 规则 3：全是工具名
  if (toolTokens.length === uniq.length) {
    return {
      ok: false,
      code: 'all-tools',
      reason: `技能名 "${raw}" 的每个词都是工具名 —— 它描述的是"用了哪些工具"，不是"做什么"`,
    };
  }

  // 规则 4：多数是工具名
  if (uniq.length >= 3 && toolTokens.length / uniq.length >= 2 / 3) {
    return {
      ok: false,
      code: 'mostly-tools',
      reason: `技能名 "${raw}" 有 ${toolTokens.length}/${uniq.length} 个词是工具名 —— 需要改成表达用途的动宾短语`,
    };
  }

  // 规则 5：描述是工具序列骨架（a → b → c）
  const desc = String(description ?? '');
  const skeleton = desc.split(/[（(]/)[0] ?? '';
  const arrows = skeleton.split(/→|->|=>/).map((s) => s.trim()).filter(Boolean);
  if (arrows.length >= 2) {
    const arrowTools = arrows.filter((a) => tools.has(normalizeToken(a)));
    if (arrowTools.length === arrows.length && arrows.length >= 3) {
      return {
        ok: false,
        code: 'description-tool-sequence',
        reason: '描述是工具调用序列（a → b → c），没有说明"什么时候该用这个技能"',
      };
    }
  }

  return { ok: true, code: null, reason: null };
}
