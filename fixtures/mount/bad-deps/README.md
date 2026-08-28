# agint-synth-bad-deps（故意违规 fixture）

> ## ⚠️⚠️⚠️ 故意违规 fixture — 仅用于 l0-isolation 测试 ⚠️⚠️⚠️
>
> **本目录的所有文件都是 Sprint 11 §4.4 指定的"故意违规测试变异"——它们存在的唯一目的是被 L0 隔离规则组（l0-isolation）静态扫描并拒绝。**
>
> 不要尝试挂载、加载、或运行本 fixture 的任何代码。

Sprint 11 设计稿 §4.4 指定的**故意违规测试变异**，用于：

| 场景 | 期望 |
|---|---|
| **S11-02** | 静态门禁拒绝：产物含非白名单依赖 → phase 停在 PREPARE 前，staging 清理，无沙箱消耗 |

> 老板拍板（2026 智进子任务 #3）：**只保留「依赖白名单」单项违规**——
> 让 l0-isolation 拒绝路径精准定位到这一项，便于 e2e 诊断。
> 签名兼容 + 域隔离都保持 PASS。

## 红线（先看红线，且比 echo-tool 更严）

1. **永不被挂载**到任何 `cordis.patch.yml`
2. **永不被** `bin/safe-update.sh` 任何子命令引用
3. **永不被** `cordis_run` / `cordis_define` / `cordis_inspect_self` 加载
4. **永不被**任何 dsh runtime 进程加载（即使 sandbox explore 模式也不行）
5. **永不入** `agint-population` 锦标赛
6. **永不入** `agint.quality` FROZEN 契约
7. **唯一消费方式**：静态扫描（AST / 正则 / manifest 解析）

详见 [`../README.md` 红线章节](../README.md)。

## 故意违反的 L0 隔离项（只 1 项，必须 100% 被 l0-isolation 检出）

| # | 违规类型 | 字段 | 违规值 | 白名单/期望 | 设计稿依据 |
|---|---|---|---|---|---|
| 1 | **依赖白名单** | `spec.cordis.inject` | `"agint.qualitySandbox"` | `{storageDomain, memory, metrics, cron}` | §4.4 / ADR-11-4 第 3 条 |

> 故意**保留**签名兼容项 + 域隔离项 PASS——让 l0-isolation 拒绝路径**精准定位**到依赖白名单这一项。如果三项一起坏，e2e 难以诊断是哪个检查在工作。

### 为什么不选 `agint.qualityStatic` / `agint.qualityEval`

老板授权三选一，我挑 **`agint.qualitySandbox`**：
- 设计稿 §4.4 / ADR-11-4 第 3 条原文点名的是"agint-quality-* 内部模块"
- `agint.qualitySandbox` 是 quality-* 系列里**最重**的（动态门禁后端，承接 mount 编排的 verify/explore 双模式）
- 沙箱违规被检出 = 同时证明 l0-isolation 能拦下"挂载产物绕开沙箱直连"这种最危险的攻击面
- 静态检查检出它也最有现实意义：sandbox 是被 Sprint 10 / Sprint 11 都反复点名的安全边界

## 文件结构

```
bad-deps/
├── package.json           # name: agint-synth-bad-deps, version: 0.0.1
├── cordis.patch.yml       # loader 行模板（违规声明在 manifest，不在 patch）
├── manifest.json          # ⚠️ 故意把 inject 写非法值；storage.domains 留空（合规）
├── src/
│   └── index.js           # ⚠️ 顶部大写警告 + apply(ctx) 故意访问非法 service
└── README.md              # 本文件
```

## Service 接口（占位，形态对齐 echo-tool）

| 方法 | 签名 | 备注 |
|---|---|---|
| `version()` | `() → { name, version, kind: 'synth', storageDomain, intentionallyViolating }` | 与 echo-tool 形态一致 |
| `schemas` | `{ Input: zod, Output: zod }` | 与 echo-tool 形态一致 |
| `doNothing()` | `() → { marker, ts }` | noop 占位 Service |

## 存储域（合规）

- 域名：`agint_synth_bad_deps`（全新 `agint_synth_*` 前缀，**不**触发域隔离违规）
- 表：`marker`（key=ts，value=OutputSchema）

## 依赖（故意违规）

- `cordis.inject`：`['storageDomain', 'agint.qualitySandbox']` ⚠️
- 违规值：`agint.qualitySandbox`（不在白名单 `{storageDomain, memory, metrics, cron}` 内）
- 源码内额外调用 `ctx.get('agint.qualitySandbox')` 作为第二层证据（即便 manifest 字段被 lint 跳过，AST 扫描也能命中）

## e2e 消费方式（给 codex-B / codex-D）

### B 侧：l0-isolation 静态扫描

```js
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync('./fixtures/mount/bad-deps/manifest.json', 'utf8')
);

// ── 检查 1：依赖白名单 ──
const WHITELIST = new Set(['storageDomain', 'memory', 'metrics', 'cron']);
const violatingInject = manifest.spec.cordis.inject.filter(
  (s) => !WHITELIST.has(s)
);
assert(violatingInject.includes('agint.qualitySandbox'));
// 期望：l0-isolation 报告 violations=['agint.qualitySandbox']

// ── 检查 2：签名兼容（应 PASS，让拒绝路径精准定位到上面那项） ──
assert(manifest.spec.cordis.provides.includes('agint.synth.badDeps'));

// ── 检查 3：域隔离（应 PASS，使用全新合成域） ──
assert(manifest.spec.storage.domains.every((d) => d.startsWith('agint_synth_')));
```

### D 侧：e2e S11-02

```js
// S11-02：phase 应停在 PREPARE 前
const result = await agintMount.request(proposalFor('bad-deps'));
assert(result.phase === 'REJECTED');              // 静态门禁拒绝
assert(result.contractCheck.dependencyWhitelist === false);  // 单项拒绝
assert(result.contractCheck.signatureDiff === true);        // PASS
assert(result.contractCheck.domainIsolation === true);      // PASS
```

## 版本

- v0.0.1 — Sprint 11 子任务 #3（codex-C）首版交付