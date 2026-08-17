# agint-rules

> 规则门禁：在工具调用流水线上强制执行一组规则。

## 职责

- 提供 `agint.rules` host Service
- 提供 `rule_*` model 工具（check / list / audit / lint / add / remove / set_enabled）
- 独占 `agint_rules` storage domain（与 `agint` domain 互斥）

## 三种动作

| action | 触发位置 | 行为 |
|---|---|---|
| `deny` | `tools/pre-execute` | 硬阻断，直接拒绝执行 |
| `ask` | `tools/pre-execute` | 模型必须显式 confirm/reject 一次 |
| `advisory` | `tools/post-execute` | 注入 additionalContexts，模型必看到但可忽略 |

## 种子规则

启动时若规则表为空，自动种入 3 条：

| id | tool | pattern | action |
|---|---|---|---|
| `bash-rm-rf-root` | bash | `rm -rf /?$` | deny |
| `bash-git-push-force-main` | bash | `git push --force(.*) origin main` | ask |
| `bash-npm-publish` | bash | `(npm|pnpm) publish` | advisory |

可用 `rule_remove` 删除或 `rule_set_enabled` 禁用。

## schema

```yaml
id:       string  # 唯一
tool:     string  # '*' 表示所有工具
pattern:  string  # 正则源串
flags:    string  # 正则 flags
action:   advisory | ask | deny
level:    L1 | L2 | L3 | L4
reason:   string
enabled:  boolean
```

## 与其他插件的关系

- **`agint.metrics`**：`rules.adherencePct` / `rules.denyHits` 指标采集
- **`agint.evolve`**：复盘时审计规则有效性

## 测试

`test.mjs`：deny/ask/advisory 三路径的 waterfall 行为 + 种子规则验证。

## 文件

```
lib/index.js   Cordis apply()：注册 agint.rules + waterfall 监听
lib/tools.js   rule_* model 工具
test.mjs       standalone test（无 vitest 依赖）
README.md      原 README（保留）
```