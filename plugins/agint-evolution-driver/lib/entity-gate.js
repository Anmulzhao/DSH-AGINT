/**
 * agint-evolution-driver: entity-gate — 实体存在性门（可复用模块，2026-09-27 v0.2.5）
 *
 * # 为什么单独成文件
 * 这道门原先只在 evolution-driver 内部用（v0.2.4），但「LLM 产出的文本引用了不存在的实体」
 * 是**所有 LLM 写盘路径**的共同风险（K117），不只改动仓库这一条链。抽成独立的纯模块后：
 *   - 判据只有一份，别的插件不必各抄一份（抄三份必然漂移，而漂移的闸门 = 假绿）；
 *   - 消费者**不必**跨插件 import —— driver 把它作为 `agint.evolutionDriver.checkEntities`
 *     暴露（软依赖调用，bundle apply 顺序无关），repoRoot/代码索引由 driver 侧统一持有。
 *
 * # 判据（核心：证据必须结构化，文本提及不算数）
 * `oldText` 锚得住只证明「编辑位置真实」，防不了 `newText` 内容级编造 ——
 * 2026-09-27 18:30 实测：引擎落盘的编辑引用了不存在的插件 agint-evolution-viz。
 * ⚠️ 反面教训：docs 规划文档 / eval mock / 代码注释**都会**提及从未存在的实体
 * （K115 幽灵接口的自举形态）。所以「文本里出现过」不构成存在证据，三类可机器验证的实体：
 *
 *   1. 仓库路径（含 / 且扩展名可识别）→ 必须在 repoFiles 里
 *   2. agint-* 插件/技能名 → **目录前缀**必须真实存在（结构化，不看正文）
 *   3. snake_case 标识符（表/存储名）→ 必须出现在插件生产代码索引里（**注释已剥离**）
 *
 * 其余 token 一律放行（压误报）。返回去重排序后的编造实体列表，空数组 = 通过。
 *
 * ⚠️ 实现坑（踩过）：`codeText: undefined` 会触发解构默认 `''`（= 严格空索引 ⇒ 全拦），
 * 想「跳过校验」必须**显式传 `null`**。
 */

/** 代码索引容量护栏（超限即停，索引允许不完整但不允许拖垮进程）。 */
export const CODE_INDEX_MAX_BYTES = 4_000_000;
export const CODE_FILE_MAX_BYTES = 262_144;
/** 代码证据源：仅插件生产代码 lib/（docs/eval/test 里的提及不算证据 —— mock 不是证据）。 */
export const CODE_PATH_RX = /^plugins\/[^/]+\/lib\/.+\.(?:js|mjs|cjs|ts)$/;

/**
 * 实体存在性门。返回编造实体列表（去重排序，空数组 = 通过）。
 * @param {string} newText  待检文本（LLM 产出的新内容）
 * @param {{repoFiles?: string[], codeText?: string|null}} ctx
 *        repoFiles 仓库相对路径全集；codeText 生产代码索引（**null = 索引不可用 ⇒ 放行 snake 类**）
 */
export function findFabricatedEntities(newText, { repoFiles = [], codeText = '' } = {}) {
  const fabricated = new Set();
  if (typeof newText !== 'string' || !newText) return [];
  const paths = new Set(Array.isArray(repoFiles) ? repoFiles : []);
  const pathList = Array.isArray(repoFiles) ? repoFiles : [];
  const code = typeof codeText === 'string' ? codeText : null;
  const dirExists = (prefix) => pathList.some((p) => p.startsWith(prefix));
  const rx = /`([^`\n]{3,120})`/g;
  let m;
  while ((m = rx.exec(newText)) !== null) {
    const token = m[1].trim();
    // 1. 仓库路径
    if (token.includes('/') && /\.[A-Za-z][A-Za-z0-9]{1,5}$/.test(token)) {
      if (!paths.has(token)) fabricated.add(token);
      continue;
    }
    // 2. agint-* 命名实体 —— 结构化证据：插件目录或 preset 技能目录真实存在
    if (/^agint-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)) {
      const ok =
        dirExists(`plugins/${token}/`) ||
        dirExists(`presets/agint/skills/${token}/`) ||
        dirExists(`presets/${token}/`);
      if (!ok) fabricated.add(token);
      continue;
    }
    // 3. snake_case 标识符 —— 证据=插件生产代码（codeText=null 时索引不可用，放行）
    if (/^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+$/.test(token)) {
      if (code !== null && !code.includes(token)) fabricated.add(token);
      continue;
    }
  }
  return [...fabricated].sort();
}

/**
 * 代码证据索引：只读 plugins/<name>/lib/ 下的生产代码，**剥离注释行**
 * （注释会提及从未存在的实体 —— 连本模块自己的注释都写了 agint-evolution-viz）。
 * fs.codeIndex 可注入测试；失败返回 null（调用方放行 snake 类并留痕）。
 */
export async function buildCodeIndex(repoRoot, repoFiles, { fs } = {}) {
  if (!repoRoot || !Array.isArray(repoFiles) || repoFiles.length === 0) return '';
  const inj = fs?.codeIndex;
  if (typeof inj === 'function') return await inj(repoRoot, repoFiles);
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const chunks = [];
  let total = 0;
  for (const rel of repoFiles) {
    if (total >= CODE_INDEX_MAX_BYTES) break;
    if (!CODE_PATH_RX.test(rel)) continue;
    try {
      const raw = await readFile(join(repoRoot, rel), 'utf8');
      const stripped = raw
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/'));
        })
        .join('\n');
      const clipped = stripped.length > CODE_FILE_MAX_BYTES ? stripped.slice(0, CODE_FILE_MAX_BYTES) : stripped;
      chunks.push(clipped);
      total += clipped.length;
    } catch {
      // 单文件读不出来就跳过，索引允许不完整但不允许中断
    }
  }
  return chunks.join('\n');
}
