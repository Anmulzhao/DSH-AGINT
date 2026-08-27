# agint-quality-static

> 插件代码级静态检查独立 Cordis 插件。Sprint 10 v0.6.3 #4 收口。
>
> **从 `agint-quality` 基座独立**（ROADMAP §架构哲学修正声明，2026-08-26）；
> 与 `agint-quality-sdk` 的模板级 static-check 形成**双轨**（设计稿 §二.1）。

---

## 是什么

D-QAF 安全左移（设计稿 §二.3）：在 plugin 加载时 / cron daily 自动跑时检查 4 类
plugin 代码级问题，避免污染基座 + 不污染 plugin-check 时间。

| 族 | 严重度 | 说明 |
|---|---|---|
| `dependency-audit` | blocker | 解析 `package.json` 比对白名单，阻断未授权第三方依赖 |
| `storage-boundary` | blocker | AST/正则扫 `fs.write*` 直写 storage domain，阻断越权 |
| `env-access` | warn | AST/正则扫 `process.env.<NAME>`，warn 未在 allowlist 的访问 |
| `contract-reference` | blocker | grep L0 契约插件包名 0 命中原则，阻断 L0 污染 |

## Service 契约（FROZEN）

```js
agint.qualityStatic = {
  checkPlugin({ pluginDir, profile? }) → { ok, findings, durationMs, profile },
  checkAll({ pluginsDir }) → { results: { [name]: CheckResult }, totalFindings },
  listFamilies() → string[],
  addAllowlistEntry({ family, pattern }) → { ok, version },
};
```

`Finding` schema：`{ family, severity: 'blocker'|'warn', message, location? }`。

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

## 静态检查 4 族

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
// → ['dependency-audit', 'storage-boundary', 'env-access', 'contract-reference']

// 动态追加 allowlist
await sq.addAllowlistEntry({ family: 'dependency-audit', pattern: 'my-cool-lib' });
```

## 验证

```sh
node --test plugins/agint-quality-static/test/static-smoke.test.mjs
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