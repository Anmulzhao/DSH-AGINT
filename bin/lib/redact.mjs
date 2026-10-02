// bin/lib/redact.mjs —— 脱敏原语：路径泛化 + 敏感模式扫描（零依赖纯函数）
//
// 用途：Phase 3 交付物三的脱敏规则 D2（路径泛化）与 D3（敏感扫描）。
// 设计依据：docs/specs/evolution-package-v1.md §4.2。
//
// ⭐ 为什么独立成纯函数模块：
//   ① 这两条规则是**最高风险点**，必须有独立可测的单元 —— 混在导出主程序里
//      就只能靠端到端导出验证，而导出要真实数据、代价高。
//   ② 纯函数不读文件、不读环境 ⇒ 测试不碰生产数据（K62 精神）。

// ── D2：绝对路径泛化 ───────────────────────────────────────────────────────

/**
 * 分隔符正则片段。
 *
 * ⭐ 踩过的坑：最初写成 `\\?/`（反斜杠可选 + 正斜杠）——
 *    结果**只匹配正斜杠形态，反斜杠全漏**。而 Windows 是本机主力环境
 *    （preimage 备份、事件载荷里的路径都是 `C:\Users\...` 形态）⇒ 漏掉的
 *    恰是最需要脱敏的那批。**安全类规则「静默漏匹配」比「误报」危险得多。**
 *
 * 正确做法：分隔符统一写成 `[/\\]`，可匹配任一形态。
 */
/*
 * ⭐⭐ 这里踩过两个正则坑，都是「静默漏匹配」，性质比误报危险得多：
 *
 *   坑 1：`\\?/` 以为能同时匹配 `C:\` 与 `C:/`。
 *        实测**只匹配正斜杠** —— 而 Windows 是本机主力环境
 *        （preimage 备份、事件载荷里全是 `C:\Users\...`）⇒ 漏掉的恰是最该脱敏的。
 *
 *   坑 2：用字符串拼正则（`"[/\\\\]"`）时，JS 字符串字面量会把 `\\\\` 吃成 `\\`，
 *        最终正则里的字符类变成 `[/\]` —— **右括号被转义掉，字符类永不闭合**。
 *        表现同样是「静默不匹配」，且极难看出来。
 *
 * ⇒ 结论：**路径类正则一律用字面量写，不用字符串拼接。**
 *    需要复用的部分用「带 g 的字面量 + 每次 new RegExp(source, flags)」处理 lastIndex。
 */

/** 分隔符：正斜杠或反斜杠（字面量，无字符串转义）。 */
const SEP = /[/\\]/;

/** 非路径字符类。字面量写法，`[` 在字符类内无需转义。 */
const NEG_CLASS = /[/\\]/;

/**
 * 路径泛化规则表。
 *
 * ⭐ 每条都要写 `why` —— 没有理由的替换表就是后门：
 * 后来者会加一条「看起来更安全」的规则，实际会破坏可还原性。
 *
 * 顺序敏感：**长前缀在前**。`C:/Users/<name>/.dsh` 必须排在 `C:/Users/<name>` 之前，
 * 否则用户目录先被吃掉，DSH_HOME 这层信息就丢了。
 */
export const PATH_RULES = [
  {
    // 顺序 0（最高）：**JSON 转义形态** `C:\\Users\\Bob\\.dsh`（反斜杠成对）。
    // ⭐ 为什么要单独一条：导出流程必然先 `JSON.stringify` 再脱敏 ⇒ 路径变成
    //   `C:\\Users\\…`（每个反斜杠变成两个）。通用规则的 `[/\\]` 只吃一个，
    //   剩下那个会拼在占位符与后续内容之间 ⇒ 匹配不到 / 匹配歪。
    //   实测（2026-10-03）：没这条规则时导出包**必然**带本机绝对路径。
    pattern: /[A-Za-z]:(?:\\){1,2}Users(?:\\){1,2}[^/\\\s"']+?(?:\\){1,2}\.dsh/gi,
    replacement: '<DSH_HOME>',
    why: 'JSON 序列化后的 DSH_HOME 路径。漏这条 ⇒ 导出包必然泄露本机路径。',
  },
  {
    // 顺序 0b：JSON 转义形态的仓库根
    pattern: /[A-Za-z]:(?:\\){1,2}DSH(?:(?:\\){1,2}project源码)?(?:(?:\\){1,2}DSH-AGINT(?:\.wiki)?)?/gi,
    replacement: '<AGINT_REPO>',
    why: 'JSON 序列化后的仓库根路径。同上，必需单独一条。',
  },
  {
    // 顺序 0c：JSON 转义形态的 **Windows 用户目录**（不含 .dsh 的那种）。
    // ⭐ 实测（2026-10-03）：导出包 `REDACTION-REPORT.json` 的 `why` 文本里写着
    //   `C:\\Users\\<name>\\AppData\\...` ⇒ 顺序 5 的 `[/\\]Users[/\\][^/\\]+?`
    //   **匹配不上**。原因：`[/\\]` 只吃一个字符，而 JSON 形态下用户名后面紧跟的
    //   是 `\\` 的**第一个** `\`；惰性 `+?` 至少要吃一个非分隔符字符 ⇒ 整条失配。
    //   漏这条 ⇒ 用户名必然随报告出包（报告是包的一部分，报告泄露 = 包泄露）。
    //   字符类写成 `[^\\/"\s]`：遇 `\` 即止，保留 `\\` 分隔符，JSON 结构不被破坏。
    pattern: /[A-Za-z]:(?:\\){1,2}Users(?:\\){1,2}[^\\/"'\s]+/gi,
    replacement: '<HOME>',
    why: 'JSON 序列化后的 Windows 用户目录。与顺序 0 同源，但不含 .dsh 后缀的那部分路径。',
  },
  {
    // 顺序 1：DSH_HOME 最具体，必须先于用户目录。
    // 字面量写法：`[/\\]` 匹配两种分隔符；`[^/\\\s"']+?` 惰性匹配用户名。
    pattern: /[A-Za-z]:[/\\]Users[/\\][^/\\\s"']+?[/\\]\.dsh(?=[/\\]|\s|$|["'])/gi,
    replacement: '<DSH_HOME>',
    why: 'dsh 的配置与存储根。里面是全部 runtime 数据与凭据形态文件。',
  },
  {
    // 顺序 2：仓库根。两机路径不同是 Phase -1 已证的问题，泄露它等于泄露目录结构。
    // 同时覆盖 Windows（D:\DSH\...）与容器内（/workspace/DSH-AGINT/...）两种形态。
    pattern: /[A-Za-z]:[/\\]DSH(?:[/\\]project源码)?(?:[/\\]DSH-AGINT(?:\.wiki)?)?/gi,
    replacement: '<AGINT_REPO>',
    why: '本机仓库根与 wiki 路径。Phase -1 已证多机绝对路径硬编码，泄露它对接收方无用、对本机有害。',
  },
  {
    pattern: /[/\\]workspace[/\\]DSH-AGINT(?:[/\\]AGINT-data)?/gi,
    replacement: '<AGINT_REPO>',
    why: '容器内仓库路径。gszx 容器与本机两机共仓，这条路径同样不该外泄。',
  },
  {
    // 顺序 4：Linux 用户目录
    pattern: /[/\\]home[/\\][^/\\\s"']+/gi,
    replacement: '<HOME>',
    why: 'Linux 用户名 + 家目录。',
  },
  {
    // 顺序 5：macOS 用户目录。⚠️ 必须排在 DSH_HOME 之后。
    pattern: /[/\\]Users[/\\][^/\\\s"']+/gi,
    replacement: '<HOME>',
    why: 'macOS 用户名 + 家目录。⚠️ 必须排在 DSH_HOME 之后。',
  },
];

/**
 * 泛化文本中的绝对路径。
 *
 * @param {string} text
 * @returns {{ text: string, count: number, applied: Array<{rule: string, count: number}> }}
 */
export function generalizePaths(text) {
  let out = text;
  let count = 0;
  const applied = [];

  for (const rule of PATH_RULES) {
    // 每次 new RegExp：规则里的 pattern 带 /g，lastIndex 会残留（K49 同类问题）
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let n = 0;
    out = out.replace(re, () => {
      n += 1;
      return rule.replacement;
    });
    if (n > 0) {
      count += n;
      applied.push({ rule: rule.replacement, count: n });
    }
  }

  return { text: out, count, applied };
}

// ── D3：敏感模式扫描 ───────────────────────────────────────────────────────

/**
 * 敏感模式表。
 *
 * ⭐ 每条都带 `id` —— 脱敏报告要按 id 记账（D5 要求记录排除了什么）。
 *    没有 id 就只能写「扫了一遍」，无法复核。
 *
 * ⚠️ **误报是允许的，漏报不是**。命中即整条排除（D3 规则原文），
 *    宁可损失信息也不承担泄露风险。
 */
export const SENSITIVE_PATTERNS = [
  {
    id: 'aws-access-key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    why: 'AWS access key id',
  },
  {
    id: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    why: 'PEM 私钥块',
  },
  {
    id: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    why: 'GitHub PAT / OAuth token',
  },
  {
    id: 'slack-token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    why: 'Slack token',
  },
  {
    id: 'openai-key',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    why: 'OpenAI 风格 API key',
  },
  {
    id: 'bearer-token',
    re: /Bearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g,
    why: 'HTTP Authorization: Bearer',
  },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    why: 'JWT（可能含会话凭据）',
  },
  {
    id: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    why: '邮箱地址（PII）',
  },
  {
    id: 'cn-mobile',
    re: /\b1[3-9]\d{9}\b/g,
    why: '中国大陆手机号（PII）',
  },
  {
    id: 'internal-host',
    // 内网地址：192.168.x.x / 10.x.x.x / 172.16-31.x.x
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    why: '内网地址（泄露网络结构）',
  },
  {
    id: 'conn-str-with-credential',
    // postgres://user:pass@host 形态
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@[^\s/]+/gi,
    why: '连接串内嵌用户名密码',
  },
  {
    id: 'anthropic-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    why: 'Anthropic API key',
  },
  {
    id: 'minimax-key',
    re: /\b(?:eyJhbGciOi[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}\b/g,
    why: 'JWT 形态的第三方 API key（含 minimax / openviking 用的 X-Api-Key）',
  },
];

/**
 * 扫描文本里的敏感片段。
 *
 * ⚠️ **不返回匹配到的原文** —— 只返回 pattern id 与命中数。
 *    理由：脱敏报告本身也会进包，若报告里带原文，泄露面反而扩大。
 *
 * @param {string|unknown} value
 * @returns {{ sensitive: boolean, hits: Array<{id: string, count: number}> }}
 */
export function scanSensitive(value) {
  if (typeof value !== 'string') return { sensitive: false, hits: [] };
  const hits = [];
  for (const p of SENSITIVE_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    const m = value.match(re);
    if (m && m.length > 0) hits.push({ id: p.id, count: m.length });
  }
  return { sensitive: hits.length > 0, hits };
}

/**
 * 深度扫描一个值（对象 / 数组 / 字符串），返回命中汇总。
 *
 * ⚠️ 只扫**字符串叶子**。number / boolean / null 不可能含凭据形态。
 *
 * @param {unknown} value
 * @returns {{ sensitive: boolean, hits: Array<{id:string,count:number}>, paths: string[] }}
 */
export function scanSensitiveDeep(value) {
  const hitMap = new Map();
  const paths = [];

  const walk = (v, path) => {
    if (typeof v === 'string') {
      const r = scanSensitive(v);
      if (r.sensitive) {
        paths.push(path);
        for (const h of r.hits) {
          const cur = hitMap.get(h.id) ?? 0;
          hitMap.set(h.id, cur + h.count);
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) walk(val, path ? `${path}.${k}` : k);
    }
  };

  walk(value, '');
  return {
    sensitive: hitMap.size > 0,
    hits: [...hitMap.entries()].map(([id, count]) => ({ id, count })),
    paths,
  };
}

/**
 * 对一段 JSON 文本同时做路径泛化与敏感扫描（D2 + D3 组合）。
 *
 * ⚠️ 顺序有意义：先泛化再扫描。泛化会把 `C:/Users/x/.dsh/...` 变成
 * `<DSH_HOME>/...`，若某个敏感串恰好跨路径边界（如 `key=C:/Users/...`），
 * 先扫描会误判为路径而非凭据。先泛化能让扫描看到「归一后」的形态。
 *
 * @param {string} text
 */
export function redactText(text) {
  const g = generalizePaths(text);
  const s = scanSensitive(g.text);
  return {
    text: g.text,
    pathCount: g.count,
    pathRules: g.applied,
    sensitive: s.sensitive,
    sensitiveHits: s.hits,
  };
}
