# eval/scenarios · 评估场景集

> AGINT 评估用例的最小可行集。基于 `DSH自进化系统整体优化改进方案.md` §5.1 建议，**前置到 P2 初期**作为 `agint-quality-eval` 的伴随开发产物。
>
> **目标**：P2 交付时评估引擎在最小场景集上的准确率 ≥ 90%。

---

## 适用范围

每个核心插件至少 1 个**冒烟测试**场景。场景输入 = 模拟工具调用事件，期望输出 = Service 行为。

> **不在本最小集范围内**（v0.3+ 扩展）：
> - 端到端闭环（cron → dream → memory → metrics → evolve → quality）
> - 沙箱动态执行（v0.3 引入）
> - 灰度发布（v0.4 引入）

---

## 场景集设计

### 1. `agint-memory` 冒烟测试

```yaml
scenario: memory-write-and-read
plugin: agint-memory
input:
  - service: memory
    action: write
    args: { type: "lesson", content: "测试教训", evidence: "test:eval:1" }
expected:
  - service returns { id: "..." }
  - storage file $DSH_HOME/storages/agint.json contains the entry
  - memory.read(id) returns the same entry
```

### 2. `agint-rules` 冒烟测试

```yaml
scenario: rules-deny-rm-rf-root
plugin: agint-rules
input:
  - service: rules
    action: check
    args: { tool: "bash", args: { command: "rm -rf /" } }
expected:
  - service returns { action: "deny", ruleId: "bash-rm-rf-root" }
  - bash tool blocked by tools/pre-execute waterfall
```

### 3. `agint-metrics` 冒烟测试

```yaml
scenario: metrics-collect-and-summary
plugin: agint-metrics
input:
  - service: metrics
    action: collect
expected:
  - storage file $DSH_HOME/storages/agint_metrics.json contains today's snapshot
  - metrics.summary returns latest values + delta
```

### 4. `agint-cron` 冒烟测试

```yaml
scenario: cron-time-parse
plugin: agint-cron
input:
  - service: cron
    action: parse
    args: { expression: "30 4 * * 0" }
expected:
  - service returns { valid: true, nextFire: "2026-08-24T04:30:00+08:00" }
  - cron_health shows all 6 jobs healthy
```

### 5. `agint-dream` 冒烟测试

```yaml
scenario: dream-sweep-dry-run
plugin: agint-dream
input:
  - service: dream
    action: runNow
    args: { dryRun: true }
expected:
  - dream diary file written
  - memory NOT written (dry-run)
  - metrics.dream.sweepCount incremented
```

### 6. `agint-evolve` 冒烟测试

```yaml
scenario: evolve-review-dry-run
plugin: agint-evolve
input:
  - service: evolve
    action: review
    args: { dryRun: true }
expected:
  - review file written to $AGINT_HOME/reviews/YYYY-MM-DD.md
  - report contains `## 哲学对齐检查` section (v0.2+ 强制)
  - report contains `## 自动发现` section
```

### 7. `agint-tool-stats` 冒烟测试

```yaml
scenario: tool-stats-aggregate
plugin: agint-tool-stats
input:
  - service: toolStats
    action: summary
expected:
  - service returns aggregated stats per tool
  - throttled at 5/hour
```

### 8. `agint-quality` 冒烟测试

```yaml
scenario: quality-get-config
plugin: agint-quality-contract
input:
  - service: quality
    action: getConfig
expected:
  - returns default QualityConfig
  - harmWeights = { H: 0.2, A: 0.3, R: 0.3, M: 0.2 }
```

### 9. `agint-quality-eval` 冒烟测试

```yaml
scenario: quality-eval-self-rejection
plugin: agint-quality-eval
input:
  - service: qualityEvaluator
    action: evaluate
    args: { target: { id: "agint-quality-eval", kind: "plugin" } }
expected:
  - throws error: "self-evaluation forbidden"
  - ensures no recursive evaluation
```

### 10. `agint-wiki` 冒烟测试

```yaml
scenario: wiki-write-read-lint
plugin: agint-wiki
input:
  - service: wiki
    action: write
    args: { path: "test/example.md", content: "..." }
  - service: wiki
    action: read
    args: { path: "test/example.md" }
  - service: wiki
    action: lint
expected:
  - file written
  - read returns same content
  - lint reports no broken links
```

---

## 运行方式

### 手动（v0.2）

```sh
# 启动 dsh web
dsh web

# 跑场景集
cd ~/projects/AGINT
node eval/scenarios/run-minimal.mjs
# 期望：通过率 ≥ 90%
```

### CI（v0.3 计划）

```yaml
# .github/workflows/agint-eval.yml
on: [push, pull_request]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: ./install/install.sh
      - run: dsh web &
      - run: sleep 30
      - run: node eval/scenarios/run-minimal.mjs
      - run: |
          if [ $(jq '.passRate' eval/scenarios/results.json) -lt 90 ]; then
            exit 1
          fi
```

---

## 场景扩展规则

新增场景必须满足：

1. **每个核心插件至少 1 个冒烟测试**（v0.2 起点）
2. **测试输入清晰**：模拟工具调用事件
3. **期望输出明确**：Service 行为 + 存储变化
4. **无外部依赖**：除 dsh runtime 外不依赖网络 / 第三方 API
5. **可独立运行**：单场景失败不影响其他场景

---

## 验收标准

| 版本 | 场景集规模 | 通过率门槛 |
|---|---|---|
| **v0.2**（当前） | 10 个核心插件冒烟测试 | ≥ 90% |
| v0.3 | 10 个冒烟 + 5 个集成 + 3 个沙箱 | ≥ 95% |
| v0.4 | 完整 e2e 闭环 | ≥ 98% |

---

## 与 D-QAF 评估的关系

- 场景集是**外部评估**（独立于 D-QAF 自身）
- D-QAF 评估的"准确率"用场景集通过率衡量
- 场景集变更要走 `evolve_propose` 流程（防止频繁变化影响评估稳定性）

---

## 相关文档

- `docs/evolution-framework.md` 第五章：预算对齐
- `docs/architecture.md` 数据流
- `docs/dsh-integration.md` 升级 dsh 时怎么测
- `路线图` P2/P3 阶段任务

---

## 怎么跑（Sprint 1.3 实装）

### 一次性 setup（dev only）

AGINT plugin 是 dsh 的扩展，不应该自包含 runtime 包。`eval/setup.sh`
把全局 dsh 安装里的 transitive deps 软链到 `plugins/*/node_modules` 和
`eval/node_modules`，让 plugin 在测试中能解析 `@deepseek-ai/dsh-*` 和 `zod`。

```sh
# 检查环境（不写文件）
./eval/setup.sh --check

# 实际建软链
./eval/setup.sh
```

软链全部进 `.gitignore`（`node_modules/`、`**/node_modules/`），不会污染仓库。

### 跑测试

```sh
# 跑全部 5 个核心 plugin 冒烟（共 7 个场景）
node eval/scenarios/driver.js

# 单跑一个 plugin
node eval/scenarios/driver.js --file=agint-memory
```

或 `cd eval && npm test`（`eval/package.json` 里定义了 scripts）。

### 场景集当前状态（Sprint 1.3 落地）

| 插件 | 场景 | 覆盖路径 |
|---|---|---|
| agint-memory | `memory-write-read` | 真实 service `apply(ctx)` + `memory.write/read` |
| agint-rules | `rules-deny-rm-rf-root` | 真实 service `apply(ctx)` + `rules.seedIfEmpty/check` |
| agint-metrics | `metrics-compute-empty-sources` + `metrics-compute-cron-source` | 纯函数 `computeMetrics` |
| agint-cron | `cron-parse-and-nextFire` + `cron-default-jobs-registered` | 纯函数 `parseCron/nextFire` + `defaultJobs` 注册表 |
| agint-dream | `dream-gate-thresholds` | 纯函数 `gateCandidates`（commit 0adf37b 阈值 0.75/3/2） |

**当前结果：7/7 通过**（commit Sprint 1.3 时锁定）。

### 不在 Sprint 1.3 范围内

按老板拍板的"agint-quality-eval 留 Sprint 1.4 用合成候选"决策：
- ❌ `agint-quality-eval` 自身场景（Sprint 1.4）
- ❌ `agint-quality-contract` 场景（Sprint 1.4）
- ❌ `agint-evolve` / `agint-wiki` / `agint-tool-stats` 场景（v0.3+ 扩展）

### 已知设计取舍

1. **Service apply() 路径只测 memory / rules**：这两个 plugin 的核心契约就是 service 方法；metrics / cron / dream 测纯函数（核心算法），因为它们的 service 装配依赖 storage domain / timer / 文件系统，mock 成本不成比例。Sprint 2.A `agint-quality-sandbox` 会用真沙箱覆盖 service 集成路径。
2. **JSON 而非 YAML**：避免引入 `yaml` npm 依赖（AGINT 仓不引入第三方运行时依赖）。如果未来人类可读性更重要，可换成 ts/js 字面量或自写迷你 parser。
3. **软链 dsh 包**：`eval/setup.sh` 必须先跑，否则 driver 报 `Cannot find package '@deepseek-ai/dsh-storage-domain'`。
4. **TZ 假设**：cron 测例用 dynamic assertion（dow=0, hh=4, mm=30），避免硬编码 ISO 受 host 时区影响。
