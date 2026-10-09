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

# ── 定位 dsh 真身（2026-10-09 修）──────────────────────────────────────────
# ⛔ 原实现是 `npm root -g`，它跟随 PATH 里的**首个** npm。本机首个 npm 是
#    托管那份（前缀在沙箱），答出来的目录里根本没有 dsh ⇒ 本脚本恒失败
#    （"dsh runtime not found"），于是「跑 driver 前先跑 setup.sh」这条纪律
#    在本机根本执行不了，而失败被当成「环境本来就那样」放过。
#    候选顺序照抄 install/install.sh 的 locate_dsh_dir（2026-10-07 已修同一坑）：
#    ① $DSH_ROOT 显式指定（验 package.json 真身）
#    ② dsh 可执行文件反推 <prefix>/lib/node_modules/@deepseek-ai/dsh（dsh 不在
#       PATH 时兜底扫 nvm 各版本）
#    ③ $DSH_HOME/.agint-deps/dsh-runtime（AGINT 自带，随 DSH_HOME 走）
#    ④ npm root -g（可能答错，放最后）
#    ⑤ 常见硬编码前缀
# ⛔ 每一级都必须验 package.json 里的 "@deepseek-ai/dsh" —— 不验会拿到
#    「存在但不是 dsh」的目录，症状比定位失败更隐蔽（失败有报错，错指则静默建错链）。
locate_dsh_dir() {
  local c resolved dsh_bin nb prefix
  if [ -n "${DSH_ROOT:-}" ] && [ -f "$DSH_ROOT/package.json" ] \
     && grep -q '"@deepseek-ai/dsh"' "$DSH_ROOT/package.json" 2>/dev/null; then
    printf '%s' "$DSH_ROOT"; return 0
  fi
  dsh_bin="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$dsh_bin" ]; then
    for nb in "$HOME"/.nvm/versions/node/*/bin/dsh; do
      [ -x "$nb" ] && { dsh_bin="$nb"; break; }
    done
  fi
  if [ -n "$dsh_bin" ]; then
    prefix="$(cd "$(dirname "$dsh_bin")/.." 2>/dev/null && pwd)"
    for resolved in "$prefix/lib/node_modules/@deepseek-ai/dsh" \
                   "$(cd "$(dirname "$(readlink -f "$dsh_bin" 2>/dev/null || printf '%s' "$dsh_bin")")/../.." 2>/dev/null && pwd)/lib/node_modules/@deepseek-ai/dsh"; do
      if [ -f "$resolved/package.json" ] && grep -q '"@deepseek-ai/dsh"' "$resolved/package.json" 2>/dev/null; then
        printf '%s' "$resolved"; return 0
      fi
    done
  fi
  for c in "${DSH_HOME:-$HOME/.dsh}/.agint-deps/dsh-runtime"; do
    if [ -f "$c/package.json" ] && grep -q '"@deepseek-ai/dsh"' "$c/package.json" 2>/dev/null; then
      printf '%s' "$c"; return 0
    fi
  done
  for c in "$(npm root -g 2>/dev/null)/@deepseek-ai/dsh"; do
    if [ -f "$c/package.json" ] && grep -q '"@deepseek-ai/dsh"' "$c/package.json" 2>/dev/null; then
      printf '%s' "$c"; return 0
    fi
  done
  for c in "/usr/local/lib/node_modules/@deepseek-ai/dsh" \
           "/usr/lib/node_modules/@deepseek-ai/dsh"; do
    if [ -f "$c/package.json" ] && grep -q '"@deepseek-ai/dsh"' "$c/package.json" 2>/dev/null; then
      printf '%s' "$c"; return 0
    fi
  done
  return 1
}

DSH_DIR="$(locate_dsh_dir || true)"
if [ -z "$DSH_DIR" ]; then
  echo "ERROR: 未能定位 dsh 安装目录（DSH_ROOT / dsh 可执行文件 / \$DSH_HOME 自带 / npm root -g 全落空）" >&2
  echo "  请先安装: npm i -g @deepseek-ai/dsh，或设 DSH_ROOT=<dsh 包目录>" >&2
  exit 1
fi
DSH_GLOBAL_NM="$DSH_DIR/node_modules"
DSH_DEEP_NM="$DSH_GLOBAL_NM/@deepseek-ai"  # @deepseek-ai/* deps live one level deeper
PLUGINS_DISCOVERED=()
DEEPSEEK_DEPS=(dsh-storage-domain dsh-tools)
TOP_DEPS=(zod)

# 插件清单**自动发现**（2026-10-04 改）。
#
# 为什么不再手写：此前 PLUGINS 是硬编码的 11 项，而仓库实有 40 个插件。
# 每新增一个插件就要记得同步这个列表，漏一个 ⇒ 该插件的单元在 driver 里
# 全部报「Cannot find package 'zod'」⇒ **纯环境缺链被误计为内容层 fail**。
# 实测这个坑很贵：漏登记时 driver 报 37 failed，补齐后 10 failed，
# 27 个是环境噪音。判据类结论（fail 数 → H1/H3 配额）对这 27 个假 fail 极其敏感。
# 硬编码列表本身就是 bug 源，改成扫描目录后新增插件自动被覆盖。
#
# 判据：plugins/<dir>/manifest.json 存在即为插件（AGINT 插件的定义）。
# 排除 node_modules 等非插件目录 —— 它们在 plugins/ 下不会带 manifest.json。
discover_plugins() {
  for d in "$AGINT_ROOT"/plugins/*/; do
    [ -d "$d" ] || continue
    [ -f "$d/manifest.json" ] || continue
    basename "$d"
  done
}
mapfile -t PLUGINS < <(discover_plugins | sort)

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
#
# 软链已存在时的处理要**验证目标可达**，不能只测 `[ -L ]`：
# 仓库里曾有一个被 git 追踪的坏 symlink（指向另一台机器的
# /home/anmul/projects/AGINT/...，bbf6ff2 误提交），它满足 `-L` 但
# `-e` 为假 ⇒ 旧逻辑直接 `continue`，坏链永远不会被修 ⇒
# 该插件所有单元报缺包，而 setup 报「OK」。判据：`-L && -e` 才跳过。
linked=0
relinked=0
for plugin in "${PLUGINS[@]}"; do
  plugin_nm="$AGINT_ROOT/plugins/$plugin/node_modules"
  # 坏 symlink 会让 mkdir -p 报「文件已存在」而非建目录 ⇒ 先清掉。
  if [ -L "$plugin_nm" ] && [ ! -e "$plugin_nm" ]; then
    rm -f "$plugin_nm"
    relinked=$((relinked + 1))
  fi
  mkdir -p "$plugin_nm/@deepseek-ai"
  for dep in "${DEEPSEEK_DEPS[@]}"; do
    target="$plugin_nm/@deepseek-ai/$dep"
    if [ -L "$target" ] && [ -e "$target" ]; then continue; fi
    rm -f "$target"
    ln -sf "$DSH_DEEP_NM/$dep" "$target"
    linked=$((linked + 1))
  done
  for dep in "${TOP_DEPS[@]}"; do
    target="$plugin_nm/$dep"
    if [ -L "$target" ] && [ -e "$target" ]; then continue; fi
    rm -f "$target"
    ln -sf "$DSH_GLOBAL_NM/$dep" "$target"
    linked=$((linked + 1))
  done
done

# 3. eval 目录自己的 node_modules (driver 自身解析路径)
eval_nm="$AGINT_ROOT/eval/node_modules"
mkdir -p "$eval_nm/@deepseek-ai"
for dep in "${DEEPSEEK_DEPS[@]}"; do
  target="$eval_nm/@deepseek-ai/$dep"
  if [ -L "$target" ] && [ -e "$target" ]; then continue; fi
  rm -f "$target"
  ln -sf "$DSH_DEEP_NM/$dep" "$target"
  linked=$((linked + 1))
done
for dep in "${TOP_DEPS[@]}"; do
  target="$eval_nm/$dep"
  if [ -L "$target" ] && [ -e "$target" ]; then continue; fi
  rm -f "$target"
  ln -sf "$DSH_GLOBAL_NM/$dep" "$target"
  linked=$((linked + 1))
done

echo "OK: linked $linked symlinks across ${#PLUGINS[@]} plugins + eval/ (auto-discovered)"
[ "$relinked" -gt 0 ] && echo "  repaired $relinked broken node_modules symlink(s)"
echo "  Run: node eval/scenarios/driver.js"
