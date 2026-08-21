#!/usr/bin/env bash
# AGINT 插件准入校验（lint 模式，不阻断只警告）
# 规范：docs/plugins/PLUGIN-SPEC.md
# 用法：bin/plugin-check.sh <plugin-dir> [<plugin-dir> ...]
#       bin/plugin-check.sh --all     # 扫所有 ~/.dsh/profiles/web/plugins/agint-*

set -uo pipefail

PLUGINS_ROOT="${DSH_PLUGINS_ROOT:-$HOME/.dsh/profiles/web/plugins}"
SPEC_URL="docs/plugins/PLUGIN-SPEC.md"

# 颜色（终端支持时）
if [ -t 1 ]; then RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; RST=$'\033[0m'
else RED=''; YEL=''; GRN=''; RST=''
fi

log_warn() { printf '%s[WARN]%s %s\n' "$YEL" "$RST" "$*"; }
log_err()  { printf '%s[FAIL]%s %s\n' "$RED" "$RST" "$*"; }
log_ok()   { printf '%s[ OK]%s %s\n' "$GRN" "$RST" "$*"; }

# 检查单个插件目录
check_one() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  [[ "$name" == *.bak-* ]] && { log_ok "$name (backup, skipped)"; return 0; }

  local fails=0 warns=0
  echo
  echo "─── $name ───"

  local mf="$dir/manifest.json"
  if [ -f "$mf" ]; then
    log_ok "manifest.json 存在"
  else
    log_err "manifest.json 缺失"
    fails=$((fails + 1))
  fi

  local pkg="$dir/package.json"
  if [ -f "$pkg" ]; then
    log_ok "package.json 存在"
  else
    log_err "package.json 缺失"
    fails=$((fails + 1))
  fi

  local rdm="$dir/README.md"
  if [ -f "$rdm" ]; then
    log_ok "README.md 存在"
  else
    log_warn "README.md 缺失（维度 7 docs）"
    warns=$((warns + 1))
  fi

  local cl="$dir/CHANGELOG.md"
  if [ -f "$cl" ]; then
    log_ok "CHANGELOG.md 存在"
  else
    log_warn "CHANGELOG.md 缺失（维度 8 changelog）"
    warns=$((warns + 1))
  fi

  local test="$dir/test/smoke.mjs"
  if [ -f "$test" ]; then
    log_ok "test/smoke.mjs 存在"
  else
    log_warn "test/smoke.mjs 缺失（维度 6 tests）"
    warns=$((warns + 1))
  fi

  # ── 深度校验（manifest 存在时跑）──
  if [ -f "$mf" ] && command -v jq >/dev/null 2>&1; then
    # 1. contract
    if ! jq -e '.spec.cordis.inject != null and .spec.cordis.provides != null' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 spec.cordis.inject 或 provides（维度 1 contract）"
      warns=$((warns + 1))
    fi
    # 2. storage
    if ! jq -e '.spec.storage.domains | type == "array" and length > 0' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 spec.storage.domains（维度 2 storage）"
      warns=$((warns + 1))
    fi
    # 3. deps
    if ! jq -e '.spec.dependencies' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 spec.dependencies（维度 3 deps）"
      warns=$((warns + 1))
    fi
    # 4. permissions
    if ! jq -e '.spec.permissions' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 spec.permissions（维度 4 permissions）"
      warns=$((warns + 1))
    fi
    # 5. lifecycle — 静态扫 setInterval / setTimeout 看有没有注册 disposer
    local lib="$dir/lib/index.js"
    if [ -f "$lib" ]; then
      local has_interval=false has_disposer=false
      grep -qE 'setInterval|setTimeout' "$lib" 2>/dev/null && has_interval=true
      grep -qE 'ctx\.effect|\.dispose' "$lib" 2>/dev/null && has_disposer=true
      if $has_interval && ! $has_disposer; then
        log_warn "lib/index.js 用了 setInterval/setTimeout 但没看到 ctx.effect dispose（维度 5 lifecycle）"
        warns=$((warns + 1))
      else
        log_ok "lifecycle: disposer 已注册或未发现裸 timer"
      fi
    fi
  elif [ -f "$mf" ] && ! command -v jq >/dev/null 2>&1; then
    log_warn "未装 jq，跳过 manifest 深度校验"
  fi

  # 汇总
  if [ "$fails" -gt 0 ]; then
    printf '  → %s%d fail%s, %d warn\n' "$RED" "$fails" "$RST" "$warns"
    return 1
  elif [ "$warns" -gt 0 ]; then
    printf '  → 0 fail, %s%d warn%s\n' "$YEL" "$warns" "$RST"
    return 0
  else
    log_ok "8 维度全过"
    return 0
  fi
}

# 主逻辑
case "${1:-}" in
  --all|"")
    shift || true
    if [ -d "$PLUGINS_ROOT" ]; then
      for d in "$PLUGINS_ROOT"/agint-*/; do
        [ -d "$d" ] || continue
        check_one "$d" || true
      done
    fi
    ;;
  --help|-h)
    cat <<EOF
Usage: plugin-check.sh [--all | <plugin-dir>...]

ENV:
  DSH_PLUGINS_ROOT   default \$HOME/.dsh/profiles/web/plugins

Lint 模式：失败/警告都不阻断，只列缺失项。
详见 $SPEC_URL
EOF
    ;;
  *)
    for d in "$@"; do
      check_one "$d" || true
    done
    ;;
esac

echo
echo "─── plugin-check 完成（lint 模式，不阻断） ───"