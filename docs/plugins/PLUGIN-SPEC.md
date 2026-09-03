# AGINT 插件准入规范（PLUGIN-SPEC）

> 任何要挂到 DSH 的 `cordis.patch.yml` → `- id:` 行的插件，必须满足本规范 8 个维度。
> 来自 2026-08-21 重启事故复盘 + 老板「什么算合格插件」的原话。
>
> 验证：`bin/plugin-check.sh <plugin-dir>`（lint 模式，不阻断只警告）
> 强制演进路径：lint（warn） → CI（warn） → deny

---

## TL;DR — 8 维度速查

| # | 维度 | 写在哪儿 | 谁来验 |
|---|---|---|---|
| 1 | **Contract** （inject / provides / events / tools） | `manifest.json → cordis` | `plugin-check.sh contract` |
| 2 | **Storage domains** （独占声明 + 与兄弟插件不重叠） | `manifest.json → storage` | `plugin-check.sh storage` |
| 3 | **Dependencies** （peerDeps 显式声明 + 挂载顺序敏感） | `manifest.json → dependencies` | `plugin-check.sh deps` |
| 4 | **Permissions** （要哪些 env / 文件 / 网络） | `manifest.json → permissions` | `plugin-check.sh permissions` |
| 5 | **Lifecycle** （所有 setInterval / setTimeout / 句柄必须 ctx.effect dispose） | 源码 lint | `plugin-check.sh lifecycle` |
| 6 | **Tests** （至少 1 个 smoke test，列在 `test/smoke.mjs`） | `test/` | `plugin-check.sh tests` |
| 7 | **Docs** （`README.md` + 关键 Service 一句话 + 1 个使用示例） | `README.md` | `plugin-check.sh docs` |
| 8 | **Changelog** （每次破环性变更写 `CHANGELOG.md`） | `CHANGELOG.md` | `plugin-check.sh changelog` |
| 9 | **Runtime-contract**（waterfall 监听器必须调 `next()`） | 源码 lint | `plugin-check.sh runtime-contract` |

---

## manifest.json Schema

放在插件根目录 `~/.dsh/profiles/web/plugins/agint-<name>/manifest.json`。

```jsonc
{
  "$schema": "./PLUGIN-SPEC.md#manifest-schema",
  "name": "agint-<kebab-case>",         // 必须以 agint- 开头，唯一
  "version": "0.1.0",                   // semver
  "description": "一句话讲清干什么 + 给谁用",
  "main": "lib/index.js",               // Cordis 入口

  "agint": {
    "kind": "host" | "client" | "both", // 跑在 host 还是 client
    "owner": "anmul",                   // 负责人
    "tier": 0,                          // 0=核心/系统服务, 1=能力插件, 2=实验
    "stability": "stable" | "beta" | "experimental"
  },

  // ── 1. Contract ──
  "cordis": {
    "inject": ["storageDomain"],        // 硬依赖哪些 host Service（不存在则 plugin 等到出现）
    "provides": ["agint.memory"],       // 自己 provide 的 Service 名字（agint.* 名字空间）
    "events": ["tools/post-execute"],   // 监听哪些 Cordis event
    "tools": ["memory_search"],         // 注册哪些 model-visible tool（要 model 平面才需）
    "optionalInject": ["agint.metrics"] // 软依赖，缺了降级而不阻塞
  },

  // ── 2. Storage ──
  "storage": {
    "domains": ["agint"],               // 独占打开的 storage domain（与其它插件不重叠）
    "schemaVersion": 1,                 // 写格式版本号，每次破环性变更 +1
    "atomic": "json" | "jsonl" | "sqlite" // 写策略（jsonl appender 不允许 schema 变更）
  },

  // ── 3. Dependencies ──
  "dependencies": {
    "agint-storage-domain": ">=0.1.0",  // 其它 agint 插件的版本要求
    "zod": "^3.0.0"                     // 第三方 npm 依赖
  },
  "mountOrder": 5,                      // 挂载顺序（0 最先），数字越大越后挂；同 tier 内串行

  // ── 4. Permissions ──
  "permissions": {
    "env": ["AGINT_HOME", "DSH_HOME"],  // 读哪些环境变量
    "fs": ["read:wiki", "write:reviews"], // 文件权限（read: / write: 前缀，glob 模式）
    "network": ["loopback"],      // loopback / intranet / internet
    "shell": false                      // 是否允许 spawn 子进程
  },

  // ── 5. Lifecycle guarantees (声明式，实际由 plugin-check.sh 静态扫源码验证) ──
  "lifecycle": {
    "intervals": "must-dispose",        // setInterval / setTimeout 必须 ctx.effect 注册 disposer
    "listeners": "must-dispose",        // ctx.on(...) 必须有对应 dispose
    "tools": "must-dispose",            // 注册的 tool 必须支持卸载
    "shutdown": "graceful"              // graceful | immediate
  },

  // ── 6. Tests ──
  "tests": {
    "entry": "test/smoke.mjs",          // 最小冒烟入口
    "command": "node test/smoke.mjs",   // 一行能跑
    "expectedExit": 0                   // 期望退出码
  },

  // ── 7. Docs ──
  "docs": {
    "readme": "README.md",              // 必须有
    "serviceDocs": {                    // 每个 provides 的 Service 一句话
      "agint.memory": "长/短期记忆读写 + 四级衰减扫描"
    }
  },

  // ── 8. Changelog ──
  "changelog": "CHANGELOG.md",          // 破环性变更必须写
  "compatSince": "0.1.0"                // 兼容到哪个版本（破环性变更后这里 +1 minor）
}
```

---

## 各维度的「为什么」和「不满足会怎样」

### 1. Contract
- **为什么**：cordis loader 现在是「写错就静默 pending」（`agint-quality-eval` 就是这么死的）。Contract 让 loader 知道这个插件在等谁、提供什么、被谁调用，**loader 才能报错而不是卡死**
- **不满足**：
  - 缺 `provides`：挂载成功但 model 完全看不到它的能力（僵尸插件）
  - 缺 `inject`：硬依赖会永远 pending，调度不起来

### 2. Storage
- **为什么**：`agint-memory` 独占 `agint` 域，`agint-rules` 独占 `agint_rules`——互斥关系靠人手维护，上次 `agint-evolve` 写入 `agint_evolution` 时差点撞 `agint-evolution-memory`
- **不满足**：两个插件争写同一个 domain，后写的覆盖前写的，丢数据

### 3. Dependencies
- **为什么**：`agint-quality-eval` 等待 `agint.evolution` 和 `agint.qualitySandbox`——但 cordis.patch.yml 里没人声明这个依赖，所以 loader 不知道何时能激活
- **不满足**：插件挂着但永不激活 / 顺序错导致 race condition

### 4. Permissions
- **为什么**：插件偷偷读 `$HOME/.ssh` 或 spawn shell 上次差点出事
- **不满足**：安全边界被绕过（AGENTS.md 红线）

### 5. Lifecycle
- **为什么**：上次重启崩的部分原因就是 in-flight `setInterval` 被 SIGKILL 截断，没有 disposer 触发清理。`agint-cron` 已经做了（`ctx.effect(() => tickHandle.dispose)`）但其它插件不一定
- **不满足**：graceful 重启变 SIGKILL 强杀，jsonl 截断、timer 泄漏

### 6. Tests
- **为什么**：插件挂上去没人验证就敢跑，等于在生产裸奔
- **不满足**：挂载即崩，没法定位是不是这个插件的问题

### 7. Docs
- **为什么**：13 个插件 0 个 README，老板自己都记不住谁干嘛
- **不满足**：再过 3 个月没人维护得动

### 8. Changelog
- **为什么**：破环性变更（storage schema 改、provides 重命名）不写就没法回滚
- **不满足**：旧版本消费者静默坏掉

### 9. Runtime-contract
- **为什么**：Cordis 有几个事件是 **waterfall（瀑布式）** —— `tools/pre-execute` / `tools/post-execute` / `tools/ptc-dispatch-log` / `agent/pre-step`。监听器必须调用 `next()` 把链传下去，否则瀑布结果为 `undefined`，dsh-tools 读 `decision.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，所有 preset 的所有工具调用全挂。
- **2026-09 教训**：`agint-event-bus` / `agint-mount` 各自注册了一个 `ctx.on('tools/post-execute', () => {})` 占位监听，挂载阶段不报错（loader 不知道该事件是不是 waterfall），运行时把 DSH web 全栈炸成 `reading 'kind'`。
- **正确写法**：

  ```js
  ctx.on('tools/post-execute', async (exec, result, next) => {
      return next();   // 或：先 await next() 再 return 基于它构造的决策
  });
  ```

- **不满足**：挂上去看着没事，实际第一次工具调用就崩，且崩在工具执行管线（看起来像工具坏了），排障要从 dsh-tools 反推回 plugin —— 成本巨大
- **验证**：`bin/plugin-check.sh` 维度 9 静态扫源码；perl 不可用时 `node bin/_verify-dim9.mjs <lib/index.js>` 兜底
- **新增 waterfall 事件**：同步更新 `bin/plugin-check.sh` 的 `$waterfall_pat` 列表

---

## 准入流程（plugin 作者照做）

```sh
# 1. 复制一个最近期的 manifest.json 模板
cp bin/plugin-check.sh.template ~/.dsh/profiles/web/plugins/agint-myname/manifest.json

# 2. 填 9 个维度（8 + runtime-contract）

# 3. 跑 lint（不阻断，只列缺失项）
bin/plugin-check.sh ~/.dsh/profiles/web/plugins/agint-myname/

# 4. 跑通才挂载
#    在 cordis.patch.yml 加 - id: agint-myname 行
bin/safe-update.sh mount-patch   # 拍快照
bin/safe-update.sh restart       # 优雅重启
```

---

## 已有插件的改造路径

13 个现有插件按 `manifest-baseline/` 下的草案模板做最小填充（已经生成），老板 review 后逐个 commit。逐步补全 8 维度，**不强求一次到位**，每个维度都是 L1 起步，按 lint 报告逐步补。

---

## 关联

- `docs/operations/safe-update-sop.md` —— 挂载前必拍快照
- `docs/operations/dsh-restart-incident-20260821.md` —— SOP 起源
- `bin/plugin-check.sh` —— 自动验收脚本（9 维度）
- AGINT rule `agint-plugin-missing-manifest` —— 写 plugins/ 缺 manifest 时 advisory
- Memory `plugin-spec-9-dimensions` (L1) —— 9 维度是规范核心（2026-09 增）
- Memory `safe-update-sop-mandatory` (L1) —— 挂载前必拍快照
- Skill `plugin-preflight` —— 5 步准入工作流