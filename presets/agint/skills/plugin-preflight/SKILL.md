---
name: plugin-preflight
description: "新增 / 修改 agint-* 插件挂到 cordis.patch.yml 前的强制准入工作流。10 分钟搞定，比挂上去再崩 30 分钟排障便宜十倍。涉及任何 plugin 源码变更、新插件创建、cordis.patch.yml 新增 - id 行时调用。"
---

# 插件准入预检（Plugin Preflight）

把任何 agint-* 插件挂到 `cordis.patch.yml` 之前必须走完这条流水线。本 skill 是 PLUGIN-SPEC 8 维度的「**事中**」兜底，**事前**已经做了还不够 —— 因为 lint 只能看到静态源码，看不到运行时 waterfall 契约。

## 为什么需要 preflight

> **2026-09 全栈事故**：agint-event-bus 和 agint-mount 各自注册了一个 `ctx.on('tools/post-execute', () => {})` 占位监听。loader 在挂载阶段不报错（loader 不知道这是 waterfall），但每次工具调用时瀑布链断在占位监听、结果变 `undefined`，dsh-tools 读 `decision.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，**所有 preset、所有 session 的工具调用全挂**。

8 维度 lint 帮不到 waterfall 契约 —— 它是第 9 维度（**runtime-contract**）。

## 工作流（5 步，强顺序）

### 第 1 步：lint 全 9 维度

```sh
bin/plugin-check.sh --all
```

预期：`0 fail`。任何 fail 即 abort，挂载流程不进入第 2 步。

如果机器没装 perl 跑不了新维度 9 的扫描，退到 `node` 镜像：

```sh
node bin/_verify-dim9.mjs plugins/agint-<name>/lib/index.js
```

新增的 waterfall 监听必须满足：
- **监听器体非空**
- **体里出现 `next(` 调用**（独立 token，避免误中 `nextStep` / `nextTick`）

正确写法：
```js
ctx.on('tools/post-execute', async (exec, result, next) => {
  return next();   // 或：先 await next() 再 return 基于它构造的决策
});
```

❌ 禁：
```js
ctx.on('tools/post-execute', () => {});                          // 空体
ctx.on('tools/post-execute', async () => { /* TODO */ });        // 体非空但没 next
ctx.on('tools/post-execute', (exec, result) => { ... });         // 缺 next 参数
```

已知 waterfall 事件名（DSH 文档声明）：
- `tools/pre-execute`（allow / deny / ask）
- `tools/post-execute`（inspect / replace / attach context）
- `tools/ptc-dispatch-log`（持久日志副本的同款约束）
- `agent/pre-step`（UserPromptSubmit 模拟）

新增 waterfall 事件时同步更新 `bin/plugin-check.sh` 里的 `$waterfall_pat`。

### 第 2 步：写一个**最小冒烟 fixture**

放在 `plugins/agint-<name>/test/smoke.mjs`（或在已有 manifest 里改 `tests.entry`）：

```js
// 至少验证三件事：
// 1. 加载不抛（require('./lib/index.js')）
// 2. apply(ctx) 在 fake ctx 上不抛
// 3. 若声明 waterfall 监听：fake ctx 上触发一次事件，断言决策结构正确
```

不要满足于「能 import」 —— waterfall 契约的破坏只有在事件触发时才显现。

#### 第 2 步补强（v0.4 新增）：跨平台 fixture

若 plugin 的 `permissions.fs` 非空（涉及文件系统路径），smoke **必须**额外覆盖**跨平台路径 case** —— 既测 forward-slash 相对路径（典型：模型/工具传参风格）也测 native-sep 根（典型：`resolve()` 在 Windows 返回 `D:\...`）。原因：v0.4 agint-wiki 教训里，`clean()` 用 `abs.startsWith(root + '/')` 检查越界在 Linux/macOS 永远成立，在 Windows 永远不成立，仓内 master 一直绿但 Windows 上一跑全挂。

参考模板（agint-wiki v0.4 test/smoke.mjs 的正向 + 负向 case）：

```js
// 正向：forward-slash 相对路径必须 accept
const checks = [
  ['basename', 'hello.md', '# hi\n'],
  ['nested',   'sub/dir/note.md', '# note\n'],
  ['leading-slash stripped', '/leading.md', '# l\n'],
];
for (const [label, relPath, content] of checks) {
  await wiki.write(relPath, content);
  const back = await wiki.read(relPath);
  assert.equal(back.content, content);
}

// 负向：相对路径 escape 必须 reject（路径安全不能因为 fix 而削弱）
for (const evil of ['../escape.md', '../../etc/passwd.md']) {
  await assert.rejects(() => wiki.write(evil, 'evil'), /path escapes root/);
}
```

plugin-check.sh 在 dim9 扫描外会追加一条 **soft warning**（不阻断）：若 `manifest.spec.permissions.fs` 非空但 smoke 没出现 `'foo/bar.md'` / `'../escape.md'` 这类字符串字面量，提示「建议加跨平台 fixture」。

### 第 3 步：跑 smoke

```sh
node plugins/agint-<name>/test/smoke.mjs
```

预期 exit 0。任何非 0 即 abort。

### 第 4 步：diff + manifest 完整性自查

提交前自查：
- `manifest.json` 8 维度 + 9 维度全填齐
- `README.md` 里 provides 一句话 + 一个使用示例
- `CHANGELOG.md` 写清楚破环性变更
- `package.json` 里有 semver 版本号
- 没有裸 `setInterval` / `setTimeout` —— 必须 `ctx.effect` 注册 disposer

### 第 5 步：safe-update 走完整挂载流程

```sh
bin/safe-update.sh smoke         # 当前 prod 状态冒烟
bin/safe-update.sh mount-patch   # 拍 4 份快照（patch / preset / plugins tar / storages）
# 编辑 profile-patches/web/cordis.patch.yml（按 AGENTS.md 红线：顶层 patch 改动必须走 SOP）
bin/safe-update.sh restart       # 优雅重启（SIGTERM，让 fiber dispose 跑完）
cat sentinel.lease                # 看 at < 30s
```

崩了就 `plugin → patch → preset` 倒序回滚（详见 `docs/operations/safe-update-sop.md`）。

## 与现有 skill 的关系

| Skill | 在 preflight 里扮演 |
|---|---|
| `editing-cordis-compositions` | 第 5 步编辑 cordis.patch.yml 时调用 —— 它管 plane / realm 规则 |
| `cordis-plugin-development` | 第 1~3 步的实现细节 —— `ctx.on / ctx.effect / inject` API |
| `memory-discipline` | 写完一个新插件模式，沉淀为 lesson / pattern |

## 输出契约

preflight 完成的标志是 `bin/plugin-check.sh --all` 全绿 + smoke exit 0 + 第 5 步 4 份快照齐。在 SOP 工具栈里留任何一步没做都等于"裸挂"。

## 关联

- `docs/plugins/PLUGIN-SPEC.md` —— 9 维度规范
- `bin/plugin-check.sh` —— lint 入口
- `bin/_verify-dim9.mjs` —— 维度 9 的 node 镜像（perl 不可用时）
- `bin/safe-update.sh` —— 第 5 步的 SOP
- `docs/operations/dsh-restart-incident-20260821.md` —— SOP 起源
- `docs/operations/safe-update-sop.md` —— 完整 4 份快照 SOP
- Memory `plugin-spec-9-dimensions`（沉淀目标）
