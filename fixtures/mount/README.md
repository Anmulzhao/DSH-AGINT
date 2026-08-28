# fixtures/mount/ — Sprint 11 测试变异（人工白名单夹具）

> **本目录是离线测试夹具，不是可挂载插件。**
>
> 所有文件**永远不会被加载到 dsh runtime**——它们的存在只是为了
> 让 `agint-mount` / `agint-quality-static` / e2e 工具能**离线静态扫描**它们，
> 验证 L0 隔离三项检查（签名兼容 / 域隔离 / 依赖白名单）的实际生效。

---

## 目录位置（红线）

`fixtures/mount/` 在仓库根下，**不在** `plugins/` 下：

```
AGINT/
├── fixtures/mount/        ← 本目录（人工白名单夹具，独立于 plugins/）
│   ├── echo-tool/         # 合规 fixture（S11-01 / S11-08）
│   └── bad-deps/          # 故意违规 fixture（S11-02 / S11-03）
├── plugins/agint-*/       # 真实插件（永不动）
└── docs/plugins/PLUGIN-SPEC.md
```

---

## 两个 fixture 用途

| fixture | Service 命名空间 | 用途场景 | 期望行为 |
|---|---|---|---|
| **`echo-tool/`** | `agint.synth.echo` | S11-01 快乐路径 / S11-08 同名挂载 | L0 隔离三项全 PASS → phase=HEALTHY → 入种群 |
| **`bad-deps/`** | `agint.synth.badDeps` | S11-02 静态门禁拒绝 | L0 隔离「依赖白名单」单项 FAIL → phase 停在 PREPARE 前 |

---

## 红线（任何人都不能违反）

1. **永不被挂载**：不进入 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 loader list
2. **永不被 safe-update 引用**：`bin/safe-update.sh` 任何子命令都不引用本目录
3. **永不被动态加载**：`cordis_run` / `cordis_define` / `cordis_inspect_self` 都不加载
4. **永不进真实锦标赛**：`agint-population.register()` 不接收 fixture（即使被注册也带 `origin=fixture, excludeFromTournament=true` 标记）
5. **永不污染 FROZEN 契约**：fixture 的 Service 形态仅与 FROZEN 对齐（命名/形态），**不实现** FROZEN 方法体
6. **唯一消费方式**：静态扫描（`fs.readFileSync` + JSON.parse / yaml.parse / AST）

违反以上任一条 = 触发 AGENTS.md 红线 + Sprint 11 设计稿 §4.4 红线。

---

## FROZEN 契约兼容点（对齐目标）

本目录的 fixture Service 形态**对齐** `agint.quality` FROZEN 契约的**形态约定**：

| 维度 | FROZEN（agint.quality） | fixture（agint.synth.*） |
|---|---|---|
| provide 命名 | `agint.quality`（单入口） | `agint.synth.{echo,badDeps}`（单入口） |
| 暴露 schemas | `agint.quality.schemas.{EvalTarget,EvalResult,...}` | `agint.synth.{echo,badDeps}.schemas.{Input,Output}` |
| version 元信息 | `QualityEvaluatorIface.version = '0.1.0'` | `fixture.version() → { name, version, kind: 'synth' }` |
| FROZEN 方法体 | `getConfig/setConfig/validatePatch` | **不实现**（避免误代契约实例） |

fixture 是**形态对齐**的合规证据，不是**实例冒充**——Sprint 11 §4.4 红线要求
"不修改 L0-frozen 字段"，fixture 自然不进入契约层。

---

## L0 隔离三项检查（fixture 设计依据）

设计稿 ADR-11-4 规定，新插件挂载前必须通过三项检查：

| # | 检查项 | 白名单 / 期望 | echo-tool | bad-deps |
|---|---|---|---|---|
| 1 | **签名兼容** | 与 FROZEN 契约零差异（Service 形态一致） | ✅ PASS | ✅ PASS（故意保留完整） |
| 2 | **域隔离** | 全新 `agint_synth_*` 域，不撞既有 | ✅ `agint_synth_echo` | ✅ `agint_synth_bad_deps` |
| 3 | **依赖白名单** | 仅 `{storageDomain, memory, metrics, cron}` | ✅ inject=[storageDomain] | ❌ 故意注入 `agint.qualitySandbox` |

---

## e2e 消费指南（给 codex-B / codex-D）

### codex-B：l0-isolation 静态扫描实现

```js
// linter 入口伪代码
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function l0IsolationCheck(fixtureDir) {
  const manifest = JSON.parse(
    readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')
  );

  return {
    signatureDiff: checkSignature(manifest),  // 项目 1
    domainIsolation: checkDomainIsolation(manifest),  // 项目 2
    dependencyWhitelist: checkDependencyWhitelist(manifest),  // 项目 3
  };
}
```

### codex-D：e2e 场景

| 场景 | 输入 fixture | 期望 phase |
|---|---|---|
| S11-01 | echo-tool | HEALTHY |
| S11-02 | bad-deps | REJECTED_PRE_STATIC（依赖白名单违规） |
| S11-08 | echo-tool（重复挂载） | 幂等返回既有 ticket |

---

## 版本

- v0.0.1 — Sprint 11 子任务 #3（codex-C）首版交付

## 相关链接

- 设计稿：`AGINT.wiki/Sprint11-设计稿 .md` §4.4（fixtures 来源）+ §七 风险表"测试变异污染真实种群"
- FROZEN 契约：`plugins/agint-quality/agint-quality-contract/lib/index.js`（`agint.quality` 服务）
- L0 隔离三项：`Sprint11-设计稿 .md` ADR-11-4
- PLUGIN-SPEC：`docs/plugins/PLUGIN-SPEC.md`（8 维度；fixtures 不适用 Tests / Changelog）