# 经验教训 — 用「读得懂」冒充「跑得起来」：一次 preset 加载故障的六轮空转

> 写于 2026-10-20。任务本身很小：给 `agint-ops`（智进·生产运维）补齐 standard 的全部能力。
> 结果改出了故障，又用**六轮静态检查**去查一个**运行时才抛**的错，最后靠老板截图才定位。
> 值得记的不是那个配置键，是「我为什么拿不到现场证据还不肯承认」。

## TL;DR

一句话：**`--dump-config` 证明不了任何东西能跑。我用它当验收，等于用「语法正确」证明「程序正确」。**

| # | 教训 | 本次实证 | 正确做法 |
|---|---|---|---|
| 1 | 「组装成功」≠「能激活」 | `dsh --dump-config` 退出码 0、4 个 agint preset 全在树里，但 UI 显示「加载失败」 | 验收必须**真正 mount 一次**；dump 只配用来查语法 |
| 2 | 对齐配置时要连**前提**一起看 | 反查 `standard` 有 `modelSelectionSettings: true` 就照抄，但它 `delegation` **没有** `isolate`，本 preset 有 | 抄一个键前，先问「它所在的上下文和我一样吗」 |
| 3 | 拿不到运行时证据 = 第一优先级，不是可绕过项 | 宿主日志停在 23:48 不落盘，我选择绕开，改做静态检查 | 先解决「怎么看现场」，再动手 |
| 4 | 测了不含故障对象的样本，结论不能外推 | 启 web profile 捕获 stderr「干净」，但 web 只有 2 个 bundle，根本不含 agint | 验证前先确认**被测样本里有故障对象** |
| 5 | 一次改多个变量 = 自己制造白盒 | 一轮同时加 4 个工具行 + 1 个 config 键，出事后无法二分 | 改一行验一行；批量改动等于放弃定位能力 |
| 6 | 现象描述要问到能证伪的程度 | 我问「列表里看不到？」，得到「看不到」，就按「不渲染」去查，方向错三屏 | 问「有没有红字/气泡/控制台报错」，而不是问「有没有」 |

---

## 一、错在哪：六轮空转的完整轨迹

### 起点：我自己引入的故障

任务是「让 `agint-ops` 包含 standard 的全部能力」。我用脚本把 standard 的 25 个启用行逐条比对，
发现 4 个缺口，并额外发现 `standard` 的 `tool-subagent` 比本 preset 多一个键：

```yaml
modelSelectionSettings: true
```

我把它当成「第 5 个缺口」补上了。**这一步就已经错了**，而当时的自检是：

- 包能 resolve ✅
- YAML 能解析 ✅
- `--dump-config` 退出码 0 ✅

三项全绿，于是我认为改对了。**三项全都没有执行这个键。**

### 真实错误（老板截图才看到）

```
tool-subagent (@deepseek-ai/dsh-tool-subagent):
tool-subagent standing `modelSelectionSettings` requires a scoped preset Context
```

`agint-ops` 的 `delegation` 组带 `isolate: {workflowEngine: true}`，组内是独立 realm，
拿不到外部 scoped preset Context。这个键在 **activate 阶段**才被校验，所以：

| 阶段 | 谁来验 | 能否发现 |
|---|---|---|
| YAML 解析 | `--dump-config` | 否 |
| 配置树组装 | `--dump-config` | 否 |
| **插件 activate** | **运行时 mount** | **是** |
| UI 渲染 preset 卡片 | 前端 | 是（显示「加载失败」气泡） |

**我全程只用了前两行。**

### 六轮里我做了什么

| 轮次 | 动作 | 是否触及根因 |
|---|---|---|
| 1 | 比对 preset 行 vs standard | 否 |
| 2 | 检查插件包能否 resolve | 否 |
| 3 | 检查 7 个 `tools.js` 路径存在性 | 否 |
| 4 | 单独 probe 4 个新加的行 | 否（漏掉了 config 键） |
| 5 | 怀疑 description 553 字符太长，压到 291 | 否，且怀疑方向错误 |
| 6 | 建临时 profile 跑 dump | 否 |

**六轮全是静态检查。** 错误的性质是运行时错误，我在错误的层级上重复投入了六次。

---

## 二、三个可复用的判断规则

### 规则 1：验收层级要匹配错误层级

> 想知道「能不能跑」，就必须真的跑一次。
> `--dump-config` / 静态解析 / 包 resolve 只能证明「读得懂」，不能证明「跑得起来」。

**操作化**：任何 preset / 插件 / bundle 改动，验收清单里必须有且仅以这一条为准：

```
dsh --patch <改动文件> --profile <profile>   # 真正 mount，看 stderr
```

dump 只可以出现在「排查语法」环节，不能出现在「确认能用」环节。

### 规则 2：抄配置必须抄上下文

> 从 A 抄一个键到 B 时，先核对 A 与 B 的**作用域、isolate、realm** 是否同构。
> 配置键的可用性往往由它所在组的 realm 决定，而不是由键本身决定。

本次就是典型：同一个键在 `standard` 合法、在 `agint-ops` 致命，唯一差别是
`delegation` 组的 `isolate`。**diff 工具只会告诉你「这里多一行」，不会告诉你「这里多了个前提」。**

### 规则 3：现象描述要问到能证伪

> 「看不见」是现象，「加载失败」是结论。两者排查路径完全不同。

我当时问的是「列表里看不到？」，得到确认后就去查渲染逻辑。
如果问的是「卡片上有没有红字或报错气泡」，第一轮就能结束。

**操作化**：涉及 UI 故障时，固定问三件事 —— 红字/气泡、悬停提示、控制台（F12）报错。

---

## 三、过程性失误：两个我自己制造的信息缺口

### 缺口 1：日志不落盘时选择了绕开

事实：`%TEMP%\dsh-web.log` 停止于 2026-10-19 23:48，此后宿主重启多次，**再无新日志写入**。

我意识到了这件事（查过文件大小、查过 mtime），但没有把它当成阻塞项，
而是转去做 `--dump-config`。**这是整次事故里最关键的错误决定**——
绕开现场证据，后面所有的推理都建在推测上。

> 规则：**拿不到现场证据是阻塞项，不是待办项。** 要么解决它，要么明确告诉用户「我需要你做一次 XX」。
> 不要用「我看看配置对不对」来假装推进。

### 缺口 2：测试样本不含故障对象

我启动 web profile 捕获 stderr，结果干净，据此认为「宿主没问题」。但：

```
profiles/desktop/package.json → dsh.profile.bundles 20 个，含 @agint/host
profiles/web/package.json     → dsh.profile.bundles  2 个，不含 @agint/host
```

**我测的是一个不含故障对象的样本，却把结论用在了生产 profile 上。**
这是「绿色结果」最危险的形态：它不是假象，是**答非所问的正确答案**。

> 规则：跑验证前，先确认「被测样本里确实存在我要验证的东西」。否则绿灯无意义。

---

## 四、附带查明的两个真实故障（本可避免的发生条件）

本次顺带修掉两个真问题，记录在此以免重犯：

### 4.1 bundle 整体被静默跳过（YAML 块集合）

`cordis.patch.yml` 第 118 行曾把 `!!js` 写成**多行块集合**：

```yaml
agentsSizeGuard: !!js ({
  file: ...,
})
```

dsh 的 YAML 解析器只接受 `!!js` 作为**标量**，遇到 `{` 按流式映射解析：

```
dsh: skipping profile bundle "@agint/host":
  failed to parse overlay ...: YAMLException: bad indentation of a mapping entry (119:15)
```

后果是**整份 patch 解析失败 ⇒ 整个 bundle 被跳过 ⇒ 四个 preset 全部消失**，
且 stderr 只有一个 `skipping profile bundle` 警告，UI 无任何提示。

修法（单行标量，语义不变）：

```yaml
agentsSizeGuard: !!js "({file: ..., maxBytes: 10000})"
```

> 规则：`!!js` 只当标量用。要写对象就压成一行并加引号。

### 4.2 pnpm lock 落后于 package.json

`link:` 依赖在 `nodeLinker: hoisted` 下会被**拷贝**成实体目录，lock 不更新则拷贝不刷新：

```
package.json      10-18 12:00  声明 @agint/host: link:D:/DSH/AGINT-date/.agint-bundle
pnpm-lock.yaml    10-18 11:32  不含 agint 条目（早 28 分钟）
```

pnpm 自己会直说：

```
[ERR_PNPM_OUTDATED_LOCKFILE] ... specifiers in the lockfile don't match
  * 1 dependencies were added: @agint/host@link:D:/DSH/AGINT-date/.agint-bundle
```

修法：`pnpm install --no-frozen-lockfile`，之后 `@agint/host` 变为指向 `.agint-bundle` 的 Junction，
双副本漂移消除。

> 规则：改 profile 的 `dependencies` 后必须跑一次 `pnpm install --no-frozen-lockfile`，
> 并用 `--frozen-lockfile` 复验通过。只改 package.json 不改 lock = 改了等于没改。

---

## 五、这次做对的部分（保留）

不全是错的，以下动作有效，值得固化：

1. **每次改动前备份**，命名带时间戳（`.bak-yamlfix-20261020-001701` 等）。
   `agint-ops/agent.cordis.yml` 的旧版备份哈希 `3307f54f` 与上上版一致，证明追溯链干净。
2. **用 dsh 自己的解析器验证**，而不是自己手写 YAML 校验。判据是 `dsh --dump-config` 的退出码，
   不是「我觉得这样应该行」。
3. **建临时 profile 做隔离测试**（`diagcopy` / `opsdiag`），用 junction 复用 `node_modules`，
   测完删除，不污染生产。这个方法本身是对的，只是用在了错误的验收目标上。
4. **主动更正自己的错误结论**（把「lock 是根因」更正为「lock 只是链路问题」；
   把「35 个插件全部 MISSING」更正为脚本误报、实际 35/35 正常）。
   结论错了要显式撤回，不能让它留在会话里。

---

## 六、给下一个 agent 的 checklist

改动 preset / 插件 / bundle 时，按顺序执行：

```
1. 备份目标文件（带时间戳）
2. 改**一行**
3. dsh --patch <file> --profile <profile> --no-open --port 0   ← 真 mount，看 stderr
4. 通过 → 改下一行；失败 → 立刻二分，不要继续加
5. 全部通过后，才允许跑 --dump-config 做结构确认
6. 交付时报告：退出码 + stderr 是否干净 + 实测到了什么
```

**禁止**：

- 用 `--dump-config` 的退出码 0 宣告「改好了」。
- 一口气改多个变量后再定位。
- 在拿不到运行时证据时，用静态检查冒充推进。
- 测不含故障对象的样本来证明「没问题」。

---

## 七、一句话

> 我不是没能力找到，是**在错误的层级上反复投入，且不肯承认自己拿不到现场证据**。
>
> 下一次，先说「我看不到运行时错误，这是现在的阻塞」，而不是「我先把配置查一遍」。
