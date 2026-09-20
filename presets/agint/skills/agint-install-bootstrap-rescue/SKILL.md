---
name: agint-install-bootstrap-rescue
description: "AGINT install / dsh 升级后任何 bootstrap 链路报警（zod 失败、preset 引用 RC 包、plugin require 失败）的三层应急救援。按症状查本 skill，10 分钟能恢复；不查直接抓 root 容易走偏。触发条件：install.sh 报 'bootstrap 失败' warn、dsh web 启动报 'row X names a plugin that cannot be resolved'、agint-* plugin 启动抛 MODULE_NOT_FOUND、或 dsh 升级 alpha/RC 后任何 preset picker 红字。"
tools:
  - bash
  - install.sh
  - agint-zod-bootstrap.sh
  - git
triggers:
  - "install.sh 报 zod bootstrap / zstd bootstrap 失败 warn"
  - "dsh web 启动报 row \"X\" names a plugin that cannot be resolved"
  - "agint-* plugin 启动抛 MODULE_NOT_FOUND（zod / zstd / sqlite / wasm 等）"
  - "dsh 升级 alpha/RC 后 preset picker 出现红字「加载失败」"
  - "新部署 AGINT 后智进 preset 工具链不全"
related_skills:
  - plugin-preflight
  - editing-cordis-compositions
  - cordis-plugin-development
  - memory-discipline

---

# AGINT install bootstrap 应急救援

按症状挑对应层做应急修复。每层独立可跑，**不需要**按顺序全套。

## 决策树（先看症状再决定做哪层）

```
dsh web 启动报 "row X names a plugin that cannot be resolved" ？
├── 是 → 跳到「层 1: preset 引用 RC 包」
└── 否 ↓

install.sh 报 "zod bootstrap 失败" / "zstd bootstrap 失败" warn ？
├── 是 → 跳到「层 2: install.sh 步骤顺序」
└── 否 ↓

dsh web 启动后 plugin 抛 MODULE_NOT_FOUND（zod / zstd / sqlite / wasm）？
├── 是 → 跳到「层 3: bootstrap 脚本路径优先级」
└── 否 → 不是本 skill 范围，查 plugin-preflight / editing-cordis-compositions
```

---

## 层 1: preset 引用 RC 包（症状：dsh web 启动报 row names plugin cannot be resolved）

### 5 分钟诊断

```sh
# 1. 看 host 上 preset 怎么写
grep -n "dsh-workflow\|dsh-tool-" /dsh/.agent-presets/agint/agent.cordis.yml | head -10

# 2. 看 dsh 全局实际带了哪些 dsh-* 包
ls /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/ | grep dsh-

# 3. 任何在 preset 引用但不在 dsh 全局的包 → 悬挂引用
```

### 应急修复

```sh
# A. 改 preset：用 dsh 默认 stable 替代（推荐）
# 编辑 /dsh/.agent-presets/agint/agent.cordis.yml
# 把 worker-thread 改成 ptc：
sed -i 's/workflow-worker-thread/workflow-ptc/g; s/dsh-workflow-worker-thread/dsh-workflow-ptc/g' \
  /dsh/.agent-presets/agint/agent.cordis.yml

# B. 装缺失的包到 dsh 全局（红线灰区，需老板显式授权）
cd /usr/lib/node_modules/@deepseek-ai/dsh && pnpm add @deepseek-ai/<missing-pkg>

# C. 装缺失的包到 profile（不触红线，profile 重建才会丢）
cd /dsh/profiles/web && pnpm add @deepseek-ai/<missing-pkg>
```

之后**重启 dsh web**（preset 改动必须重启才生效）。

### 防再次发生

任何 `@deepseek-ai/dsh-*` 包名引用**先查 dsh `package.json` 的 deps**：

```sh
grep '"@deepseek-ai/' /usr/lib/node_modules/@deepseek-ai/dsh/package.json
```

RC 包（`-rc.N`）永远视为不稳定——即使 dsh 之前用过，升 GA 时可能被砍。

---

## 层 2: install.sh 步骤顺序（症状：install.sh 报 bootstrap 失败 warn）

### 5 分钟诊断

```sh
# 1. 看 install.sh 步骤顺序
grep -B1 -A3 "^# ── [0-9]" /path/to/install.sh | head -40

# 2. 看 zod / 任何 bootstrap 包是否被删
ls -la /dsh/profiles/web/plugins/agint-quality/node_modules/ 2>&1
```

如果**步骤 2 在 zod bootstrap 之前**——经典顺序 bug。

### 应急修复（立即补 zod）

```sh
# 选项 A: 手动 npm pack + 解压（不联网版不行时）
cd /tmp && mkdir -p zod-bootstrap && cd zod-bootstrap
npm pack zod@^4
tar -xzf zod-*.tgz -C /dsh/profiles/web/plugins/agint-quality/node_modules/
[ -d package ] && mv package zod

# 选项 B: 跑 zod bootstrap 脚本（会找本地源）
bash install/agint-zod-bootstrap.sh
```

### 防再次发生

如果你是 AGINT 维护者，**`install.sh` 里任何 `install/agint-*-bootstrap.sh` 必须在步骤 2（plugins 同步）之前**。位置参考当前 install.sh 的 `1.5` 段。

---

## 层 3: bootstrap 脚本路径优先级（症状：层 2 修复后 4.5 兜底段仍失败）

### 5 分钟诊断

```sh
# 看 bootstrap 脚本的 find_local_zod 之类的 find 函数
grep -B2 -A10 "find_local" install/agint-zod-bootstrap.sh

# 实际本机存在哪些 zod 源？
find /dsh/profiles -name "zod" -type d 2>/dev/null
find /dsh/profiles -name "zod" -type l 2>/dev/null
```

### 应急修复

如果脚本优先级列表里漏了 `profiles/node_modules/`（profiles 层级，跨平台恒成立），加上：

```sh
# 编辑 install/agint-zod-bootstrap.sh 的 find_local_zod
# 在 roots 数组首位加：
"${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/zod"
```

### 防再次发生

bootstrap 脚本的"本地源优先级"应该用**跨平台恒成立**的路径作为首选，macOS-only 路径（如 `~/文档/...`）降级为兼容项。

---

## 完整自愈验证脚本（5 分钟）

```sh
#!/bin/bash
# 跑这个脚本可以验证 install.sh 当前是否自愈
set -uo pipefail

AGINT_HOME="${AGINT_HOME:-/workspace/DSH-AGINT/DSH-AGINT源码}"
DSH_HOME="${DSH_HOME:-/dsh}"

echo "=== 1. 删 zod 模拟干净起点 ==="
rm -rf "$DSH_HOME/profiles/web/plugins/agint-quality/node_modules/zod"

echo "=== 2. 跑 install.sh（应能看到 1.5 + 4.5 两段都 OK）==="
AGINT_HOME="$AGINT_HOME" bash "$AGINT_HOME/install/install.sh" 2>&1 \
  | grep -E "zod bootstrap OK|⚠ zod bootstrap|✅ 安装完成"

echo "=== 3. 验证 5 个 module 都能 import ==="
node --input-type=module -e "
const tests = [
  '$DSH_HOME/profiles/web/plugins/agint-quality/agint-quality-contract/lib/index.js',
  '$DSH_HOME/profiles/web/plugins/agint-quality/agint-quality-eval/lib/index.js',
  '$DSH_HOME/profiles/web/plugins/agint-quality/agint-quality-policy/lib/index.js',
  '$DSH_HOME/profiles/web/plugins/agint-quality/agint-quality-report/lib/index.js',
  '$DSH_HOME/profiles/web/plugins/agint-quality-sandbox/lib/index.js',
];
let ok = 0;
for (const p of tests) {
  try { await import(p); ok++; console.log('✓', p.replace('$DSH_HOME/profiles/web/plugins/', '')); }
  catch (e) { console.log('✗', p.replace('$DSH_HOME/profiles/web/plugins/', ''), '|', e.message.split(String.fromCharCode(10))[0]); }
}
console.log(ok === tests.length ? '全部 OK → 可以安全重启 dsh web' : '失败 ' + (tests.length - ok));
"

echo ""
echo "=== 4. 如果全 OK，重启 dsh web ==="
echo "    dsh web  # 或 agint-restart plugin"
```

---

## 完整复盘（详细背景）

[`docs/lessons/v0.7.1-install-bootstrap-rescue.md`](../../../docs/lessons/v0.7.1-install-bootstrap-rescue.md) — 本次 v0.7.1 三层修复的完整复盘，包括 commit `fe9f3fd` 和 `6524f73` 的所有细节。

## AGINT↔dsh 兼容矩阵

[`VERSION`](../../../VERSION) — 升级前**第一份**要看的文档。表格列出每个 AGINT 版本对应的 dsh minimum / tested。

## 我是谁 / 边界

- **适用**：AGINT 升级、dsh 升级、新部署 AGINT 后任何 bootstrap 链路报警
- **不适用**：plugin 自身代码 bug（查 `plugin-preflight` skill）；preset / cordis.patch.yml 编排错误（查 `editing-cordis-compositions`）
- **砍掉**：12 步线性排障 SOP——AGINT 的 bootstrap 链路只有 3 层（preset 引用、install 顺序、bootstrap 优先级），决策树更快
