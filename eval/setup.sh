#!/usr/bin/env bash
# eval/setup.sh — 把 dsh runtime 包符号链接到 AGINT 仓的 node_modules，
#   让 plugin 在 eval/scenarios 测试中能解析 '@deepseek-ai/dsh-storage-domain'
#   / '@deepseek-ai/dsh-tools' / 'zod'。
#
# 设计：AGINT plugin 是 dsh 的扩展，不应该自包含 runtime 包。这个脚本
#   把全局 dsh 安装里的 transitive deps 软链到 AGINT 仓，是 dev-only
#   setup，不进 git（所有 node_modules 都已 .gitignore）。
#
# 用法：
#   ./eval/setup.sh            # 一次性 setup
#   ./eval/setup.sh --check    # 只检查，不改文件
#
# 要求：已 `npm i -g @deepseek-ai/dsh` 或 `dsh web` 至少跑过一次（建 $DSH_HOME）。

set -euo pipefail

AGINT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_GLOBAL_NM="$(npm root -g)/@deepseek-ai/dsh/node_modules"
DSH_DEEP_NM="$DSH_GLOBAL_NM/@deepseek-ai"  # @deepseek-ai/* deps live one level deeper
PLUGINS=(
  agint-memory agint-rules agint-metrics agint-cron agint-dream
  agint-quality agint-quality-contract agint-quality-eval
  agint-evolve agint-wiki agint-tool-stats
)
DEEPSEEK_DEPS=(dsh-storage-domain dsh-tools)
TOP_DEPS=(zod)

CHECK_MODE=false
[ "${1:-}" = "--check" ] && CHECK_MODE=true

# 1. 检查 dsh runtime 是否装好
if [ ! -d "$DSH_GLOBAL_NM" ]; then
  echo "ERROR: dsh runtime not found at $DSH_GLOBAL_NM" >&2
  echo "  请先安装: npm i -g @deepseek-ai/dsh 或 dsh web 至少跑过一次" >&2
  exit 1
fi

missing=()
for dep in "${DEEPSEEK_DEPS[@]}"; do
  if [ ! -d "$DSH_DEEP_NM/$dep" ]; then missing+=("$dep"); fi
done
for dep in "${TOP_DEPS[@]}"; do
  if [ ! -d "$DSH_GLOBAL_NM/$dep" ]; then missing+=("$dep"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: missing dsh deps: ${missing[*]}" >&2
  echo "  looked under: $DSH_DEEP_NM and $DSH_GLOBAL_NM" >&2
  exit 1
fi

if $CHECK_MODE; then
  echo "OK: dsh runtime at $DSH_GLOBAL_NM"
  echo "     @deepseek-ai deps: ${DEEPSEEK_DEPS[*]}"
  echo "     top-level deps:   ${TOP_DEPS[*]}"
  exit 0
fi

# 2. 给每个 plugin 建 node_modules + 软链到 dsh runtime
linked=0
for plugin in "${PLUGINS[@]}"; do
  plugin_nm="$AGINT_ROOT/plugins/$plugin/node_modules"
  mkdir -p "$plugin_nm/@deepseek-ai"
  for dep in "${DEEPSEEK_DEPS[@]}"; do
    target="$plugin_nm/@deepseek-ai/$dep"
    [ -L "$target" ] && continue
    ln -sf "$DSH_DEEP_NM/$dep" "$target"
    linked=$((linked + 1))
  done
  for dep in "${TOP_DEPS[@]}"; do
    target="$plugin_nm/$dep"
    [ -L "$target" ] && continue
    ln -sf "$DSH_GLOBAL_NM/$dep" "$target"
    linked=$((linked + 1))
  done
done

# 3. eval 目录自己的 node_modules (driver 自身解析路径)
eval_nm="$AGINT_ROOT/eval/node_modules"
mkdir -p "$eval_nm/@deepseek-ai"
for dep in "${DEEPSEEK_DEPS[@]}"; do
  target="$eval_nm/@deepseek-ai/$dep"
  [ -L "$target" ] && continue
  ln -sf "$DSH_DEEP_NM/$dep" "$target"
  linked=$((linked + 1))
done
for dep in "${TOP_DEPS[@]}"; do
  target="$eval_nm/$dep"
  [ -L "$target" ] && continue
  ln -sf "$DSH_GLOBAL_NM/$dep" "$target"
  linked=$((linked + 1))
done

echo "OK: linked $linked symlinks across ${#PLUGINS[@]} plugins + eval/"
echo "  Run: node eval/scenarios/driver.js"
