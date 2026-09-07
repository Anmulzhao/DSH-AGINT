/**
 * agint-curriculum: challenge-gen（§4.3 [2] + §5.2 B-3）——挑战生成。
 *
 * 确定性生成：给定 domain + level → 固定模板文本 + verifySpec。
 * 每个挑战必须带**可自动判定的通过条件**（C1）；verifySpec 由 verdict.js
 * 还原为断言函数，不存函数只存规格（可序列化、可复现）。
 *
 * 4 个域模板（§5.2 B-3）：codegen / reasoning / planning / tool-use。
 * 难度档 D1–D5 通过模板参数调节复杂度。
 */

import { TEMPLATE_DOMAINS } from './schema.js';

// ── codegen：exit code + 输出非空 ────────────────────────────────────────

const CODEGEN_TASKS = {
  D1: { task: '编写一个函数 `double(n)`，返回入参的两倍。运行并用 3 个用例输出结果。', min: 1 },
  D2: { task: '编写一个函数 `isPalindrome(s)`，判断字符串是否为回文（忽略大小写）。运行 3 个用例并输出结果。', min: 1 },
  D3: { task: '编写一个函数 `fib(n)`，返回第 n 个斐波那契数（n≥1）。运行 3 个用例并输出结果。', min: 1 },
  D4: { task: '编写一个函数 `mergeSorted(a, b)`，合并两个已排序数组并保持有序。运行 3 个用例并输出结果。', min: 1 },
  D5: { task: '编写一个函数 `minWindow(s, t)`，返回 s 中包含 t 全部字符的最短子串（无解返回空串）。运行 3 个用例并输出结果。', min: 1 },
};

// ── reasoning：结论与预期答案匹配（已知答案，才可自动判定）──────────────

const REASONING_TASKS = {
  D1: { task: 'A 比 B 高，B 比 C 高。谁最高？请给出结论。', expected: 'A' },
  D2: { task: '3 只猫 3 天抓 3 只老鼠。照此速度，9 只猫 9 天抓多少只老鼠？请给出结论。', expected: '27' },
  D3: { task: '一个钟 5 点敲 5 下用时 8 秒。11 点敲 11 下用时多少秒？请给出结论。', expected: '20' },
  D4: { task: '甲乙丙三人只有一人说真话：甲说"是乙干的"；乙说"不是我干的"；丙说"甲说的对"。谁干的？请给出结论。', expected: '乙' },
  D5: { task: '100 瓶药中恰有 1 瓶有毒，用试纸检测，毒药会立即让试纸变蓝。至少需要几张试纸能一次找出毒药瓶？请给出结论。', expected: '7' },
};

// ── planning：步骤清单（数量 + 必需步骤关键词）──────────────────────────

const PLANNING_TASKS = {
  D1: { task: '把「整理桌面文件」拆解成步骤清单。', min: 3, keywords: [] },
  D2: { task: '把「为项目添加 CI 流水线」拆解成步骤清单。', min: 4, keywords: ['test', 'build'] },
  D3: { task: '把「将本地仓库发布为 npm 包」拆解成步骤清单。', min: 5, keywords: ['publish', 'version'] },
  D4: { task: '把「将单体服务拆分为两个微服务并平滑迁移」拆解成步骤清单。', min: 6, keywords: ['migrate', 'rollback'] },
  D5: { task: '把「从零搭建一个可横向扩容的分布式日志系统」拆解成步骤清单。', min: 7, keywords: ['shard', 'replica'] },
};

// ── tool-use：指定工具命中 + 退出码 ─────────────────────────────────────

const TOOLUSE_TASKS = {
  D1: { task: '用 read_file 工具读取一个文件并报告其总行数。', tool: 'read_file' },
  D2: { task: '用 glob 工具找出项目里所有 .md 文件并报告数量。', tool: 'glob' },
  D3: { task: '用 grep 工具在项目源码中搜索「TODO」并报告命中数。', tool: 'grep' },
  D4: { task: '用 web_fetch 工具获取一个公开网页并报告其标题。', tool: 'web_fetch' },
  D5: { task: '组合使用 glob + read_file 两个工具，统计项目里所有 .js 文件的总行数。', tool: 'read_file' },
};

const TEMPLATES = {
  codegen: {
    generate(level) {
      const t = CODEGEN_TASKS[level];
      return {
        prompt: t.task,
        passCriteria: '运行成功（exit code = 0）且输出非空。提交 evidence：{ exitCode, output }。',
        verifySpec: { type: 'exit-code-output', expected: null, minLength: t.min },
      };
    },
  },
  reasoning: {
    generate(level) {
      const t = REASONING_TASKS[level];
      return {
        prompt: t.task,
        passCriteria: '给出结论并提交 evidence：{ conclusion }（必须与预期答案一致）。',
        verifySpec: { type: 'conclusion-match', expected: t.expected, minLength: 0 },
      };
    },
  },
  planning: {
    generate(level) {
      const t = PLANNING_TASKS[level];
      return {
        prompt: t.task,
        passCriteria: `提交 evidence：{ steps: string[] }（至少 ${t.min} 步）。`,
        verifySpec: { type: 'step-list', expected: t.keywords, minLength: t.min },
      };
    },
  },
  'tool-use': {
    generate(level) {
      const t = TOOLUSE_TASKS[level];
      return {
        prompt: t.task,
        passCriteria: `使用指定工具并提交 evidence：{ toolUsed, exitCode, output }。`,
        verifySpec: { type: 'tool-match', expected: t.tool, minLength: 0 },
      };
    },
  },
};

export function hasTemplate(domain) {
  return TEMPLATE_DOMAINS.includes(domain);
}

export function listTemplateDomains() {
  return [...TEMPLATE_DOMAINS];
}

/**
 * 生成单个挑战的业务字段（不含存储 metadata；由调用方 pack）。
 * 确定性：同 domain + level → 同 prompt / passCriteria / verifySpec。
 */
export function generateChallenge(domain, level, { sessionId } = {}) {
  const tpl = TEMPLATES[domain];
  if (!tpl) {
    throw new Error(`generateChallenge: domain "${domain}" 无模板（可自动判定的域仅 ${TEMPLATE_DOMAINS.join('/')}）`);
  }
  const { prompt, passCriteria, verifySpec } = tpl.generate(level);
  return {
    domain,
    templateType: domain,
    level,
    status: 'open',
    prompt,
    passCriteria,
    verifySpec,
    sessionId: sessionId ?? `curriculum-${domain}-${level}`,
    attemptCount: 0,
  };
}
