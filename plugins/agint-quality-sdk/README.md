# agint-quality-sdk — Prompt SDK (Sprint 5 / v0.5)

> AGINT prompt 层进化的基础设施。提供 `PromptManifest` FROZEN 契约 + 模板引擎 + 三类风险静态检查 + 模板生成器 CLI + 3 个示例 preset。

## 老板拍板的事（来源 ROADMAP）

- **FROZEN 契约**: 字段名 / 类型 / required 集合永不修改, 修改需人类多签 (同 `agint-quality-contract` 治理)
- **≥5 regression tests** per prompt (P3 哲学护栏的"测试必带≥5"在 prompt 层延伸)
- **模板注入风险检测**为 blocker — 任意 `system:` / `<|im_start|>` / `ignore previous instructions` 等模式直接 fail

## 三件事

### 1. PromptManifest (FROZEN) — `lib/schema.js`
定义 `name / version / description / kind / variables / regressionTests / contractRef`，匹配 zod schema。

### 2. 模板引擎 — `lib/template-engine.js`
- `extractPlaceholders(text)` — 提取 `{{ manifest.variable }}` 用法
- `checkPlaceholdersAgainstManifest(...)` — 占位符声明一致性
- `renderPrompt({templateText, manifest, values})` — 渲染 + required 校验 + enum 校验

### 3. 静态检查 — `lib/static-check.js`
三类风险：
- **注入**：`system:` / `assistant:` / `<|im_start|>` / `ignore previous instructions` / shell escape 等 regex
- **占位符滥用**：未声明使用 + edit-distance-1 拼写提示
- **manifest 不一致**：regression tests < 5 / 每个 test 缺 `expectedOutputNotContains` / 占位符未声明

输出 `blockers` 严格 / `warnings` soft。

## CLI — `bin/agint-prompt-init.js`

```sh
node plugins/agint-quality-sdk/bin/agint-prompt-init.js \
  --name=my-prompt \
  --preset=coder \
  --out=plugins/your-preset/skills/
```

行为:
1. 解析 `--name` (kebab-case) + `--preset` (`hello` / `coder` / `investor`)
2. 生成 `<outDir>/<name>/{manifest.json,template.md,tests.json,README.md}`
3. dry-run `staticCheckPrompt` —— blocker 即拒绝写盘
4. dry-run `runRegressionTests` —— 全过再 exit 0

退出码: 0 正常 / 1 violations / 2 参数错。

## 示例 — `examples/`

由 CLI 自动生成, 不需手维护:
- `hello-prompt/` — 最简 demo
- `coder-prompt/` — 系统工程师向
- `investor-prompt/` — 投研向（含 enum）

## Service — `agint.promptSDK`

Plugin 装载后 `ctx.get('agint.promptSDK')` 提供:
- `validate(manifest) → {ok, violations[], data}`
- `render({templateText, manifest, values}) → string`
- `staticCheck({templateText, manifest}) → {ok, violations[], blockers, warnings}`
- `runTests({templateText, manifest}) → [{name, status, ...}]`

## 接入 D-QAF 流水线（v0.5+ TODO）

- WeeklyScheduler 增加 `prompt-static-check` cron job
- `agint-quality-eval` 给 `kind='prompt'` target 增加 evaluator
- `agint-quality-policy` 加 `targetKind='prompt'` 决策路径
- `agint-quality-report` 加 prompt section

## License

MIT
