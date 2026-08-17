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

## 验收

启动级诊断（在 web profile 关闭 HMR 期间验证）：
- `agint.rules` 服务在 host fiber 中可见
- `tools.schemas(scope)` 列出 7 个 rule_* 工具
- `rule_list` 返回种子规则 3 条
- `rule_check({tool:'bash', args:{command:'rm -rf /'}})` 命中 deny
- `rule_check({tool:'bash', args:{command:'npm publish'}})` 命中 advisory
- `rule_audit` 返回 hits/totals 计数