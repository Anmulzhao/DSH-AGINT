#!/usr/bin/env bash
# AGINT 插件准入校验（lint 模式，不阻断只警告）
# 规范：docs/plugins/PLUGIN-SPEC.md
# 用法：bin/plugin-check.sh <plugin-dir> [<plugin-dir> ...]
#       bin/plugin-check.sh --all     # 扫所有 ~/.dsh/profiles/web/plugins/agint-*

set -uo pipefail

PLUGINS_ROOT="${DSH_PLUGINS_ROOT:-$HOME/.dsh/profiles/web/plugins}"
# 仓内兜底：如果运行时副本不存在，从 bin/.. 找 plugins/（CI / 本地 lint 友好）
if [ ! -d "$PLUGINS_ROOT" ]; then
  _repo_root="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
  if [ -d "$_repo_root/plugins" ]; then
    PLUGINS_ROOT="$_repo_root/plugins"
  fi
fi
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

  local test_entry
  test_entry="$(jq -r '.tests.entry // empty' "$mf" 2>/dev/null || true)"
  if [ -z "$test_entry" ]; then
    test_entry="test/smoke.mjs"  # 兜底：旧 manifest 缺 tests.entry
  fi
  local test="$dir/$test_entry"
  if [ -f "$test" ]; then
    log_ok "tests.entry=$test_entry 存在"
  else
    log_warn "tests.entry=$test_entry 缺失（维度 6 tests）"
    warns=$((warns + 1))
  fi

  # ── 维度 9: runtime-contract ──
  # Cordis waterfall 监听契约扫描 —— 防止坏监听器静默吞掉瀑布结果
  # （2026-09 智进 + DSH web 全栈工具崩盘事故根因）
  #
  # waterfall 事件：监听器必须调 next() 把链传下去，否则 dsh-tools 读
  # decision.kind 时 undefined。坏写法 `ctx.on('tools/post-execute', () => {})`
  # 在挂载阶段不报错（loader 不知道该事件是不是 waterfall），但运行时把所有
  # 工具调用炸成 `Cannot read properties of undefined (reading 'kind')`。
  local lib="$dir/lib/index.js"
  if [ -f "$lib" ]; then
    # 已知 waterfall 事件名（DSH 文档声明）。新增 waterfall 事件时同步更新。
    # 用 perl 一次性扫两类违例（不需要 ripgrep，perl 在 Win/Mac/Linux 都有）
    #   1. 体为空 / 不调 next 的监听器（=> {...} / => async (...) => {...}）
    #   2. 体非空但完全没 next( 调用
    local perl_out
    perl_out="$(perl -0777 -ne '
      my $file = $ARGV;
      my @hits;
      while (m{
        ctx\.on\(\s*['"'"'\"](
          tools/(?:pre-execute|post-execute|ptc-dispatch-log)
          | agent/pre-step
        )['"'"'\"]
        \s*,\s*(async\s+)?
        (?:\(([^)]*)\)|(\w+))
        \s*=>\s*\{((?:[^{}]|\{[^{}]*\})*)\}
      }gxs) {
        my ($evt, $async, $args1, $argname, $body) = ($1, $2, $3, $4, $5);
        my $args = defined($args1) ? $args1 : $argname;
        # next 必须以独立 token 出现，避免误中 nextStep / nextTick 等
        my $has_next = ($body =~ /\bnext\s*\(/);
        my $trim = $body; $trim =~ s/^\s+|\s+$//g;
        my $empty = ($trim eq "");
        if ($empty) {
          push @hits, sprintf("EMPTY: %s (args: %s)\n", $evt, $args);
        } elsif (!$has_next) {
          push @hits, sprintf("NO_NEXT: %s (args: %s)\n  body: %s\n", $evt, $args, $body);
        }
      }
      if (@hits) { print "RUNTIME_CONTRACT_FAIL\n", @hits; }
      else { print "RUNTIME_CONTRACT_OK\n"; }
    ' "$lib" 2>/dev/null)"
    local first_line
    first_line="$(echo "$perl_out" | head -n1)"
    if [ "$first_line" = "RUNTIME_CONTRACT_OK" ]; then
      log_ok "runtime-contract: 所有 waterfall 监听器符合契约"
    elif [ "$first_line" = "RUNTIME_CONTRACT_FAIL" ]; then
      log_err "维度 9 runtime-contract 违例："
      echo "$perl_out" | tail -n +2 | sed 's/^/    /'
      fails=$((fails + 1))
    else
      log_warn "未装 perl，跳过维度 9 runtime-contract 深度扫描"
    fi
  fi

  # ── 深度校验（manifest 存在时跑）──
  # Sprint 10 #6 收口：双兼容 .spec.* 和顶层（仓内不一致，老插件用 spec 包裹，Sprint 10 新插件用顶层）
  # 见 reviews/2026-08-30-周复盘.md 与 Sprint 10 #4 收口报告
  if [ -f "$mf" ] && command -v jq >/dev/null 2>&1; then
    # 1. contract — 兼容 .spec.cordis.* 与顶层 cordis.*
    # 注：jq `or` 在第一个为 false 时不返第二个，需用 if-then-else。
    if ! jq -e 'if (.spec.cordis.inject != null and .spec.cordis.provides != null) then true elif (.cordis.inject != null and .cordis.provides != null) then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 cordis.inject + cordis.provides（维度 1 contract）"
      warns=$((warns + 1))
    fi
    # 2. storage — 兼容 .spec.storage.domains 与顶层 storage.domains
    # 空数组 = 0 域合法（无状态 plugin 如 sandbox / cron helper），不报 WARN。
    if ! jq -e 'if (.spec.storage.domains | type == "array") then true elif (.storage.domains | type == "array") then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 storage.domains 数组（维度 2 storage）"
      warns=$((warns + 1))
    fi
    # 3. deps — 兼容 .spec.dependencies 与顶层 dependencies
    if ! jq -e 'if (.spec.dependencies != null) then true elif (.dependencies != null) then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 dependencies（维度 3 deps）"
      warns=$((warns + 1))
    fi
    # 4. permissions — 兼容 .spec.permissions 与顶层 permissions
    if ! jq -e 'if (.spec.permissions != null) then true elif (.permissions != null) then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 permissions（维度 4 permissions）"
      warns=$((warns + 1))
    fi
    # 5. lifecycle — 静态扫 setInterval / setTimeout 看有没有注册 disposer
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

    # ── 维度 5.5 (soft warning, v0.4 新增): 跨平台 fixture ──
    # plugin 的 permissions.fs 非空时，建议 smoke 含 forward-slash + native-sep
    # 路径 case。避免「Linux 写 Windows 跑」的跨平台路径 bug 漏到 prod
    # （参考 agint-wiki v0.4 教训 docs/lessons/v0.4-wiki-windows-path-escape.md）。
    local fs_perm
    fs_perm="$(jq -r 'if (.spec.permissions.fs != null) then (.spec.permissions.fs | join(",")) elif (.permissions.fs != null) then (.permissions.fs | join(",")) else "" end' "$mf" 2>/dev/null || true)"
    if [ -n "$fs_perm" ]; then
      local test="$dir/$test_entry"
      if [ -f "$test" ]; then
        local has_fwd has_evil
        has_fwd="$(grep -cE "['\"][a-zA-Z0-9_./-]*[a-zA-Z0-9_.-]+\.md['\"]" "$test" 2>/dev/null || true)"
        has_evil="$(grep -cE '\.\./' "$test" 2>/dev/null || true)"
        if [ "${has_fwd:-0}" -lt 1 ] || [ "${has_evil:-0}" -lt 1 ]; then
          log_warn "permissions.fs 非空但 smoke 缺跨平台 fixture（建议加 forward-slash 路径 + ../escape 负向 case，详见 plugin-preflight 第 2 步补强）"
          warns=$((warns + 1))
        fi
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
    log_ok "9 维度全过"
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