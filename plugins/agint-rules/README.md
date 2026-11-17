# agint-rules

AGINT 规则门禁：在工具调用流水线上强制执行一组规则，按严重度区分动作。

## 架构

- **`lib/index.js`** — Host 服务（`agint.rules`）。单实例，独占打开
  `agint_rules` storage domain（与 `agint` domain 互斥）。监听两个 Cordis
  事件挂钩：
  - `tools/pre-execute` waterfall：对 action=`deny` 的规则返回 `{kind:'deny'}`；
    对 action=`ask` 的规则返回 `{kind:'ask'}`；对 action=`advisory` 的规则
    不阻断（走 next）。
  - `tools/post-execute` waterfall：对 action=`advisory` 的规则注入
    `additionalContexts` 把提醒塞回给模型——这是 DSH 设计中"提醒必然出现"
    的合法路径（不会因为模型忘记调 `rule_check` 而漏掉）。
- **`lib/tools.js`** — Preset 工具：`rule_check` / `rule_list` / `rule_audit`
  / `rule_lint` / `rule_add` / `rule_remove` / `rule_set_enabled`。模型可以
  显式查询、增删、审计。

## 安装

1. 包必须真实复制到 `~/.dsh/profiles/web/plugins/agint-rules/`（不能
   symlink：内部 `@deepseek-ai/*` 导入需经 healed profiles/node_modules
   向上解析）。
2. host 行追加到 `~/.dsh/profiles/web/cordis.patch.yml`：
   ```yaml
   - id: agint-rules
     name: ./plugins/agint-rules/lib/index.js
     config: {}
   ```
3. preset 行追加到 `~/.dsh/.agent-presets/agint/agent.cordis.yml`：
   ```yaml
   - id: agint-rules-tools
     name: ../../plugins/agint-rules/lib/tools.js
   ```
4. 重启 `dsh web`（web profile 禁用 HMR）。

## 规则 schema

```yaml
id:       string  # 唯一标识
tool:     string  # 工具名；"*" = 任意
pattern:  string  # 正则源串（不含斜杠）
flags:    string  # 正则 flags（默认 ''）
action:   advisory | ask | deny
level:    L1 | L2 | L3 | L4
reason:   string  # 命中时展示给模型的原因
enabled:  boolean # 默认 true
```

## 种子规则

| id | tool | action | 命中 |
|---|---|---|---|
| `bash-rm-rf-root` | bash | deny | `rm -rf /` / `rm -rf ~` |
| `bash-git-push-force-main` | bash | ask | `git push --force origin main` |
| `bash-npm-publish` | bash | advisory | `npm publish` / `pnpm publish` |

种子在首次启动且规则表为空时由 `seedIfEmpty()` 写入。可用
`rule_remove` 删除或 `rule_set_enabled` 禁用。

例外：下面三条**自保护规则**无条件补种（表非空也补），且 deny 级的那条
不可删、不可停用 —— 见「规则引擎自保护」一节。

| id | tool | action | 命中 |
|---|---|---|---|
| `rule-disable-forbidden` | rule_set_enabled | deny | `{"enabled":false}` ⇒ 禁止停用任何规则 |
| `rule-remove-needs-human` | rule_remove | ask | 任何删规则调用 ⇒ 人工确认 |
| `rule-add-reason-needs-human` | rule_add | ask | `reason` 会拼进注入消息 ⇒ 人工确认 |

## 验收

启动级诊断（在 web profile 关闭 HMR 期间验证）：
- `agint.rules` 服务在 host fiber 中可见
- `tools.schemas(scope)` 列出 7 个 rule_* 工具
- `rule_list` 返回种子规则 3 条
- `rule_check({tool:'bash', args:{command:'rm -rf /'}})` 命中 deny
- `rule_check({tool:'bash', args:{command:'npm publish'}})` 命中 advisory
- `rule_audit` 返回 hits/totals 计数（**跨重启累计**，见下节）

## 审计计数持久化（v0.2.2，提案 09ae2017）

计数不再只活在内存里。每次命中先改内存，再异步写进本域的第二张表
`rule_audit`（key = ruleId），进程重启后从该表载回基线。

**口径**
- 数值是**跨重启累计**（lifetime），不是单会话。`rule_audit` 因此能回答
  「这条门禁历史上拦过多少次」。
- 每行字段：`hits` / `denies` / `asks` / `advisories` / `epistemics` /
  `firstHitAt` / `lastHitAt`。
- 删规则**不删**计数行：那是历史账本，删规则不等于那段历史没发生。

**边界（改这里之前先读）**
- `agint_rules` 域的 `version` **必须保持 1**。`dsh-storage-json` 见到
  `version !== 期望值` 会抛 `version-mismatch`，整次 `domain.open` 失败，
  结果是 agint-rules 挂不上、全部规则门禁消失，而且界面不报错。
  加表在 version 1 上是双向兼容的（老文件缺表 = 空表；新文件多表 = 老代码忽略）。
  守卫测试：`test/domain-version-compat.test.mjs`（用真实 json 后端跑通四个方向）。
- `audit()` 保持**同步**。`agint-metrics` 读 `rules.audit().totals` 时不 await，
  改成 Promise 会让 `rules.hits` / `rules.adherencePct` 静默变恒 0。
- 写盘失败只告警，不改拦截结果；内存计数照常累加，脏行留待下次重试。
- 行数上限 100（规则量级 28），超限按 `hits` 升序淘汰。
## 规则引擎自保护（v0.3.0，提案「护住规则引擎自身」）

### 起因（实测取证）

`rule_check(rule_set_enabled, {id, enabled:false})` → `NO_MATCH`；
`rule_list` 实况里没有一条规则覆盖 `rule_add` / `rule_remove` /
`rule_set_enabled` ⇒ **被门禁约束的 agent 可以把 deny 规则关掉**。
看守自己的锁由被看守者拆。

### 三条削弱路径被封死

| 路径 | 旧行为 | 新行为 |
|---|---|---|
| `rule_remove(deny 规则)` | 删掉 | 抛错拒绝（deny 规则在引擎内不可变） |
| `rule_set_enabled(deny 规则, false)` | 停用 | 抛错拒绝 |
| `rule_add` 改写既有 deny 规则 | 覆盖 | 抛错拒绝 |

仍然允许两件事：
- **新建**规则（新建 deny 是加固，不是削弱）。
- `enable(true)` —— 恢复生效不等于削弱约束。

`advisory` / `ask` 级规则不受此约束：日常运维不能被锁死。

### 补种口径

`seedIfEmpty()` 原本第一行就是「规则表非空就 return」⇒ 老装机永远拿不到
这三条 ⇒ 写在代码里的门禁形同虚设。现在三条自保护规则**无条件补种**
（与 `seedEpistemic` 同一个坑，不能重蹈）：

- 按 id 幂等：重复 boot 不重复播种。
- 已被「同 tool + 同 action + 同 pattern」的等价规则覆盖时跳过（避免 lint
  判成 `duplicate-pattern`）。
- 已存在但被停用（`enabled=false`）的自保护规则会被**重新启用** ——
  停用自保护规则正是要堵的失效形态。

### 人工解封

引擎内不可变 ⇒ 误建的 deny 规则无法用工具删。解封走 agint_rules 存储的
文件层 / 带签名写入路径（人工操作）。

### 守卫测试

`test/self-protection.test.mjs`（补种口径 5 条）
`test/audit-persist.test.mjs` 第 9 组（不可变三条路径 + 放行口径 3 条）
