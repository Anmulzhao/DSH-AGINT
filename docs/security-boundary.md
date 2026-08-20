# 安全边界 · Security Boundary

> AGINT 的硬约束清单。把"哪些操作在任何 HARM 分数下都禁止"明文化。
>
> **核心原则**：所有约束**在 dsh 启动阶段即生效**，不依赖任何 plugin。`agint-rules` 与 `agint-quality-contract` 互为冗余校验。
>
> **本文是 `dsh-security-boundary.yaml` 的人类可读版本**。YAML 形式的源文件见 `install/dsh-security-boundary.yaml`（v0.3 落地）。

---

## 一、硬约束清单（hard_constraints）

> 任何 plugin / preset / skill / skill 调用违反这些约束 → 直接 `deny`，不询问。

### 1.1 不可修改的层（与 L0-frozen 边界对齐）

| 约束 | 触发动作 | 错误码 |
|---|---|---|
| **禁止修改 D-QAF 自身评估逻辑** | 任何对 `agint-quality-eval` 的修改涉及 `evaluators.js` 或 `scheduler.js` 的核心算法 | `L0_FROZEN_VIOLATION` |
| **禁止修改 HARM 维度定义** | 任何对 `agint-quality-contract` 的 HARM schema 字段做结构性变更 | `L0_FROZEN_VIOLATION` |
| **禁止修改决策枚举** | 新增 / 删除 / 重命名 `DecisionKind` 的值 | `L0_FROZEN_VIOLATION` |
| **禁止修改哲学锚点** | 任何代码 / 文档修改 `PHILOSOPHY.md` 的五大原则 | `L0_FROZEN_VIOLATION` |
| **禁止修改 `security-boundary.yaml` 自身** | bash 写 / 删除 / 重命名该文件 | `BOUNDARY_SELF_MODIFY` |

### 1.2 不可逾越的权限

| 约束 | 触发动作 |
|---|---|
| **禁止访问宿主机的 `/root`、`/etc`、`/etc/ssh`、`~/.ssh/`** | 任何工具调用涉及这些路径 |
| **禁止读取 secret 文件** | 任何工具读取 `.env` / `.env.*` / `secrets/` / `*.pem` / `*.key` |
| **禁止外发敏感数据** | 任何 `web_search` / `feishu_send` / 第三方 API 调用涉及 token / key / 老板私人消息 |
| **禁止绕过沙盒** | bash 调用尝试 `unshare -rn` / `chroot` / `mount` 等 |
| **禁止 fork 子进程执行非沙盒代码** | bash 调用 `nohup` / `setsid` / `disown` 后执行的非 `agint-rules` 白名单内命令 |

### 1.3 变更规模

| 约束 | 触发动作 |
|---|---|
| **单次进化变更的代码行数上限：500 行** | git diff 超过 500 行 → 拒绝合并 |
| **新增外部依赖必须通过 CVE 扫描** | `package.json` 新增外部依赖 → 需 `npm audit` 通过 |
| **新增 plugin 必须先提交接口契约** | 新增 `plugins/agint-*/` → 必须先有 `docs/plugins/agint-*.md` 一份 |
| **D-QAF 评估必须附带回归测试** | 任何提交 D-QAF 评估的组件 → 至少 5 个回归用例 |

### 1.4 人类否决权

| 约束 | 触发动作 |
|---|---|
| **L0 字段变更需要人类审批** | 任何 patch 涉及 `agint-quality-contract` 的 L0 字段 |
| **自动部署 ≤ 3 次/周** | 周累计超过 3 次自动部署 → 强制人工审核队列 |
| **核心契约（contract）变更需 7 天影子模式** | 任何对 `agint-quality-contract` 的 patch 必须先经 7 天影子模式验证 |
| **破坏性变更（major 版本）必须有迁移计划** | semver major → 必须有 `docs/migration/v{major}.md` 文档 |

### 1.5 进化记忆保护

| 约束 | 触发动作 |
|---|---|
| **禁止删除历史演进日志** | `agint_evolution/evolution-log/` 任何文件 → 拒绝 delete |
| **禁止修改历史评估记录** | `agint.memory` 中 `type: decision` 的记录 → 拒绝 write 覆盖 |
| **禁止跳跃 D-QAF 阶段** | 直接对 Phase 4 灰度而未通过 Phase 1/2/3 → 拒绝部署 |

---

## 二、沙盒权限（sandbox_permissions）

> 任何 D-QAF Phase 2 沙箱执行（含 `agint-quality-sandbox` 内部调用）必须遵守的配置。

```yaml
sandbox_permissions:
  network:         denied              # 完全断网
  filesystem:      read-only           # 除指定工作目录外只读
  writable_paths:
    - "$AGINT_HOME/eval/scenarios/_runs/"
    - "$TMPDIR/agint-sandbox/"
  process:         no-fork, no-exec    # 禁止 fork / exec 新进程
  max_execution_time: 300s             # 5 分钟硬上限
  max_memory:      512MB               # 内存硬上限
  max_cpu:         1.0                 # 1 核等价
  syscall_filter:  default-deny        # 白名单 syscall（仅 read / write / exit / mmap 等）
  user_namespace:  isolated            # 用户命名空间隔离
```

### 2.1 工作目录白名单

- **唯一可写目录**：`$AGINT_HOME/eval/scenarios/_runs/`（评估运行产物）
- **临时目录**：`$TMPDIR/agint-sandbox/`（沙箱自身用）
- **所有其他路径**：`read-only`

### 2.2 系统调用白名单

默认拒绝，仅允许：

- `read` / `write` / `open` / `close` / `stat` / `fstat`
- `mmap` / `munmap` / `brk`
- `exit` / `exit_group`
- `clock_gettime` / `gettimeofday`
- 任何涉及 `ptrace` / `kexec_load` / `init_module` / `setns` → 拒绝

### 2.3 资源硬上限

- **执行时间**：300 秒（5 分钟）
- **内存**：512 MB
- **CPU**：1.0 核等价
- **文件描述符**：64 个
- **子进程**：0 个（`no-fork`）

---

## 三、规则门禁映射（落地到 `agint-rules`）

> `agint-rules` 启动时从 `security-boundary.yaml` 同步生成 deny 规则。两边互为冗余校验。

| 硬约束 | `agint-rules` 规则 id | 工具 | 模式 |
|---|---|---|---|
| 禁止访问 `/root` | `bash-touch-root` | bash | `(cd \|ls \|cat \|rm )?/root` |
| 禁止访问 `/etc` | `bash-touch-etc` | bash | `(cd \|ls \|cat )?/etc` |
| 禁止读 SSH 密钥 | `bash-read-ssh-key` | bash | `~/.ssh/.*` |
| 禁止读 secret | `bash-read-secret` | bash | `\.env$\|\.env\.\|\.pem$\|\.key$\|secrets/` |
| 禁止 `rm -rf /` | `bash-rm-rf-root` | bash | `rm -rf /?$` |
| 禁止绕过沙盒 | `bash-bypass-sandbox` | bash | `unshare -rn\|chroot\|mount ` |
| 禁止外发敏感 | `web-leak-secret` | web_search / feishu_send | `sk-\|token=\|key=\|passwd=` |
| 禁止改 boundary | `bash-edit-security-boundary` | bash | `security-boundary\.yaml` |
| 禁止删除 evolution-log | `delete-evolution-log` | bash | `agint_evolution/evolution-log/` |

种子规则列表（已内置）见 `docs/plugins/agint-rules.md`。

---

## 四、变更审批流程

### 4.1 L0 字段变更

```
1. 提交 PR（带 L0 变更标记）
   ↓
2. CI 失败（防呆：检测到 L0 字段修改）
   ↓
3. 老板 + 老板指定 1 人人类多签
   ↓
4. 影子模式验证 7 天
   ↓
5. 通过 → 合并 + 发 major 版本 + 旧版本保留 3 个 minor 周期
   失败 → 拒绝合并 + 写 failure-patterns
```

### 4.2 红色操作（无任何修改路径）

以下操作**任何情况下都不能做**：

- 删除 `agint_evolution/evolution-log/` 任何文件
- 关闭 `agint-rules` 全部 deny 规则
- 绕过 `agint-quality-contract` 的 `validatePatch` 校验
- 修改 `PHILOSOPHY.md` 五大原则
- 跳过 D-QAF 任意阶段直接部署

---

## 五、未涵盖场景

- **多 Agent 协同进化**：P5+ 引入，多 Agent 间的信任边界需新增硬约束
- **Plugin Marketplace**：P4 引入，第三方 Plugin 的供应链审计（SBOM / 签名）需新增硬约束
- **云端部署**：当前边界假设宿主可信；云端部署需新增网络层隔离

---

## 六、相关文档

- `docs/evolution-framework.md` 第八章：不变量与红线
- `docs/dsh-integration.md` D-QAF 安全边界
- `docs/plugins/agint-rules.md` 规则门禁
- `docs/plugins/agint-quality.md` 契约层 L0/L1/L2 边界
- `PHILOSOPHY.md`「安全 > 效率」原则
- `AGENTS.md` 边界（不要伪造老板的话等）
