---
name: preset-change-verification
description: Use whenever you add, remove, or edit a row in an agent preset, a bundle patch, or a plugin composition — and before you claim the change works. Covers verifying that a preset actually MOUNTS (not merely parses), why `dsh --dump-config` cannot be used as acceptance, how to get runtime errors when host logs are missing, and the common ways a preset silently vanishes or fails to activate.
triggers:
  - "改 preset / 加插件行 / 调 bundle patch 后要确认能用"
  - "preset 在 UI 里看不到 / 显示加载失败"
  - "agint preset 消失了 / 只剩 standard ptc minimal cordis"
  - "需要验证组合改动是否真的生效"
---

# 验证 preset / 插件改动

本文件回答一个问题：**我怎么才能确定这次改动真的能跑，而不是只是写得对。**

2026-10-20 的实战教训：一个 preset 改坏了，用 `--dump-config` 连续六轮「验收通过」，
最后靠用户截图才看到真实报错。根因就是**验收层级与错误层级不匹配**。

---

## 一、核心原则：验收层级必须匹配错误层级

| 你想证明 | 唯一可信工具 | 不可用的替代品 |
|---|---|---|
| YAML 语法正确 | `--dump-config` | — |
| 配置树结构正确 | `--dump-config` | — |
| **插件真的能 activate** | **真 mount 一次，看 stderr** | ❌ `--dump-config` 退出码 0 |
| 工具真的出现在会话里 | 新开一行会话，看工具表 | ❌ 配置树里有这一行 |

> ⛔ **硬规则**：`dsh --dump-config` 退出码 0 **永远不能**作为「改好了」的证据。
> 它从不执行插件，只拼 YAML。用它验收 = 用语法正确证明程序正确。

### 为什么这个错误特别隐蔽

很多配置项的校验发生在 **activate 阶段**，dump 阶段完全看不到。真实案例：

```
tool-subagent standing `modelSelectionSettings` requires a scoped preset Context
```

这个键写在 YAML 里语法完全合法、dump 完全通过，
但它要求组内能拿到外部 scoped preset Context。**只有真 mount 才会抛。**

---

## 二、标准验收流程

```bash
# 1. 备份（带时间戳，不要覆盖历史备份）
cp <target> <target>.bak-$(date +%Y%m%d-%H%M%S)

# 2. 只改一行
#    ⛔ 同时改多个变量 = 放弃定位能力。出事后无法二分。

# 3. 真 mount 一次 —— 这是唯一的验收动作
dsh --patch <改动文件> --profile <profile> --no-open --port 0
#    看 stderr：出现 skipping / YAMLException / requires a ... Context = 失败

# 4. 通过后再改下一行

# 5. 全部通过后，才允许用 dump 做结构确认
dsh --patch <改动文件> --profile <profile> --dump-config
```

**交付时必须报告**：退出码 + stderr 是否干净 + 实测到了什么。
不许只说「已修复」。

---

## 三、拿不到运行时错误时怎么办

这是 2026-10-20 最关键的失误：宿主日志不落盘了，我选择了**绕开**，改做静态检查。
正确做法是**把「拿不到证据」当成阻塞项**，就地解决。

### 3.1 先建立最小可复现宿主

```powershell
$dsh = "D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$env:DSH_HOME = "<DSH_HOME>"
# 注意：--patch 必须在 --profile 之前，否则报 unknown option
Start-Process -FilePath $dsh `
  -ArgumentList "--patch","<patch.yml>","--profile","<profile>","--no-open","--port","0" `
  -RedirectStandardOutput out.txt -RedirectStandardError err.txt -PassThru
```

读到 `dsh web: http://127.0.0.1:<port>/?token=...` 即启动成功；看 `err.txt` 找 preset 错误。

### 3.2 隔离测试 profile（不污染生产）

```powershell
# 复制清单与 patch，node_modules 用 junction 复用，测完删除
cmd /c mklink /J "<tmp>\node_modules" "<real>\node_modules"
```

**⚠️ 必须先确认被测样本里含故障对象**：`web` profile 通常只有 2 个 bundle，
`desktop` 有 20 个。用 web 测 desktop 的 bundle 问题，会得到「干净」的假绿灯。

### 3.3 问用户时要问到能证伪

UI 故障固定问三件事，不要只问「有没有」：

1. 卡片上有没有**红字**或「加载失败」标签？
2. **鼠标悬停**有没有报错气泡？（DSH 的 preset 错误常在气泡里）
3. F12 控制台有没有红色报错？

> 「看不见」和「加载失败」是两种完全不同的故障，排查路径相反。

---

## 四、常见故障模式

### 4.1 整个 bundle 被静默跳过（`!!js` 块集合）

**症状**：四个 preset 全消失，只剩 standard/ptc/minimal/cordis，UI 无任何提示。

**stderr**：
```
dsh: skipping profile bundle "@agint/host":
  failed to parse overlay ...: YAMLException: bad indentation of a mapping entry (118:15)
```

**原因**：`!!js` 只接受**标量**。写成多行块集合时，解析器遇 `{` 按流式映射处理：

```yaml
# ❌ 错误
agentsSizeGuard: !!js ({
  file: ...,
})

# ✅ 正确：压成一行并加引号
agentsSizeGuard: !!js "({file: ..., maxBytes: 10000})"
```

**排查一行**：
```bash
dsh --patch <bundle>/cordis.patch.yml --profile <p> --dump-config 2>&1 | grep skipping
```

### 4.2 preset 加载失败（activate 阶段）

**症状**：卡片显示「加载失败」红标签，其他 preset 正常。

**stderr / 气泡**：形如 `<row> (<pkg>): <pkg> standing \`<key>\` requires ...`

**常见原因**：把某个键从别的 preset 抄过来，但**所在组的 realm 不同**。

真实案例：`standard` 的 `delegation` 组**没有** `isolate`，所以能用 `modelSelectionSettings: true`；
`agint-ops` 的 `delegation` 有 `isolate: {workflowEngine: true}`，组内是独立 realm，
抄这个键 ⇒ 整个 preset 加载失败。

> **规则：抄配置时连前提一起看。** diff 只能告诉你「这里多一行」，
> 不会告诉你「这里多了个 isolate 前提」。

### 4.3 preset 声明了但列表里没有

按顺序查：

1. `Config.listConfigs`（name = `@deepseek-ai/dsh-agent-preset`）→ 有无 `preset-<id>` 行？
2. 有 → 看该行 status；无 → bundle 根本没加载，查 4.1
3. 都正常但 UI 没有 → 看 4.2

### 4.4 `link:` 依赖改了但没生效

```bash
# 症状
[ERR_PNPM_OUTDATED_LOCKFILE] specifiers in the lockfile don't match
  * 1 dependencies were added: @agint/host@link:...
```

`nodeLinker: hoisted` 下 `link:` 会被**拷贝**成实体目录，lock 不更新则拷贝不刷新 ⇒ 加载的是旧副本。

```bash
pnpm install --no-frozen-lockfile   # 刷新
pnpm install --frozen-lockfile      # 复验通过才算好
```

修好后 `node_modules/@agint/host` 应变成指向实体目录的 **Junction**，而不是实体拷贝。

---

## 五、自检清单

改动 preset 前/后逐条打勾：

- [ ] 已备份目标文件（带时间戳）
- [ ] 本轮只改了一个变量
- [ ] 跑过 `dsh --patch ... --profile ...`（真 mount，不是 dump）
- [ ] stderr 干净（无 `skipping` / `YAMLException` / `requires ... Context`）
- [ ] 确认过被测 profile 的 `bundles` 列表里**确实包含**目标 bundle
- [ ] 若从别处抄了配置键，核对过两边的 `isolate` / realm / 作用域
- [ ] 没有用「dump 退出码 0」宣告完成

---

## 六、一句话

> **能跑起来才算改好。dump 通过只说明你写得对，不说明它能用。**
> 拿不到运行时证据时，说「这是阻塞」，不要用静态检查假装推进。
