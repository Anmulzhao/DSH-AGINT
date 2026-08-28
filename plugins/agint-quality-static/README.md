# agint-quality-static

> 插件代码级静态检查独立 Cordis 插件。Sprint 10 v0.6.3 #4 收口 + Sprint 11 v0.6.5 l0-isolation 收口。
>
> **从 `agint-quality` 基座独立**（ROADMAP §架构哲学修正声明，2026-08-26）；
> 与 `agint-quality-sdk` 的模板级 static-check 形成**双轨**（设计稿 §二.1）。
>
> **Sprint 11 v0.6.5 新增** `l0-isolation` 规则组：动态挂载流水线第一步对合成产物做
> 三项 L0 隔离检查（签名兼容 / 域隔离 / 依赖白名单）。详见下方「l0-isolation 族」章节。

---

## 是什么

D-QAF 安全左移（设计稿 §二.3）：在 plugin 加载时 / cron daily 自动跑时检查 5 类
plugin 代码级问题，避免污染基座 + 不污染 plugin-check 时间。

| 族 | 严重度 | 说明 |
|---|---|---|
| `dependency-audit` | blocker | 解析 `package.json` 比对白名单，阻断未授权第三方依赖 |
| `storage-boundary` | blocker | AST/正则扫 `fs.write*` 直写 storage domain，阻断越权 |
| `env-access` | warn | AST/正则扫 `process.env.<NAME>`，warn 未在 allowlist 的访问 |
| `contract-reference` | blocker | grep L0 契约插件包名 0 命中原则，阻断 L0 污染 |
| `l0-isolation` | blocker | 合成产物三项 L0 隔离（签名兼容 / 域隔离 / 依赖白名单），mount 编排第一步 |

## Service 契约（FROZEN）

```js
agint.qualityStatic = {
  checkPlugin({ pluginDir, profile?, profileOverrides? }) → { ok, findings, durationMs, profile },
  checkAll({ pluginsDir, profileOverrides? }) → { results: { [name]: CheckResult }, totalFindings },
  listFamilies() → string[],
  addAllowlistEntry({ family, pattern }) → { ok, version },
};
```

`Finding` schema：`{ family, severity: 'blocker'|'warn', message, location? }`。

Sprint 11 v0.6.5 新增 `profileOverrides`（可选）：
- `l0IsolationOnly: true` → 仅对「像合成产物」的 plugin 生效（防误伤既有插件）
- `frozenSignatures` / `allowedSynthDomains` / `allowedHostServices` → 覆盖默认白名单
  （mount 编排极少用；测试用）

mount 编排调用示例：
```js
const r = await ctx.agint.qualityStatic.checkPlugin({
  pluginDir: stagingDir,
  profileOverrides: { l0IsolationOnly: true },
});
// contractCheck.signatureDiff     = !r.findings.some(f => f.message.includes('signatureCompatibility') && f.severity === 'blocker')
// contractCheck.domainIsolation   = !r.findings.some(f => f.message.includes('domainIsolation') && f.severity === 'blocker')
// contractCheck.dependencyWhitelist = !r.findings.some(f => f.message.includes('dependencyWhitelist') && f.severity === 'blocker')
```

## Cron 接入

`plugins/agint-cron` 新增 job（设计稿 §二.3）：

```js
{
  id: 'plugin-static-check',
  cron: '0 4 * * *',
  profile: 'agint-default',
  timeoutMs: 120_000,
  handler: async (ctx) => {
    const result = await ctx.qualityStatic.checkAll({ pluginsDir: '<AGINT_HOME>/plugins' });
    for (const [name, r] of Object.entries(result.results)) {
      for (const f of r.findings) {
        if (f.severity === 'blocker') {
          await evo.addFailure({ pattern: `static:${f.family}`, category: 'plugin-static', severity: 'high', evidence: `plugin=${name} finding=${f.message}` });
        }
      }
    }
  },
}
```

失败 → `evo.addFailure('static:<family>')` → policy 决策 path 强制 REJECT（设计稿 §二.3）。

## 静态检查 5 族

### dependency-audit (blocker)
解析 `package.json` 的 `dependencies` / `peerDependencies` / `devDependencies`，
比对 `lib/static-profile.js` 的 `ALLOWED_DEPS`。命中未授权 → blocker finding。

### storage-boundary (blocker)
扫 plugin `lib/*.js` 内 `fs.writeFile` / `fs.appendFile` / `fs.createWriteStream` 调用。
若写入路径包含 storage domain 目录（`agint_evolution` / `agint_memory` 等），
必须经过 Service（`ctx.<storageDomain>.write`），不能直接 fs。
命中 → blocker finding。

### env-access (warn)
扫 `process.env.<NAME>` / `process.env[<NAME>]` 访问，对照 `ENV_ALLOWLIST`。
不在 allowlist → warn finding（设计稿 §六 §6.5 误报阻断）。

### contract-reference (blocker)
grep L0 契约插件包名（见 `lib/checkers/contract-reference.js` 的 `CONTRACT_PATTERN`）在 plugin `lib/*.js` + `index.js` 0 命中。
任何引用 → blocker finding。**checker 自身跳过**（实现需要字符串）。

### l0-isolation (blocker) — Sprint 11 v0.6.5

> 设计稿 §4.4 ADR-11-4：动态挂载流水线第一步对合成产物做的三项 L0 隔离检查。
> 防止 TOOL_SYNTHESIS 变异产物污染基座、冒充 FROZEN 契约、绕过 L0 治理。

**适用范围**：
- **mount 编排**调用 `checkPlugin({ pluginDir, profileOverrides: { l0IsolationOnly: true } })`，
  此时仅对「像合成产物」的 plugin 生效（命名以 `agint-synth-` 开头 / 以 `-synth` 结尾 /
  storage.domains 命中 `agint_synth_*`），既有插件不被误伤。
- **cron daily 全量扫描**默认不挂 l0IsolationOnly=true，此时**对全部 plugin 生效**——
  因为既有插件都符合 l0-isolation 各项规则（命名不以 synth 起、storage 在白名单内、import
  全是白名单内 host），不会出现误报；如果出现，说明既有插件违反了 Sprint 11 新规，应
  在下个 minor 修复。

**三项子检查**（message 前缀 = 子检查名，便于 mount 编排侧按子项聚合）：

#### ① signatureCompatibility（blocker）
读 `manifest.json` 的 `cordis.provides[]`，逐项对比 `static-profile.FROZEN_SIGNATURES`：
- 命中 `schemas[]`（EvalTarget / EvalResult / Decision / DecisionKind / HARM /
  DimensionScore / DreamPhase 共 7 个 L0 schema 名）→ blocker
- 命中 `interfaces[]`（QualityEvaluator / QualityPolicy / QualityReporter /
  QualityLifecycle 共 4 个 L0 interface 名）→ blocker
- 命中 `schemaFields[]`（17 个高频字段名）→ **warn**（字段名常见不直接 blocker）
- `provides[i]` 以 `agint.quality.` 开头（冒充 contract Service 命名空间）→ blocker

#### ② domainIsolation（blocker）
读 `manifest.json` 的 `storage.domains[]`，每项必须命中
`/^agint_synth_[a-z0-9_]+$/`。**老板 2026-08-27 拍板**：禁全部既有 `agint_*` 域，
仅放行 `agint_synth_*`。即「必须全新合成域」 —— 防产物借既有域读取基座数据（尤其
`agint_meta` 这种关键域）。命中既有域 → blocker。

#### ③ dependencyWhitelist（blocker）
扫 `lib/**/*.js` + `index.js`，正则匹配以下形式的 host service 引用：
- `import ... from '@deepseek-ai/agint-<x>'`
- `require('@deepseek-ai/agint-<x>')`
- `import('@deepseek-ai/agint-<x>')`

仅白名单内放行（老板 2026-08-27 拍板）：
- `@deepseek-ai/agint-memory`
- `@deepseek-ai/agint-metrics`
- `@deepseek-ai/agint-cron`

任何其他 `@deepseek-ai/agint-*`（含 `agint-quality-*` / `agint-mount` / `agint-mutator` /
`agint-quality-static` 自己）→ blocker。非 namespaced 的 `agint-*` 包名 → blocker（防呆）。
复用既有 `scan-files.js` 的 `lib/checkers/` 与 `node_modules/` 跳过规则，checker 自身
豁免。

#### 注入测试

`test/l0-isolation.smoke.test.mjs`（4 个 case）：
1. **signature-compatibility 故意破坏**：产物 manifest `provides` 含
   `agint.EvalResult` / `agint.HARM` / `agint.QualityEvaluator` → 期望 3+ blocker
2. **domain-isolation 故意破坏**：产物 manifest `storage.domains = ['agint_meta']` →
   期望 1 个 blocker 精确指向 agint_meta 违规
3. **dependency-whitelist 故意破坏**：产物源码 `import '@deepseek-ai/agint-quality-static'`
   → 期望 blocker 指向 unauthorized host service；变体 import agint-mutator 同理
4. **happy path**：完全合规产物 → 三项全过，0 findings

`test/l0-isolation.unit.test.mjs`（≥20 用例）：每项子检查的 happy / 单 fail / 多 fail
边界 + 外层 `checkL0Isolation` 集成 + `l0IsolationOnly` 防误伤逻辑 + FROZEN_SIGNATURES
完整性断言。

## 使用示例

```js
const sq = ctx.get('agint.qualityStatic');

// 检查单个 plugin
const r = await sq.checkPlugin({ pluginDir: '~/.dsh/profiles/web/plugins/agint-mutator' });
// → { ok: true, findings: [...], durationMs, profile: 'agint-default' }

// 批量检查全部
const all = await sq.checkAll({ pluginsDir: '~/.dsh/profiles/web/plugins' });
// → { results: { 'agint-mutator': {...}, ... }, totalFindings: 7 }

// 列出族
sq.listFamilies();
// → ['dependency-audit', 'storage-boundary', 'env-access', 'contract-reference', 'l0-isolation']

// 动态追加 allowlist
await sq.addAllowlistEntry({ family: 'dependency-audit', pattern: 'my-cool-lib' });
```

## 验证

```sh
node --test plugins/agint-quality-static/test/static-smoke.test.mjs
node --test plugins/agint-quality-static/test/l0-isolation.unit.test.mjs
node --test plugins/agint-quality-static/test/l0-isolation.smoke.test.mjs
bin/plugin-check.sh plugins/agint-quality-static
```

## L0-frozen 保护

- 不引用 quality-contract FROZEN 接口（注释里也不写完整字符串）
- 不修改 contract 任何签名
- checker 自身实现需要包含目标字符串，但 contract-reference checker 跳过自身文件

## 相关

- `AGINT.wiki/Sprint10-设计稿.md` §二.3
- `AGINT.wiki/ROADMAP.md — AGINT 进化路线（优化版：架构解耦与真正插件化）.md` §架构修正声明
- `plugins/agint-quality-sdk/lib/static-check.js` —— Prompt 模板级静态检查（双轨）