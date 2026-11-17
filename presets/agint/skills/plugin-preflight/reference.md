# plugin-preflight 参考材料

长代码示例、事故背景推导、完整输出样例、关联清单与分工。与 SKILL.md 同目录；用 read 工具打开（本会话 skill 加载返回的 Base directory 即技能基目录）。

## 1. 为什么要 preflight —— 2026-09 全栈事故

agint-event-bus 和 agint-mount 各自注册了一个 `ctx.on('tools/post-execute', () => {})` 占位监听。loader 在挂载阶段不报错（loader 不知道这是 waterfall），但每次工具调用时瀑布链断在占位监听、结果变 `undefined`，dsh-tools 读 `decision.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，**所有 preset、所有 session 的工具调用全挂**。

8 维度 lint 帮不到 waterfall 契约 —— 它是第 9 维度（**runtime-contract**）。

## 2. waterfall 监听写法（第 1 步的判据）

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

## 3. 最小冒烟 fixture 模板（第 2 步）

```js
// 至少验证三件事：
// 1. 加载不抛（require('./lib/index.js')）
// 2. apply(ctx) 在 fake ctx 上不抛
// 3. 若声明 waterfall 监听：fake ctx 上触发一次事件，断言决策结构正确
```

### 跨平台 fixture 模板（agint-wiki v0.4 test/smoke.mjs 的正向 + 负向 case）

补强 A 的原因（v0.4 agint-wiki 教训）：`clean()` 用 `abs.startsWith(root + '/')` 检查越界在 Linux/macOS 永远成立，在 Windows 永远不成立，仓内 master 一直绿但 Windows 上一跑全挂。

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

## 4. 静默零事故 —— 2026-09-29 agint-input-gateway

agint-input-gateway 的 self-observation channel 5 个检测器里 4 个恒返回 0 —— 判定条件读的是自造字段（`status==='error'`、`errorCount`、`severity`），真实存储却是 `agint_tool_stats.jsonl` 的 boolean `ok`，以及 metrics / rules 里 `tables.*[uuid]` 下按 `id,key,label,value` 记的条目、规则用的是 `level`（L1-L4）不是 `severity`。结果是 force_fetch `ok=true in=0 emitted=0`、errors=0，**看起来健康，其实静默失明**：lint 全绿、smoke exit 0，全绿掩盖了失明。

## 5. 字节保真事故与取原始字节的正确做法（第 4 步）

编辑工具会静默剥掉 UTF-8 BOM 并把换行统一规范化。一个只改一行的 render 修复曾被撑成 `172 insert / 169 delete` 的全文件 diff。

不要用 `git show HEAD:file`（PowerShell 5.1 的管道会转码 LF→CRLF）。改用 `cat-file` 并直接读字节流：

```powershell
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "git"; $psi.Arguments = 'cat-file blob "HEAD:<path>"'
  $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $ms = New-Object System.IO.MemoryStream
  $p.StandardOutput.BaseStream.CopyTo($ms); $p.WaitForExit(); $b = $ms.ToArray()
  ```

还原：`[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))`，再按实测的原始字节约定重建尾部。

## 6. 第 5 步的细节

### 三处副本的关系

```
仓库真源  <repo>/plugins/agint-*/lib/*.js
bundle 位  $DSH_HOME/.agint-bundle/plugins/agint-*/lib/*.js        ← 服务真正加载 + preset 工具行锚这
mirror 位  $DSH_HOME/profiles/<profile>/plugins/agint-*/lib/*.js   ← 兼容镜像位（v0.14.0 起不再被引用）
          （2026-10-01 起实体在 bundle；$DSH_HOME/profiles/<p>/node_modules/@agint/host
            是指过去的软链，写旧路径也能通，但别再往那儿手工放文件——
            pnpm 会按 dependencies 重算它）
```

两份副本只同步一处 = **静默分叉**（两个模块实例、状态不共享、不抛错）。`bin/check-wiring.mjs` 查 E 会报 `DIVERGED` 并 exit 1。

### `install/redeploy.sh` 依次做的事

`install.sh` → 部署位核验（挂载声明数 / `@agint/host` 注册 / 软链 / `profile.json` / 四套 preset 逐份查锚点且镜像位必须为 0 / 母 preset 与仓库逐字对比 / `check-preset-parity`）→ 按端口取 pid 重启 → 启动后核验（无 `skipping profile bundle` / agint 日志行 / cron job 数 / token 入口 / storage 落盘）。任一步不过就**不重启**（fail-closed）。

### 改前拍快照 + 部署的完整命令形态

```sh
bin/safe-update.sh smoke         # 当前 prod 状态冒烟
bin/safe-update.sh edit-source   # 改源码前用这个（拍快照 + 拿回滚点）
bin/safe-update.sh mount-patch   # 改 cordis.patch.yml 前用这个（拍快照）
# 编辑仓库 <repo>/plugins/... 与 <repo>/cordis.patch.yml（部署位副本别手改）
./install/redeploy.sh            # 铺部署位 + 核验 + 重启，一条命令
node bin/check-wiring.mjs        # 查 E 双副本 + 查 H 仓库↔部署，查 I 漂移插件 smoke
```

### 快照必须自己核实产物

2026-09-28 修掉一个静默失效：`compgen -G` 对 Windows 混合分隔符路径恒 MISS，`snapshot_plugins` 走「跳过」分支只打一行 warning 却 **exit 0** —— 改了源码却没回滚点，而调用方以为拍成功了。同源第二个坑：`tar` 把 `C:` 当远程主机前缀 → `Cannot connect to C: resolve failed`，因脚本无 `set -e` 仍打印 ✓（假成功）。两处已在 `bin/safe-update.sh` 修掉（`cygpath` 归一化 + 判据改 `cd` 后 `ls -d` + tar 失败即 `fail`），但**升级到旧版脚本的机器上仍会复发**。

### 重启三条路的完整命令

```sh
# ✅ 常态：一条命令搞定装 + 核验 + 重启
./install/redeploy.sh
# ✅ 只重启不动文件
#   restart_request（工具）
# ✅ 回滚
#   bin/safe-update.sh rollback 20261026-233000
# ⚠️ safe-update.sh restart 2026-10-26 已修「dsh 不在 PATH ⇒ 服务停在停止态」与
#    「pgrep -f 'dsh web' 命中脚本自身」，Linux 可用；但 Windows Git Bash 缺 ss / pgrep，
#    那条路径仍不可靠 —— Windows 上走 restart_request。
# （历史备选 bin/restart-runbook.ps1 已于 2026-09-28 废弃删除，勿再引用）
```

### 重启后验收输出样例

用 `restart_status` 的时间戳差判定，不用 sentinel.lease：

```
lastRestart=07:43:49.992Z   boot=07:44:00.352Z   → 启动延迟 ≈10.4s（红线 <30s）
lastResult=ok=true ready=true
```

### 场景 B 为什么必须真实调用一次

smoke 与单测证明不了默认路径是否解析正确——断言常量的单测在改常量后必然自证通过，smoke 全是 mock，check-wiring 只管文件一致性。只有真实 LLM call 才能证明运行时路由到了新值。

### 宿主真源与漂移实例

常量必须与目录里的 id 逐字一致——真源是 profile 的 `cordis.patch.yml`：`llm-pi-ai.providers.<provider>.models[].id` 与 `agent-default-model` 行。本机 minimax-cn 只注册 `MiniMax-M3.1-Flash-Preview`，插件里写 `MiniMax-M3.1-Flash` 就是漂（2026-10-28 agint-dream P1 consolidation 即栽在这里，P1 从未真正跑通）。`ctx.get('agentDefaultModel')?.currentSelection?.()` 返回 `{ provider, model, reasoningEffort }`，路由优先级 **显式入参 > agentDefaultModel.currentSelection() > 兜底常量**。判据落在真实调用：`mode=failed` / `schemaOk=false` ⇒ 模型 id 不在运行期目录里，此时常量改对了也不算数。

真实调用示例：`dream_verify_consolidation` 返回 `mode=llm · schemaOk=true · provider=… model=…`，`mode=llm` 即真调用（非兜底）。「把硬编码换成另一份硬编码」不算修复——仓内多个插件的默认值注释写着「host 注册模型已是 X（Y 不可路由）」，注释本身也会过期。

## 7. 关联清单

- `docs/plugins/PLUGIN-SPEC.md` —— 9 维度规范
- `bin/plugin-check.sh` —— lint 入口
- `bin/_verify-dim9.mjs` —— 维度 9 的 node 镜像（perl 不可用时）
- `install/redeploy.sh` —— 第 5 步的常态路径（装 + 部署位核验 + 重启 + 启动后核验）
- `bin/safe-update.sh` —— 改前快照与倒序回滚（部署别用它）
- `docs/operations/dsh-restart-incident-20260821.md` —— SOP 起源
- `docs/operations/safe-update-sop.md` —— 完整 4 份快照 SOP
- Memory `plugin-spec-9-dimensions`（沉淀目标）

## 8. 与现有 skill 的分工

| Skill | 在 preflight 里扮演 |
|---|---|
| `editing-cordis-compositions` | 第 5 步编辑 cordis.patch.yml 时调用 —— 它管 plane / realm 规则 |
| `cordis-plugin-development` | 第 1~3 步的实现细节 —— `ctx.on / ctx.effect / inject` API |
| `memory-discipline` | 写完一个新插件模式，沉淀为 lesson / pattern |
