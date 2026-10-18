/**
 * agint-curriculum: challenge-gen（§4.3 [2] + §5.2 B-3）——挑战生成。
 *
 * 确定性生成：给定 domain + level → 固定模板文本 + verifySpec。
 * 每个挑战必须带**可自动判定的通过条件**（C1）；verifySpec 由 verdict.js
 * 还原为断言函数，不存函数只存规格（可序列化、可复现）。
 *
 * 模板域（§5.2 B-3）：原 codegen / reasoning / planning / tool-use 四域，
 * v0.1.3 并入 capability_map 真实存在的 integration / correctness（零挑战修法①）。
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

// ── integration：把「集成多组件」拆解为步骤清单（断言：步骤数量 + 必需环节）──
//
// v0.1.3 并入（零挑战修法①）。域来自 self-model capability_map 的真实类别。
// 复用既有 step-list 断言器，不新建判定类型。
//
// v0.1.5 扩题库：每档从 1 道扩到 3 道（variant 0/1/2）。
// 原因：v0.1.4 的去重撞重后只能顺延难度档，D1-D5 共 5 道题 → 5 周即耗尽。
// 扩到 3 道后，同档位可换题而不动难度，15 周才顺延一次档位。
// variant 0 是历史上已出过的题面（生产存量能对上），不删除。

const INTEGRATION_TASKS = {
  D1: [
    { task: '把「让前端表单调用后端 API 并处理失败」拆解成集成步骤清单。', min: 3, keywords: ['请求', '错误'] },
    { task: '把「从本地读 JSON 配置并在缺失时回退默认值」拆解成集成步骤清单。', min: 3, keywords: ['配置', '默认'] },
    { task: '把「把 CLI 参数接入命令执行并回显输出」拆解成集成步骤清单。', min: 3, keywords: ['参数', '输出'] },
  ],
  D2: [
    { task: '把「把定时任务接入事件总线并在关闭时取消订阅」拆解成集成步骤清单。', min: 4, keywords: ['订阅', '发布', '取消'] },
    { task: '把「HTTP 路由接入鉴权中间件并统一错误响应」拆解成集成步骤清单。', min: 4, keywords: ['鉴权', '中间件', '错误'] },
    { task: '把「把数据库连接池接入服务的启动与关闭流程」拆解成集成步骤清单。', min: 4, keywords: ['连接', '启动', '关闭'] },
  ],
  D3: [
    { task: '把「OpenViking 检索接入 input-gateway 作数据源（软依赖降级）」拆解成集成步骤清单。', min: 5, keywords: ['检索', '信号', '降级'] },
    { task: '把「把外部支付回调接入订单状态机并防重放」拆解成集成步骤清单。', min: 5, keywords: ['回调', '幂等', '重放'] },
    { task: '把「把对象存储上传接入业务表单并支持断点续传」拆解成集成步骤清单。', min: 5, keywords: ['上传', '分片', '校验'] },
  ],
  D4: [
    { task: '把「DB 与缓存双写集成（含一致性回退）」拆解成集成步骤清单。', min: 6, keywords: ['缓存', '回退', '一致'] },
    { task: '把「把搜索索引接入主库变更流并保证最终一致」拆解成集成步骤清单。', min: 6, keywords: ['索引', '变更', '补偿'] },
    { task: '把「把消息队列接入订单履约并处理重复投递」拆解成集成步骤清单。', min: 6, keywords: ['投递', '重复', '确认'] },
  ],
  D5: [
    { task: '把「多服务集成的零停机版本切换」拆解成集成步骤清单。', min: 7, keywords: ['灰度', '回滚', '健康'] },
    { task: '把「把单区域部署扩为多区域双活并保持数据一致」拆解成集成步骤清单。', min: 7, keywords: ['区域', '同步', '切换'] },
    { task: '把「把自建日志管道迁移到托管服务且不丢数据」拆解成集成步骤清单。', min: 7, keywords: ['迁移', '校验', '回滚'] },
  ],
};

// ── correctness：确定性结果作答（断言：结论与已知答案匹配）──────────────────
//
// v0.1.3 并入。复用 conclusion-match 断言器——答案唯一才可自动判定（C1）。
//
// v0.1.5 扩题库：每档 3 道。**每道题的 expected 都是用脚本真算出来的**
// （见 CHANGELOG 0.1.5 的核对记录），不靠心算；同档内答案互不相同。
// variant 0 为历史存量题面，不删除。

const CORRECTNESS_TASKS = {
  D1: [
    { task: '计算 17 + 26。请给出数字结论。', expected: '43' },
    { task: '计算 8 × 7。请给出数字结论。', expected: '56' },
    { task: '计算 100 - 37。请给出数字结论。', expected: '63' },
  ],
  D2: [
    { task: '数组 [3, 1, 2] 升序排列后，中间的元素是哪个？请给出结论。', expected: '2' },
    { task: '数组 [9, 4, 7, 1] 升序排列后，下标 2 的元素是哪个（下标从 0 起）？请给出结论。', expected: '7' },
    { task: '数组 [5, 5, 2, 8, 1] 升序排列后，中间的元素是哪个？请给出结论。', expected: '5' },
  ],
  D3: [
    { task: 'len(set([1, 2, 2, 3])) 的结果是多少？请给出数字结论。', expected: '3' },
    { task: 'len(set([5, 5, 1, 9, 9, 2])) 的结果是多少？请给出数字结论。', expected: '4' },
    { task: 'len(set([7, 7, 7])) 的结果是多少？请给出数字结论。', expected: '1' },
  ],
  D4: [
    { task: '字符串 "abracadabra" 中字母 a 共出现几次？请给出数字结论。', expected: '5' },
    { task: '字符串 "mississippi" 中字母 s 共出现几次？请给出数字结论。', expected: '4' },
    { task: '字符串 "banana" 中字母 n 共出现几次？请给出数字结论。', expected: '2' },
  ],
  D5: [
    { task: '爬 6 级台阶，每次 1 或 2 级，共有多少种走法？请给出数字结论。', expected: '13' },
    { task: '爬 7 级台阶，每次 1 或 2 级，共有多少种走法？请给出数字结论。', expected: '21' },
    { task: '爬 8 级台阶，每次 1 或 2 级，共有多少种走法？请给出数字结论。', expected: '34' },
  ],
};

// ── 题目池：单档多题（v0.1.5）────────────────────────────────────────────
//
// 每档可以是单个对象（旧域：codegen/reasoning/planning/tool-use）或数组
// （新域：integration/correctness，每档 3 道）。
//
// 为什么这么设计：v0.1.4 的去重撞重后只能顺延难度档，池子每档 1 道
// → 5 周就耗尽。扩成每档 3 道后，撞重优先在同档换 variant，15 周才顺延一档。
//
// 向后兼容：不传 variant（或 variant=0）时取数组首项，与 v0.1.4 输出逐字一致。

const TASK_BANKS = {
  codegen: CODEGEN_TASKS,
  reasoning: REASONING_TASKS,
  planning: PLANNING_TASKS,
  'tool-use': TOOLUSE_TASKS,
  integration: INTEGRATION_TASKS,
  correctness: CORRECTNESS_TASKS,
};

/** 从某域某档取一道题；variant 取模，兼容「单对象」与「数组」两种形状。 */
function pick(bank, level, variant = 0) {
  const slot = bank[level];
  if (!slot) throw new Error(`pick: 域 ${level} 档无题目`);
  if (Array.isArray(slot)) return slot[variant % slot.length];
  return slot;
}

/** 取某域某档的题池大小；域无模板 → 0。 */
export function bankSize(domain, level) {
  const slot = TASK_BANKS[domain]?.[level];
  if (!slot) return 0;
  return Array.isArray(slot) ? slot.length : 1;
}

/** 取某域全部档位的题池总量（用于耗尽判定与文档展示）。 */
export function totalBankSize(domain) {
  const banks = TASK_BANKS[domain];
  if (!banks) return 0;
  return Object.keys(banks).reduce((n, lv) => n + bankSize(domain, lv), 0);
}

const TEMPLATES = {
  codegen: {
    generate(level) {
      const t = pick(CODEGEN_TASKS, level);
      return {
        prompt: t.task,
        passCriteria: '运行成功（exit code = 0）且输出非空。提交 evidence：{ exitCode, output }。',
        verifySpec: { type: 'exit-code-output', expected: null, minLength: t.min },
      };
    },
  },
  reasoning: {
    generate(level) {
      const t = pick(REASONING_TASKS, level);
      return {
        prompt: t.task,
        passCriteria: '给出结论并提交 evidence：{ conclusion }（必须与预期答案一致）。',
        verifySpec: { type: 'conclusion-match', expected: t.expected, minLength: 0 },
      };
    },
  },
  planning: {
    generate(level) {
      const t = pick(PLANNING_TASKS, level);
      return {
        prompt: t.task,
        passCriteria: `提交 evidence：{ steps: string[] }（至少 ${t.min} 步）。`,
        verifySpec: { type: 'step-list', expected: t.keywords, minLength: t.min },
      };
    },
  },
  'tool-use': {
    generate(level) {
      const t = pick(TOOLUSE_TASKS, level);
      return {
        prompt: t.task,
        passCriteria: `使用指定工具并提交 evidence：{ toolUsed, exitCode, output }。`,
        verifySpec: { type: 'tool-match', expected: t.tool, minLength: 0 },
      };
    },
  },
  integration: {
    generate(level, variant) {
      const t = pick(INTEGRATION_TASKS, level, variant);
      return {
        prompt: t.task,
        passCriteria: `提交 evidence：{ steps: string[] }（至少 ${t.min} 步，且含必需环节关键词）。`,
        verifySpec: { type: 'step-list', expected: t.keywords, minLength: t.min },
      };
    },
  },
  correctness: {
    generate(level, variant) {
      const t = pick(CORRECTNESS_TASKS, level, variant);
      return {
        prompt: t.task,
        passCriteria: '给出结论并提交 evidence：{ conclusion }（必须与预期答案一致）。',
        verifySpec: { type: 'conclusion-match', expected: t.expected, minLength: 0 },
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
 *
 * v0.1.5：新增 variant 入参，从同档题池里选一道。
 * 确定性保持——同 (domain, level, variant) → 同 prompt / passCriteria / verifySpec。
 * 不传 variant 时取 variant 0，输出与 v0.1.4 逐字一致（向后兼容）。
 */
export function generateChallenge(domain, level, { sessionId, variant = 0 } = {}) {
  const tpl = TEMPLATES[domain];
  if (!tpl) {
    throw new Error(`generateChallenge: domain "${domain}" 无模板（可自动判定的域仅 ${TEMPLATE_DOMAINS.join('/')}）`);
  }
  const { prompt, passCriteria, verifySpec } = tpl.generate(level, variant);
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
