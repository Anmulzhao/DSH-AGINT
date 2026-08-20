# agint-rules

> 规则门禁：在工具调用流水线上强制执行一组规则。
>
> v0.2 起与 `docs/security-boundary.md` 联动：启动时从 `security-boundary.yaml` 同步生成 deny 规则。

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

启动时若规则表为空，自动种入两条来源：

### AGINT 内置规则（人类可管理）

| id | tool | pattern | action |
|---|---|---|---|
| `bash-rm-rf-root` | bash | `rm -rf /?$` | deny |
| `bash-git-push-force-main` | bash | `git push --force(.*) origin main` | ask |
| `bash-npm-publish` | bash | `(npm\|pnpm) publish` | advisory |

### 安全边界同步规则（v0.2 起，启动时从 `security-boundary.yaml` 同步，**默认 deny**）

| id | 触发 | 行为 |
|---|---|---|
| `bash-touch-root` | 任何路径含 `/root` | deny |
| `bash-touch-etc` | 任何路径含 `/etc` | deny |
| `bash-read-ssh-key` | 路径 `~/.ssh/.*` | deny |
| `bash-read-secret` | `\.env$\|\.env\.\|\.pem$\|\.key$\|secrets/` | deny |
| `bash-bypass-sandbox` | `unshare -rn\|chroot\|mount ` | deny |
| `bash-edit-security-boundary` | `security-boundary\.yaml` | deny |
| `delete-evolution-log` | `agint_evolution/evolution-log/` | deny |
| `web-leak-secret` | `sk-\|token=\|key=\|passwd=` | deny |

完整映射表见 `docs/security-boundary.md` 第三章。

可用 `rule_remove` 删除或 `rule_set_enabled` 禁用（但禁用必须写入 `agint.memory` 审计日志）。

## 红色操作清单（不可妥协）

以下规则不管人类怎么操作都不能关：

- `bash-touch-root` / `bash-touch-etc` / `bash-read-ssh-key`
- `bash-edit-security-boundary` / `delete-evolution-log`

详细红线条目见 `docs/security-boundary.md` 第四章。

## schema

```yaml
id:       string  # 唯一
tool:     string  # '*' 表示所有工具
pattern:  string  # 正则源串
flags:    string  # 正则 flags
action:   advisory | ask | deny
level:    L1 | L2 | L3 | L4
frozenness: L0-frozen | L1-revocable | L2-delegable  # v0.1.1 起（提案 a6ba79a3）
reason:   string
enabled:  boolean
```

> **frozenness 字段**与 `agint-quality-contract` 的 L0/L1/L2 边界对齐——L0-frozen 规则的修改走人类多签路径。

## 与其他插件的关系

- **`agint.metrics`**：`rules.adherencePct` / `rules.denyHits` 指标采集
- **`agint.evolve`**：复盘时审计规则有效性
- **`agint.quality.contract`**：frozenness 字段概念对齐 L0/L1/L2 边界
- **`security-boundary.yaml`**（v0.2 计划）：启动时同步硬约束规则

## 测试

`test.mjs`：deny/ask/advisory 三路径的 waterfall 行为 + 种子规则验证。

## 文件

```
lib/index.js   Cordis apply()：注册 agint.rules + waterfall 监听
lib/tools.js   rule_* model 工具
test.mjs       standalone test（无 vitest 依赖）
README.md      原 README（保留）
```
