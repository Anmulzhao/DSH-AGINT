/**
 * agint-memory-provider: 琐碎输入过滤（设计稿 §7）。
 *
 * 动机（§7.1）：不是每轮都需要检索记忆。对「好的」「继续」「谢谢」这类输入，
 * 检索既浪费 API 调用，又可能把不相关的旧上下文注入、干扰回复。
 *
 * ⚠️ 设计稿 §7.2 的正则**只覆盖英文**，但智进日常以中文交互；§14.2 明确把
 * 「琐碎输入过滤的正则是否准确（中文场景）」列为待验证项。本实现在保留原英文
 * 规则的同时补齐中文确认/问候/推进词，并加测试覆盖正例与反例。
 *
 * 关键设计（§7.2）：
 *   - 正则**锚定开头和结尾**，避免「k8s」「yolo」「note」「好的呀我们开始吧」被误判
 *   - 只匹配纯问候/确认词 + 标点/空白，不匹配有实质内容的输入
 *   - 斜杠命令（/reset、/new 等）跳过
 *   - 空输入跳过
 */

// ── 英文琐碎词（设计稿 §7.2 原集合，保持不变）───────────────────────────

const TRIVIAL_EN = [
  'yes', 'no', 'ok', 'okay', 'sure', 'thanks', 'thank you', 'y', 'n',
  'yep', 'nope', 'yeah', 'nah',
  'hi', 'hey', 'hello', 'yo', 'sup',
  'continue', 'go ahead', 'do it', 'proceed', 'got it', 'cool', 'nice',
  'great', 'done', 'next', 'lgtm', 'k',
];

// ── 中文琐碎词（本实现补齐，对齐 §14.2 待验证项）─────────────────────────
//
// 只收「不携带任何任务信息」的确认/问候/推进/致谢词。刻意**不收**：
//   - 「不错」「很好」等可能接评价对象的词（易误伤「很好，但是…」之外的实义句）
//     → 仅当整句只有该词 + 标点时才命中，靠锚定保证
//   - 任何带宾语/补语的表达（如「继续写第三章」）→ 锚定后自然不命中

const TRIVIAL_ZH = [
  // 确认
  '好', '好的', '好滴', '好嘞', '好吧', '行', '行的', '可以', '可以的',
  '中', '成', '嗯', '嗯嗯', '唔', '哦', '噢', '喔', '是', '是的', '对',
  '对的', '没错', '确实', '收到', '知道了', '明白了', '懂了', '了解',
  '明白了谢谢', '好谢谢',
  // 否定
  '不', '不用', '不要', '不必', '算了', '没', '没有', '没了',
  // 问候
  '你好', '您好', '哈喽', '嗨', '在吗', '在么', '早上好', '晚上好', '下午好',
  // 致谢
  '谢谢', '谢了', '多谢', '感谢', '谢谢你', '谢谢啦', '辛苦', '辛苦了',
  // 推进
  '继续', '接着来', '下一步', '走起', '开始吧', '来吧', '冲',
];

/**
 * 允许跟在琐碎词之后的「纯装饰字符」：空白 + 常见标点 + 语气符号 + 全角标点 +
 * emoji 变体选择符。刻意**不含**汉字与字母数字，防止「好的呀我们开始」误判。
 */
const TAIL_CHARS = String.raw`[\s!?.:;,~'"` + '`' + String.raw`()\[\]{}<>*&^%$#@+=|/\\\-—…·。，、！？；：""''（）【】《》〈〉「」『』～￥…\u00a0\u200b\u3000\u2764\ufe0f]*`;

/** 把词表编译为锚定正则；长词优先，避免「好」抢先匹配掉「好的」 */
function buildRe(words) {
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const alts = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(?:${alts})${TAIL_CHARS}$`, 'i');
}

const TRIVIAL_EN_RE = buildRe(TRIVIAL_EN);
const TRIVIAL_ZH_RE = buildRe(TRIVIAL_ZH);

/**
 * 判断输入是否琐碎（应跳过记忆召回）。
 * @param {string} text
 * @returns {boolean}
 */
function isTrivialPrompt(text) {
  const stripped = String(text ?? '').trim();
  // 空输入跳过（§7.2）
  if (!stripped) return true;
  // 斜杠命令跳过（§7.2）：/reset、/new、/branch 等
  if (stripped.startsWith('/')) return true;
  // 过长输入必然携带实质内容，直接短路（防正则回溯开销）
  if (stripped.length > 64) return false;
  return TRIVIAL_EN_RE.test(stripped) || TRIVIAL_ZH_RE.test(stripped);
}

export {
  isTrivialPrompt,
  TRIVIAL_EN,
  TRIVIAL_ZH,
  TRIVIAL_EN_RE,
  TRIVIAL_ZH_RE,
};
