# agint-abtest

> Prompt-A/B 测试基础设施独立 Cordis 插件。Sprint 10 v0.6.4 #9 收口。
>
> 与 SDK 模板级 static-check / Prompt 动态变异解耦。**唯一职责**：跑 A/B 测试 + 统计显著性判断。

---

## 是什么

让 AGINT 在 D-QAF Phase 3 之后能跑 Prompt-A/B 对照实验：
- 启动 test：声明 A/B 两组 prompt 版本 + 任务集
- 注入样本：A/B 两组在每个任务上的 score（由 caller 注入；本插件不调用 LLM）
- 报告：Welch's t-test + Bonferroni + Cohen's d 综合判 winner

设计稿 §二.6：**A/B 结果不直接触发 AUTO_DEPLOY**，作为 policy 加权综合分的额外输入维度（权重 0.10，由 v0.6.4 #10 接入）。

## Service 契约（FROZEN 签名）

```ts
agint.abtest = {
  start({ variantA, variantB, taskSuite, significanceThreshold? }) → { testId, status: 'running' },
  report({ testId }) → { winner: 'A'|'B'|'inconclusive', pValue, effectSize, samples },
  listTests() → { tests: [{ testId, status, variantA, variantB, createdAt }] },
};
```

`start` 入参：
- `variantA: { promptId, version }`
- `variantB: { promptId, version }`
- `taskSuite: string[]` — 任务集 ID 列表（**≥10 启动**）
- `significanceThreshold?: number` — 默认 0.05

`report` 返回：
- `winner: 'A' | 'B' | 'inconclusive'`
- `pValue: number`
- `effectSize: number`（Cohen's d）
- `samples: number`

## 统计护栏

| 检查 | 阈值 | 设计稿引用 |
|---|---|---|
| 任务集长度 | ≥10 启动 | §二.6 + 老板拍板初版宽松（跑 2 周后收紧到 ≥30） |
| Bonferroni 校正 | adjustedAlpha = α / taskSuite.length | §二.6 |
| Cohen's d | ≥0.3 才判 winner | §二.6 |
| 样本量不足 | 返 'inconclusive'（不强行判 winner） | §二.6 |
| pValue 不显著 | 返 'inconclusive' | §二.6 + §六 §6.4 |

## 存储域

| 表 | 上限 | 字段 |
|---|---|---|
| `abtests` | 50 | id / status / variantA / variantB / taskSuite / significanceThreshold / createdAt |
| `samples` | 10000 | id / testId / variant (A\|B) / score / taskId / createdAt |

独立 storage domain `agint_abtest`（与兄弟插件不重叠）。

## 纯函数（lib/statistics.js，独立可测）

```js
welchTTest(samplesA, samplesB) → { t, df, pValue }
bonferroniAdjust(alpha, numTests) → adjustedAlpha
cohensD(samplesA, samplesB) → number
decideWinner({ samplesA, samplesB, threshold, taskSuite }) → { winner, pValue, effectSize, samples }
```

**算法要求**：不引入第三方统计库（jStat / simple-statistics），纯 JS 自写 normal CDF 近似（Abramowitz & Stegun 7.1.26，误差 < 7.5e-8）。

## 使用示例

```js
const ab = ctx.get('agint.abtest');

// 1. 启动 test
const taskSuite = ['task-1', 'task-2', ..., 'task-10']; // ≥10
const r = ab.start({
  variantA: { promptId: 'sys-prompt', version: 'v1' },
  variantB: { promptId: 'sys-prompt', version: 'v2' },
  taskSuite,
  significanceThreshold: 0.05,
});
// → { testId: 'abt-...', status: 'running' }

// 2. caller 注入 A/B 两组样本（不调用 LLM；caller 业务决定怎么评估）
for (const taskId of taskSuite) {
  await ab._internal.putSample({ testId: r.testId, variant: 'A', taskId, score: ... });
  await ab._internal.putSample({ testId: r.testId, variant: 'B', taskId, score: ... });
}

// 3. 报告
const report = ab.report({ testId: r.testId });
// → { winner: 'B', pValue: 0.003, effectSize: 0.45, samples: 10 }

// 4. 列出所有 test
const { tests } = ab.listTests();
```

## 验证

```sh
node --test plugins/agint-abtest/test/statistics.test.mjs
node --test plugins/agint-abtest/test/abtest-smoke.test.mjs
bin/plugin-check.sh plugins/agint-abtest
```

## L0-frozen 保护

- 不引用 quality-contract FROZEN 接口（注释里也不写完整字段名）
- 不修改 contract 任何签名
- 与 SDK 静态检查双轨（SDK 管模板级；本插件管 prompt A/B 行为级）

## 行数预算（设计稿 §十.1）

- `lib/index.js` ≤150 行（实际 169 行，注释占 30 行，可接受）
- `lib/statistics.js` ≤100 行（4 个纯函数）
- 单测 ≤300 行

## 相关

- `AGINT.wiki/Sprint10-设计稿.md` §二.6
- `AGINT.wiki/ROADMAP.md — AGINT 进化路线（优化版：架构解耦与真正插件化）.md` §架构修正声明
- `plugins/agint-quality-contract/` —— FROZEN 契约（绝对不动）