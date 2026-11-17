---
name: plugin-preflight
description: "agint-* 插件挂载 / 源码变更的强制准入工作流。10 分钟搞定，比挂上去再崩 30 分钟排障便宜十倍。涉及任何 plugin 源码变更、存量插件改常量/provider/默认值、新插件创建、cordis.patch.yml 新增 - id 行时调用。"
tools:
  - bin/plugin-check.sh
  - bin/check-wiring.mjs
  - install/redeploy.sh
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

结论先行：任何 agint-* 插件源码变更、新插件创建、改存量插件常量 / provider / 默认值、cordis.patch.yml 新增 `- id` 行，走下面 5 步，**强顺序**，任一步 fail 即 abort。场景 A 挂新插件走满 5 步；场景 B 改存量插件第 2 步通常**免写**，但第 5 步**双副本同步是硬要求**。

lint 只看静态源码，看不到运行时 waterfall 契约（PLUGIN-SPEC 第 9 维度 **runtime-contract**）。

## 第 1 步：lint 全 9 维度

```sh
bin/plugin-check.sh --all
```

预期 `0 fail`，任何 fail 即 abort，不进第 2 步。没装 perl 时退到 node 镜像：

```sh
node bin/_verify-dim9.mjs plugins/agint-<name>/lib/index.js
```

新增 waterfall 监听必须：**监听器体非空** + **体里出现 `next(` 调用**（独立 token，避免误中 `nextStep` / `nextTick`）。正例与 ❌ 禁例见同目录 reference.md。

已知 waterfall 事件名（DSH 文档声明）：`tools/pre-execute`、`tools/post-execute`、`tools/ptc-dispatch-log`、`agent/pre-step`。新增 waterfall 事件时同步更新 `bin/plugin-check.sh` 里的 `$waterfall_pat`。

## 第 2 步：写一个**最小冒烟 fixture**

放在 `plugins/agint-<name>/test/smoke.mjs`（或在已有 manifest 里改 `tests.entry`）。至少验证三件事：加载不抛（`require('./lib/index.js')`）、`apply(ctx)` 在 fake ctx 上不抛、声明 waterfall 监听时触发一次事件并断言决策结构正确。**不要满足于「能 import」**。

补强 A（v0.4 新增）：`permissions.fs` 非空时 smoke **必须**额外覆盖跨平台路径 case——forward-slash 相对路径 + native-sep 根（`resolve()` 在 Windows 返回 `<盘符>:\...`）。原因（v0.4 agint-wiki 教训）与模板见 reference.md。

plugin-check.sh 会追加一条 **soft warning**（不阻断）：`manifest.spec.permissions.fs` 非空但 smoke 缺 `'foo/bar.md'` / `'../escape.md'` 字面量 ⇒ 提示补跨平台 fixture。

补强 B（v0.5 新增，静默零 silent-zero）：插件有读本地存储做自观测 / 统计 / 检测的代码（`*.jsonl`、metrics JSON、规则表）时，smoke **必须**喂真实 schema 样本（真实存储是 `agint_tool_stats.jsonl` 的 boolean `ok`）并断言检测器真的产出信号：

- **正样本**：真实 schema 的坏数据（`ok:false` 的工具调用、下降的 `rules.adherencePct`、真实 `level:'L1'` 的 deny 规则）必须产出 ≥1 条信号
- **负样本**：全好数据必须产出 0 条（防"永远有信号"的反向失明）
- **接线状态**：未实现的检测器不许伪装成在跑——status / `health()` 显式暴露活跃子源数（如 `subSources: 1/5`）与每个检测器是否 active，让"0 信号"与"检测器全瞎"在状态层可区分

写检测逻辑前**先取证再写码**：dump 真实存储（字段名、成功标记是 boolean 还是字符串、条目在顶层还是 `tables.*[uuid]`）；阈值按真实规模重估（真实 deny=2、L1=2 时，`>=10` 的阈值等于永久静默）；修好前在 shadow 档观察。细节见 reference.md。

## 第 3 步：跑 smoke

```sh
node plugins/agint-<name>/test/smoke.mjs
```

预期 exit 0，任何非 0 即 abort。

## 第 4 步：diff + manifest 完整性自查

- `manifest.json` 8 维度 + 9 维度全填齐
- `README.md` 里 provides 一句话 + 一个使用示例
- `CHANGELOG.md` 写清楚破环性变更
- `package.json` 里有 semver 版本号
- 没有裸 `setInterval` / `setTimeout` —— 必须 `ctx.effect` 注册 disposer

**字节保真**：仓内 `plugins/**/lib/*.js` 与 `presets/**/skills/*/SKILL.md` 约定是 **BOM + LF**，部分文件末尾还多一个 CRLF（实测 `tools.js` 结尾是 `};\n\r\n`）。

- 改完必须 `git diff --stat` 核对：行数与预期不符就是编码被动过
- 取原始字节**不要用 `git show HEAD:file`** —— PowerShell 5.1 的管道会转码 LF→CRLF，量出来的「原始是 CRLF」是假的。正确脚本见 reference.md。
- 还原：`[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))`，再按实测的原始字节约定重建尾部

**技能副本同样要同步**：`presets/<preset>/skills/<name>/SKILL.md` 是真源，部署位是 `$DSH_HOME/.agent-presets/<preset>/skills/<name>/SKILL.md`（旧 home `~/.dsh/.agent-presets/<preset>/skills/<name>/SKILL.md`）——只改部署位会被下次同步静默回退。子 preset（agint-blockchain / agint-investor，2026-10-26 起在独立仓 agint-presets）里的同名技能是**指针桩**。

## 第 5 步：走完整挂载 / 上线流程

**先分清编辑目标**：仓库源码与 host 部署位是**两份独立副本**，不是链接：

```
仓库真源  <repo>/plugins/agint-*/lib/*.js
bundle 位  $DSH_HOME/.agint-bundle/plugins/agint-*/lib/*.js        ← 服务真正加载 + preset 工具行锚这
mirror 位  $DSH_HOME/profiles/<profile>/plugins/agint-*/lib/*.js   ← 兼容镜像位（v0.14.0 起不再被引用）
```

**正确顺序：改仓库 → `./install/redeploy.sh`（铺部署位 + 核验 + 重启）→ 看它的核验结论。** 只改 host 两份 = 下次部署静默回退；只改仓库不同步 = 服务跑的仍是旧代码且**不报错**。任一步不过就**不重启**（fail-closed），「跑完 exit 0」就是验收证据；只核验用 `./install/redeploy.sh --verify-only`，只看计划用 `--dry-run`。

> ⚠️ 两份副本只同步一处 = **静默分叉**。`bin/check-wiring.mjs` 查 E 会报 `DIVERGED` 并 exit 1。改完必跑。

改源码前跑 `bin/safe-update.sh edit-source`（拍快照 + 拿回滚点），改 `cordis.patch.yml` 前跑 `bin/safe-update.sh mount-patch`，当前 prod 冒烟用 `bin/safe-update.sh smoke`；部署用 `./install/redeploy.sh`，改完跑 `node bin/check-wiring.mjs`（查 E 双副本 + 查 H 仓库↔部署，查 I 漂移插件 smoke）。仓库里改 `<repo>/plugins/...` 与 `<repo>/cordis.patch.yml`，部署位副本别手改。

**快照必须自己核实产物**（`compgen -G` 恒 MISS、`tar` 把 `C:` 当远程主机前缀会假成功；已在 `bin/safe-update.sh` 修掉，旧版机器仍复发）：

```sh
ls -la "$DSH_HOME/.agint-backups"/agint-plugins-*.tar.gz | tail -1
tar tzf <上面那个 tar> | grep -c '^agint-[^/]*/$'   # 应等于 bundle 位 agint-* 目录数（本机 41）
```

**重启按场景分三条路，别混用：**

- 常态（改了仓库源码 / preset / patch）：`./install/redeploy.sh`——铺部署位 + 核验 + 重启一条命令，约 55s
- 只重启不动文件：`restart_request` 工具（agint-restart v0.2.0+）——三重护栏（confirm + 冷却期 + 熔断）、dryRun、`--no-open`、sideEffect 回报
- 崩了倒序回滚：`bin/safe-update.sh rollback <TS>`——快照与回滚是它唯一的职责

崩了就 `plugin → patch → preset` 倒序回滚（详见 `docs/operations/safe-update-sop.md`）。**Windows Git Bash 缺 ss / pgrep，`bin/safe-update.sh restart` 那条路径仍不可靠——Windows 上走 `restart_request`**；Linux 可用。重启后验收用 `restart_status` 的时间戳差而不是 sentinel.lease（后者部分机器不生成），红线 <30s。

## 输出契约

完成标志：`bin/plugin-check.sh --all` 无**新增** fail（既存 fail 记基线再对比，不是要求绝对 0）+ smoke exit 0 + `check-wiring.mjs` PASS + 快照**经 tar 条目数核实**齐备。本机仓库有 **4 个既存 fail**（1×K19 schema + 3×manifest 缺失），判据是「改动前后 fail 数与清单是否一致」。

**场景 B 另加两条硬验收：真实调用一次 + 先核对宿主真源。** smoke 与单测证明不了（改常量后单测自证通过，smoke 全 mock）；常量不在宿主注册目录里时每次调用都抛 `UNKNOWN_MODEL`，lint 全绿、smoke exit 0 也是死路。判据：真实调用必须 `mode=llm · schemaOk=true`（`mode=failed` / `schemaOk=false` ⇒ 模型 id 不在目录里）。细节见 reference.md。

长代码示例、事故背景推导、完整输出样例、关联清单与分工见同目录 reference.md，用 read 工具打开（本会话 skill 加载返回的 Base directory 即技能基目录）。
