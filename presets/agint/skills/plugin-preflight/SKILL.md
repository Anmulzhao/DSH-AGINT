---
name: plugin-preflight
description: "agint-* 插件挂载 / 源码变更的强制准入工作流。10 分钟搞定，比挂上去再崩 30 分钟排障便宜十倍。涉及任何 plugin 源码变更、存量插件改常量/provider/默认值、新插件创建、cordis.patch.yml 新增 - id 行时调用。"
tools:
  - bin/plugin-check.sh
  - bin/check-wiring.mjs
  - safe-update.sh
  - node
triggers:
  - "新增/修改 agint-* 插件挂到 cordis.patch.yml 前"
  - "任何 plugin 源码变更、新插件创建"
  - "改存量插件的常量 / provider / 默认模型值"
  - "cordis.patch.yml 新增 - id 行"
related_skills:
  - editing-cordis-compositions
  - cordis-plugin-development
  - memory-discipline

---

# 插件准入预检（Plugin Preflight）

**适用两种场景**（2026-09-28 补充）：

| 场景 | 典型动作 | 差异 |
|---|---|---|
| **A. 挂新插件** | 新建 `plugins/agint-<name>/`、往 `cordis.patch.yml` 加 `- id` 行 | 走满 5 步 |
| **B. 改存量插件** | 改已挂载插件的常量 / provider / 默认值 | 第 2 步通常**免写**（已有 smoke），但第 5 步的**双副本同步是硬要求**，见下 |

本 skill 是 PLUGIN-SPEC 8 维度的「**事中**」兜底，**事前**已经做了还不够 —— 因为 lint 只能看到静态源码，看不到运行时 waterfall 契约。

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

### 第 5 步：走完整挂载 / 上线流程

**先分清编辑目标**（2026-09-28 实测澄清）。仓库源码与 host 部署位是**两份独立副本**，不是链接：

```
仓库真源  <repo>/plugins/agint-*/lib/*.js
mirror 位  $DSH_HOME/profiles/web/plugins/agint-*/lib/*.js        ← preset tools 引用
bundle 位  $DSH_HOME/profiles/web/node_modules/@agint/host/plugins/agint-*/lib/*.js  ← 服务真正加载
```

**正确顺序：改仓库 → 同步到 mirror 位 + bundle 位 → 重启。**
只改 host 两份 = 下次部署静默回退；只改仓库不同步 = 服务跑的仍是旧代码且**不报错**。

> ⚠️ 两份副本只同步一处 = **静默分叉**（两个模块实例、状态不共享、不抛错）。`bin/check-wiring.mjs` 查 E 会报 `DIVERGED` 并 exit 1。改完必跑。

```sh
bin/safe-update.sh smoke         # 当前 prod 状态冒烟
bin/safe-update.sh edit-source   # 改源码时用这个（拍快照）
bin/safe-update.sh mount-patch   # 改 cordis.patch.yml 时用这个（拍快照）
# 编辑仓库 <repo>/plugins/... 与 <repo>/profile-patches/web/cordis.patch.yml
# 然后同步双副本，并用 check-wiring 验证：
node bin/check-wiring.mjs         # 查 E 双副本 + 查 H 仓库↔部署，查 I 漂移插件 smoke
```

**快照必须自己核实产物。** 2026-09-28 修掉一个静默失效：`compgen -G` 对 Windows 混合分隔符路径恒 MISS，`snapshot_plugins` 走「跳过」分支只打一行 warning 却 **exit 0** —— 改了源码却没回滚点，而调用方以为拍成功了。同源第二个坑：`tar` 把 `C:` 当远程主机前缀 → `Cannot connect to C: resolve failed`，因脚本无 `set -e` 仍打印 ✓（假成功）。两处已在 `bin/safe-update.sh` 修掉（`cygpath` 归一化 + 判据改 `cd` 后 `ls -d` + tar 失败即 `fail`），但**升级到旧版脚本的机器上仍会复发**，所以照例核对：

```sh
ls -la "$DSH_HOME/.agint-backups"/agint-plugins-*.tar.gz | tail -1
tar tzf <上面那个 tar> | grep -c '^agint-[^/]*/$'   # 应等于已挂载插件数（本机 35）
```

**重启 —— 首选 `restart_request` 工具，不要用 `safe-update.sh restart`：**

```sh
# ✅ 首选：restart_request 工具（agint-restart 插件 v0.2.0+）
#   三重护栏（confirm + 冷却期 + 熔断）、dryRun 可先看计划、--no-open、sideEffect 回报
# ❌ safe-update.sh restart：Windows Git Bash 缺 pgrep/pkill
#   graceful_stop_dsh 空转不报错 → start_dsh 拉起第二个实例抢 3080
# （历史备选 bin/restart-runbook.ps1 已于 2026-09-28 废弃删除，勿再引用）
```

重启后验收用 `restart_status` 的时间戳差，而不是 sentinel.lease（后者在部分机器上不生成）：

```
lastRestart=07:43:49.992Z   boot=07:44:00.352Z   → 启动延迟 ≈10.4s（红线 <30s）
lastResult=ok=true ready=true
```

崩了就 `plugin → patch → preset` 倒序回滚（详见 `docs/operations/safe-update-sop.md`）。

## 与现有 skill 的关系

| Skill | 在 preflight 里扮演 |
|---|---|
| `editing-cordis-compositions` | 第 5 步编辑 cordis.patch.yml 时调用 —— 它管 plane / realm 规则 |
| `cordis-plugin-development` | 第 1~3 步的实现细节 —— `ctx.on / ctx.effect / inject` API |
| `memory-discipline` | 写完一个新插件模式，沉淀为 lesson / pattern |

## 输出契约

preflight 完成的标志是：`bin/plugin-check.sh --all` 无**新增** fail（既存 fail 记基线再对比，不是要求绝对 0）+ smoke exit 0 + `check-wiring.mjs` PASS + 第 5 步快照**经 tar 条目数核实**齐备。

> 基线对比：本机仓库有 **4 个既存 fail**（1×K19 schema + 3×manifest 缺失），与本次改动无关。判据是「改动前后 fail 数与清单是否一致」，不是「必须 0」。

**改存量插件（场景 B）另加一条硬验收：真实调用一次，证明默认路径解析正确。** smoke 与单测证明不了这件事 —— 断言常量的单测在改常量后必然自证通过，smoke 全是 mock，check-wiring 只管文件一致性。只有真实 LLM call 才能证明运行时路由到了新值。

例：`dream_verify_consolidation` 返回 `mode=llm · schemaOk=true · provider=… model=…`，`mode=llm` 即真调用（非兜底）。

## 关联

- `docs/plugins/PLUGIN-SPEC.md` —— 9 维度规范
- `bin/plugin-check.sh` —— lint 入口
- `bin/_verify-dim9.mjs` —— 维度 9 的 node 镜像（perl 不可用时）
- `bin/safe-update.sh` —— 第 5 步的 SOP
- `docs/operations/dsh-restart-incident-20260821.md` —— SOP 起源
- `docs/operations/safe-update-sop.md` —— 完整 4 份快照 SOP
- Memory `plugin-spec-9-dimensions`（沉淀目标）
