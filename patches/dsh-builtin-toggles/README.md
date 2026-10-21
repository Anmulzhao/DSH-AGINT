# ⛔ 已退役（2026-10-21）—— 不要运行 apply.sh

**退役理由（三条，任一成立即不应使用）**

1. **越界**：本补丁直接改写 `node_modules` 里上游插件的源码（`lib/index.js` 单行替换）。
   AGINT 的定位是 dsh 之上的组件，不是 fork；改上游源码属越界，已写入
   `docs/capability-boundary.md` §2（H-越界）与边界门禁的判定范围。
2. **目标已不存在**：脚本写死 `profiles/web/node_modules/dsh-builtin-toggles/`，
   而 web profile 已于 2026-10-18 删除（老板令）。实测
   `profiles/web` 与 `profiles/desktop` 两处目标**都不存在** ⇒ 脚本必在
   `[ -f "$TARGET" ]` 处 exit 1，当前处于失效状态。
3. **静默丢失**：任何 `pnpm/npm install` 或插件更新都会覆盖被改的文件，
   补丁需要「每次重跑」—— 这是把一次性 hack 当成维护流程。

**若该功能仍需要**：向上游提 issue/PR，让 `dsh-builtin-toggles` 把「无关 entry 漂移」
的连坐判定改为可配置；或改用 dsh 的 `cordis.patch.yml` 配置面。
不要回到改源码这条路。

以下为原始说明（保留供追溯）：

---
# patch: dsh-builtin-toggles — 忽略无关的版本漂移

## 为什么

dsh-builtin-toggles 把「已审阅基线」硬编码为 `@deepseek-ai/dsh@0.1.0-rc.6`。
本机跑 rc.8，插件检测到 6 条 rc.6 时代不存在的官方 entry
（`session-reference` / `file-reference-local` / `ui-renderer` /
`ui-brand-official` / `ui-attachment` / `ui-reference`），判定 `drifted`。

原实现里，**任意一条**无关 entry 漂移都会让全部 9 个 UI 开关一起失效：

```js
for (const finding of compatibility.findings) {
  if (finding.scope === "composition") continue;
  if (finding.id === id) { addReason(reasons, "target_structural_drift"); continue; }
  addReason(reasons, "global_structural_drift");   // ← 连坐
}
```

dsh 处于 rc 预览期、版本频繁变更，这条连坐规则实际等于永久锁死。

## 改了什么

`lib/index.js` 单行（约 1278 行）：把无关条目的漂移从 **阻断性 reason**
降级为 **信息性 limitation**。

- 保留：`target_structural_drift`（目标自身漂移仍然阻断）
- 保留：`not_manageable` / `missing_runtime_entry` / `reviewed_baseline_missing`
  / `reviewed_safe_leaf_evidence_missing` / `profile_not_persistable`
  / `runtime_identity_mismatch` —— 全部照旧
- 降级：无关条目漂移 → `limitations: ["global_structural_drift_ignored"]`

影响面仅限 `MANAGEABLE` 白名单里的 9 个纯 UI leaf：
`ui-deliverables` / `ui-jobs` / `ui-goal` / `ui-message-feedback` /
`ui-model-selection` / `ui-agent-preset` / `ui-skill` / `ui-subagent` /
`ui-trajectory`。

**不解锁**其它 175 条 capability：core / external / unlisted 分支未改动，
`agint-*` 插件走 external（包名非 `@deepseek-ai/` 前缀），与本补丁无关。

## 风险

绕过的是作者刻意的 fail-closed 设计。作者的保守立场是合理的
（`COMPATIBILITY.md`：allowlist 扩张绝不等同兼容性更新）；这里只在
**已知 rc 预览期版本必然漂移** 的前提下放宽，且被解锁的是纯界面 leaf，
误操作最坏后果是某个 UI 面板消失，改回来即可。

## 维护

补丁在 `node_modules` 里，**任何 reinstall / plugin update 都会冲掉**。
重打：

```sh
patches/dsh-builtin-toggles/apply.sh   # 幂等，已在位则跳过
```

改完必须重启 `dsh web` 才生效（Host 半在 Node 进程内存里）。

上游若重写这段逻辑，脚本会报 "目标行不存在" 并拒绝改，此时需人工复核。
理想的长期解法是给上游提 issue/PR，让基线可配置而不是硬编码。
