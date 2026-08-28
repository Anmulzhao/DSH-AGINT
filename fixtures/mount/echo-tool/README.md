# agint-synth-echo（合规 fixture）

> **本目录是一个离线测试夹具，不是可挂载插件。**

Sprint 11 设计稿 §4.4 指定的**合规测试变异**——最小 Cordis 插件包，用于
`agint-mount` 的快乐路径 e2e：

| 场景 | 期望 |
|---|---|
| **S11-01** | 合规 TOOL_SYNTHESIS 变异走完 `static → sandbox → mount → population`，phase=HEALTHY |
| **S11-08** | 同名插件重复挂载：幂等拒绝，返回既有 ticket |

## 红线（先看红线）

1. **永不被挂载**到 `$DSH_HOME/profiles/web/cordis.patch.yml`
2. **永不被** `bin/safe-update.sh mount-patch` 引用
3. **永不被** `cordis_run` / `cordis_define` 加载
4. **永不进入** `agint-population` 锦标赛统计
5. **永不参与**任何真实运行时调用

详见 [`../README.md` 红线章节](../README.md)。

## 文件结构

```
echo-tool/
├── package.json           # name: agint-synth-echo, version: 0.0.1
├── cordis.patch.yml       # loader 行模板（仅供 e2e 离线解析）
├── manifest.json          # PLUGIN-SPEC 8 维度（合规声明）
├── src/
│   └── index.js           # apply(ctx) — provide 'agint.synth.echo'
└── README.md              # 本文件
```

## Service 接口签名（`agint.synth.echo`）

| 方法 | 签名 | 备注 |
|---|---|---|
| `version()` | `() → { name, version, kind: 'synth', storageDomain }` | 与 FROZEN `QualityEvaluatorIface.version` 字段形态对齐 |
| `schemas` | `{ Input: zod, Output: zod }` | 与 FROZEN `agint.quality.schemas` 命名对齐 |
| `echo(input)` | `({ text: string }) → { text, ts, instanceId }` | 回显 + 写入 echo 表 |
| `list()` | `() → [{ id, text, ts, instanceId }]` | 读 echo 表全部记录 |

## 存储域

- 域名：`agint_synth_echo`（全新 `agint_synth_*` 前缀，符合 L0 域隔离）
- 表：`echo`（key=instanceId，value=OutputSchema）
- schemaVersion：1
- atomic：json（单 key put/delete）

## 依赖白名单

- `peerDeps`：`zod`（schema 校验）+ `@deepseek-ai/dsh-storage-domain`（域定义）
- `cordis.inject`：**仅** `storageDomain`（dsh runtime 必注入）
- **零** `agint.*` host service 依赖（连白名单内的 memory/metrics/cron 都不注入）

## L0 隔离三项合规证据

| 检查项 | 期望 | 本 fixture 表现 |
|---|---|---|
| 签名兼容 | 与 FROZEN 契约零差异 | ✅ Service 形态（provide + schemas + version）= 0 差异 |
| 域隔离 | 全新 `agint_synth_*` 域 | ✅ `agint_synth_echo`（不撞 `agint_meta`） |
| 依赖白名单 | 仅白名单（memory/metrics/cron 等） | ✅ 注入列表为空（白名单内"零依赖"也是合规） |

## e2e 消费方式（给 codex-D）

```js
// 静态扫描 fixture（不挂载 dsh runtime）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(
  readFileSync('./fixtures/mount/echo-tool/manifest.json', 'utf8')
);

// 断言 L0 隔离三项
assert(manifest.spec.cordis.provides.includes('agint.synth.echo'));
assert(manifest.spec.storage.domains.every((d) => d.startsWith('agint_synth_')));
assert(
  manifest.spec.cordis.inject.every((s) =>
    ['storageDomain'].includes(s) || s.startsWith('agint.')
  )
);
```

## 版本

- v0.0.1 — Sprint 11 子任务 #3（codex-C）首版交付