# plugin-preflight 增强：三阶段开发流程（热加载 → 影子 dsh web → host 挂载）

> 老板 2026-09-21 立下的强制规则：**任何新增 / 修改的 agint-* 插件必须按三阶段顺序推进，禁止跳级**。
> 本文档是 [plugin-preflight skill](../../dsh-integration.md) 的补充 SOP，跟 `safe-update-sop.md` 同位。
> **未来插件开发任务，智进应在动手前 `memory_search "三阶段"` + 读本文件，再开始任何代码改动。**

## 适用范围（强约束）

**所有新增 / 修改的 agint-* 插件，无例外。** 包括：

- 新插件首次创建
- 现有 plugin 的源码修改（任何 `lib/*.js` 改动）
- `manifest.json` / `package.json` / `README` / `CHANGELOG` 改动（语义会影响 plugin 行为时）
- waterfall / `ctx.on` 监听器的增删改

**不适用**：

- 纯文档 typo / wiki 自身 / `bin/*.sh` 运维脚本本身的修改
- `bin/safe-update.sh`、`bin/plugin-check.sh` 这些**工具本身**的改动（它们是「plugin 流程的工具」，不是 plugin）

## 三阶段顺序（强顺序，禁止跳级）

```
[阶段 1] 热加载（本会话内）
   ↓ 通过
[阶段 2] 影子 dsh web（bin/dsh-shadow.sh）
   ↓ 通过
[阶段 3] host 挂载（plugin-preflight 原 5 步 + safe-update.sh restart）
```

### 阶段 1：热加载（不重启 dsh）

工具：`cordis_define` + `cordis_run` update mode（[cordis-plugin-development skill](../../skills/cordis-plugin-development/)）。

- 在当前会话里热更 plugin，**不重启 dsh**
- 验证 `apply(ctx)` 在会话里能跑、Tool 注册生效
- 失败的标志：`cordis_run` 返回 error / 工具调用 traceback

**不通过 = 重写 plugin 代码，回到阶段 1 重测。禁止跳到阶段 2。**

### 阶段 2：影子 dsh web（隔离实例 e2e）

工具：[`bin/dsh-shadow.sh`](../../bin/dsh-shadow.sh)（位于本仓根 `bin/`）。

```sh
bin/dsh-shadow.sh up                  # 拉起影子 :3081（默认端口，避 host :3080）
bin/dsh-shadow.sh status              # 看 PID + 路径
bin/dsh-shadow.sh logs 50             # 看启动日志
# 改完本仓 plugins/agint-*/lib/*.js：
bin/dsh-shadow.sh down && bin/dsh-shadow.sh up   # 重启影子即生效（软链）
bin/dsh-shadow.sh down                # 用完停掉
```

**4 层隔离**（参考 `bin/dsh-shadow.sh` 顶部注释）：

1. 独立 DSH_HOME（默认 `/tmp/dsh-shadow`，可 `SHADOW_HOME=...` 覆盖）
2. 独立 AGINT_HOME（默认 `/tmp/agint-shadow-data`，通过影子 `.env` 注入）
3. 独立 storages（在 `SHADOW_HOME/storages`，dsh-home-paths 自动解析）
4. plugins 走软链（仓 `plugins/` 整目录软链 → 影子 `profiles/rescue/plugins`，**改本仓源码即生效**）

**通过标志**：

- ✅ `up` exit 0
- ✅ `status` 显示 🌑 影子运行中
- ✅ 端口 3081 占用中 = dsh web 真活着
- ✅ 本仓 `plugins/agint-*/lib/*.js` 改动后，重启影子即生效（软链本质）

**不通过 = plugin 在影子也崩，bug 在 plugin 本身，回到阶段 1 重写 + 阶段 2 重测。禁止跳到阶段 3。**

**已知沙箱踩坑**：

仓 `plugins/node_modules/@deepseek-ai` 是软链 → host `plugins/node_modules` → 又是软链 → `/usr/local/lib/node_modules/@deepseek-ai/dsh/...`。当前 sandbox 镜像 dsh 装在 `/usr/lib/...`，跟 host 路径不一致，**沙箱里影子 dsh 启动时 plugin 会 MODULE_NOT_FOUND**。脚本已加 warn + 排查提示。**老板本机跑**就 OK。

### 阶段 3：host 挂载（plugin-preflight 原 5 步）

工具：plugin-preflight 原 SKILL.md 第 1~5 步 + `bin/safe-update.sh`。

```sh
bin/plugin-check.sh --all                       # 第 1 步：lint 9 维度
# 写 smoke fixture（plugin-preflight 第 2 步）
node plugins/agint-<name>/test/smoke.mjs        # 第 3 步：跑 smoke
# 第 4 步：diff + manifest 自查
bin/safe-update.sh mount-patch                  # 拍 4 份快照
# 编辑 cordis.patch.yml（注意：host 平面段 + model 平面 row 两处同步，
#   见 agint-rules [agint-restart-two-attach-points-patch] / wiki/AGINT/挂载-两处同步硬规则.md）
bin/safe-update.sh restart                      # 优雅重启
cat sentinel.lease                              # at < 30s = 健康
```

**通过标志**：

- ✅ `plugin-check --all` 全绿 + `smoke` exit 0
- ✅ `safe-update` 4 份快照齐
- ✅ `sentinel.lease` at < 30s
- ✅ host 上 web UI 加载正常、plugin 在 cordis 段生效

**不通过** = `bin/safe-update.sh rollback <TS>` 倒序回滚，回到阶段 1 重做。

## 与 plugin-preflight skill 的关系

| plugin-preflight skill | 本文档的关系 |
|---|---|
| 第 1~4 步（lint / smoke / diff / manifest） | 不变，本流程的「阶段 3 子步骤」 |
| 第 5 步（safe-update mount + restart） | 本流程的「阶段 3」后半段 |
| 整体流水线 | 本文档是它的**前置强制门禁**——阶段 1+2 必须先过，阶段 3 才允许执行 |

## 为什么不能省掉影子阶段

- **2026-09-12 dream 全栈事故**：沙箱镜像最小化让 zstd CLI 缺，宿主端看着没事，真起 host 时才崩
- **2026-09-12 仓库 vs host 漂移**：`agint-quality-sdk` / `agint-quality-static` 在仓里有 `lib/index.js`，但 host `/dsh/profiles/web/plugins/agint-quality/` 下没有这两个子目录
- 影子 dsh 用 `DSH_HOME=/tmp/dsh-shadow`，把 host 路径差异 / 依赖解析问题前置暴露

## 落地说明（本文件位置选择）

- **位置**：`docs/operations/plugin-preflight-three-stages.md`，跟 `safe-update-sop.md` 同目录
- **为什么不在 host plugin-preflight SKILL.md**：sandbox=workspace-write 不让写 `/dsh/.agent-presets/`，提升权限被拒
- **约束力来源**：智进在插件开发任务中 `memory_search` + 读本文件，靠 memory/pattern 自我召回
- **未来调整**：若想改 host SKILL.md，请在本机（非沙箱）跑 `edit /dsh/.agent-presets/agint/skills/plugin-preflight/SKILL.md`，把本文件的「阶段 1+2」前置加到顶部 trigger 区域

## 变更记录

- 2026-09-21 创建本文件（plugin-preflight skill 三阶段增强的沉淀；老板立规同日）
- 沙箱写 `/dsh/.agent-presets/agint/skills/plugin-preflight/SKILL.md` 被拒，转 workspace 内的 `docs/operations/` 沉淀
- 配套脚本：[`bin/dsh-shadow.sh`](../../bin/dsh-shadow.sh)（374 行，已在沙箱端到端 smoke 验证）

## 关联

- [plugin-preflight skill](../../skills/plugin-preflight/SKILL.md)
- [safe-update-sop.md](./safe-update-sop.md)
- [dsh-restart-incident-20260821.md](./dsh-restart-incident-20260821.md)
- [bin/dsh-shadow.sh](../../bin/dsh-shadow.sh)
- [bin/safe-update.sh](../../bin/safe-update.sh)
- [bin/plugin-check.sh](../../bin/plugin-check.sh)
- [cordis-plugin-development skill](../../skills/cordis-plugin-development/)
- Memory 索引（搜「三阶段流程」/「plugin-preflight 增强」/「dsh-shadow」）