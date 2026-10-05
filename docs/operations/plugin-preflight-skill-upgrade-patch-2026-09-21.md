# plugin-preflight SKILL.md 升级补丁（2026-09-21）

> **状态：✅ 已 apply（2026-09-23 14:02 UTC）**。approval policy 从 ask 改成 danger-full-access 后，沙箱不再限，立即手动 apply 了 4 处改动。backup 在 `SKILL.md.bak-20260921`。
> ~~**状态：待 apply**。沙箱写不了 `/dsh/.agent-presets/`（workspace-write mode 升级也被拒），老板 2026-09-21 立规改写 patch 形式提交。~~
>
> **目标文件**：`/dsh/.agent-presets/agint/skills/plugin-preflight/SKILL.md`
>
> **配套文档**：[plugin-preflight-three-stages.md](./plugin-preflight-three-stages.md)（已落地）
>
> **配套脚本**：[bin/dsh-shadow.sh](../../bin/dsh-shadow.sh)（已落地 + 端到端 smoke 验证）

## 为什么升级

老板 2026-09-21 立规「**所有新增 / 修改的 agint-* 插件必须按三阶段流程推进**（热加载 → 影子 dsh web → host 挂载），无例外」。plugin-preflight skill 当前没体现这条强制门禁，过期了。需要 4 处升级：

1. `triggers:` 列表加一条「老板要求做 agint-* 插件开发/修改」
2. `tools:` 列表加 `bin/dsh-shadow.sh`（阶段 2 的核心工具）
3. **新增「阶段 0：三阶段流程」**章节，作为原 5 步流水线的前置强制门禁
4. 「关联」节加 `docs/operations/plugin-preflight-three-stages.md` 链接 + `bin/dsh-shadow.sh` 链接

## Diff（按目标文件原顺序）

```diff
--- a/dsh/.agent-presets/agint/skills/plugin-preflight/SKILL.md
+++ b/dsh/.agent-presets/agint/skills/plugin-preflight/SKILL.md
@@ -2,11 +2,13 @@
 name: plugin-preflight
 description: "新增 / 修改 agint-* 插件挂到 cordis.patch.yml 前的强制准入工作流。10 分钟搞定，比挂上去再崩 30 分钟排障便宜十倍。涉及任何 plugin 源码变更、新插件创建、cordis.patch.yml 新增 - id 行时调用。"
 tools:
   - bin/plugin-check.sh
   - safe-update.sh
   - node
+  - bin/dsh-shadow.sh
 triggers:
   - "新增/修改 agint-* 插件挂到 cordis.patch.yml 前"
   - "任何 plugin 源码变更、新插件创建"
   - "cordis.patch.yml 新增 - id 行"
+  - "老板要求做 agint-* 插件开发/修改（默认触发三阶段流程，详见阶段 0）"
 related_skills:
   - editing-cordis-compositions
   - cordis-plugin-development
   - memory-discipline
@@ -19,6 +21,51 @@ related_skills:
 
 # 插件准入预检（Plugin Preflight）
 
 把任何 agint-* 插件挂到 `cordis.patch.yml` 之前必须走完这条流水线。本 skill 是 PLUGIN-SPEC 8 维度的「**事中**」兜底，**事前**已经做了还不够 —— 因为 lint 只能看到静态源码，看不到运行时 waterfall 契约。
 
+## 阶段 0：三阶段流程（老板 2026-09-21 立规，强顺序，无例外）
+
+任何 agint-* 插件的**新增 / 修改**，必须按以下三阶段顺序推进，**禁止跳级**：
+
+```
+[阶段 1] 热加载（本会话内，cordis_define + cordis_run update mode）
+   ↓ 通过
+[阶段 2] 影子 dsh web（隔离实例 e2e，bin/dsh-shadow.sh）
+   ↓ 通过
+[阶段 3] host 挂载（原 5 步流水线）
+```
+
+### 阶段 1：热加载
+
+- 工具：cordis_define + cordis_run update mode（不重启 dsh）
+- 通过标志：apply(ctx) 跑通、Tool 注册生效、cordis_run 无 error
+- **不通过 = 回阶段 1 重写，禁止跳到阶段 2**
+
+### 阶段 2：影子 dsh web
+
+```sh
+bin/dsh-shadow.sh up      # 拉起影子 :3081（默认端口，避 host :3080）
+bin/dsh-shadow.sh status  # 看 PID + 路径
+bin/dsh-shadow.sh logs 50 # 看启动日志
+# 改完 plugins/agint-*/lib/*.js：
+bin/dsh-shadow.sh down && bin/dsh-shadow.sh up   # 重启影子即生效（软链）
+```
+
+4 层隔离（独立 DSH_HOME / AGINT_HOME / storages / plugins 软链）。改本仓源码即生效 = 阶段 1 的本质。**通过标志**：up exit 0、端口 3081 占着、status 显示运行中。**不通过 = plugin 在影子也崩，回阶段 1 重写，禁止跳到阶段 3。**
+
+### 阶段 3：host 挂载
+
+本 skill 原 5 步流水线（lint → smoke → diff → safe-update mount → restart），执行前必须先过阶段 1+2。
+
+### 适用范围
+
+- **适用**：所有新增 / 修改的 agint-* 插件，无例外（包括 manifest.json / package.json 改动语义影响 plugin 行为时）
+- **不适用**：纯文档 typo / wiki / 运维脚本本身的修改
+
+### 为什么不能省掉阶段 2
+
+- 2026-09-12 dream 全栈事故：沙箱镜像最小化让 zstd CLI 缺，宿主端看着没事，真起 host 才崩
+- 2026-09-12 仓 vs host 漂移点：agint-quality-sdk / agint-quality-static 在仓有 lib/index.js 但 host 没有
+
+完整文档见 [`docs/operations/plugin-preflight-three-stages.md`](./plugin-preflight-three-stages.md)。
+
 ## 为什么需要 preflight
 
 > **2026-09 全栈事故**：agint-event-bus 和 agint-mount 各自注册了一个 `ctx.on('tools/post-execute', () => {})` 占位监听。
@@ -157,5 +204,7 @@ related_skills:
 - `bin/safe-update.sh` —— 完整 4 份快照 SOP
 - `docs/operations/dsh-restart-incident-20260821.md` —— SOP 起源
 - `docs/operations/safe-update-sop.md` —— 完整 4 份快照 SOP
 - `docs/operations/plugin-preflight-three-stages.md` —— 三阶段流程 SOP（本 skill 的前置门禁）
+- `bin/dsh-shadow.sh` —— 阶段 2 影子 dsh 工具
 - Memory `plugin-spec-9-dimensions`（沉淀目标）
```

## Apply 结果（2026-09-23 14:02 UTC）

```sh
# 1. 备份（已执行）
cp /dsh/.agent-presets/agint/skills/plugin-preflight/SKILL.md \
   /dsh/.agent-presets/agint/skills/plugin-preflight/SKILL.md.bak-20260921

# 2. edit 4 处（已执行）
#    - tools: 加 bin/dsh-shadow.sh
#    - triggers: 加「老板要求做 agint-* 插件开发/修改」
#    - 工作流前插入「阶段 0：三阶段流程」整章（46 行）
#    - 关联节加 docs/operations/plugin-preflight-three-stages.md + bin/dsh-shadow.sh 链接

# 3. chokidar watcher 自动 reload（dsh-skill-filesystem 默认 200ms 内 invalidate）
#    下次会话调 skill plugin-preflight 会读到新内容
```

文件从 160 行 → 212 行，+52 行。backup 保留供回滚（`SKILL.md.bak-20260921`）。

## 不 apply 的后果（已 apply，这节仅留作对照）

- plugin-preflight skill 描述仍然不含「三阶段」字样，模型在新插件任务里**不会主动加载这个 skill**
- 「老板要求做插件开发」这一类 trigger 不命中 → 阶段 1+2 不会自动被想起
- 三阶段流程的约束力只剩 memory + docs/operations/ 文档，靠智进每次显式查，**漏查风险高**

## 关联

- 配套 SOP：[plugin-preflight-three-stages.md](./plugin-preflight-three-stages.md)
- 配套脚本：[bin/dsh-shadow.sh](../../bin/dsh-shadow.sh)
- 老板立规原话（memory 里）：「以后你在开发插件时先进行热加载测试，再用影子 dsh web 测试，最后再挂载到 host 上」（2026-09-21）

## 变更记录

- 2026-09-21 创建本 patch 文档（沙箱写不了 host SKILL.md，转 patch 形式）
- 2026-09-23 14:02 UTC approval policy 改 danger-full-access 后立即 apply；4 处改动落地，文件 160→212 行，backup `SKILL.md.bak-20260921` 保留