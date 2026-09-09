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

  # ── 维度 10 (soft warning, 2026-09-09 提案 57541772): 文档-代码公式一致性 ──
  # plugin 的 README.md / CHANGELOG.md 写了加权合成公式，但 plugins/ 全仓
  # 无对应实现代码——属"schema only"型脱节。读者照公式找代码会落空。
  # 触发背景：HARM 加权公式 0.2·H + 0.3·A + 0.3·R + 0.2·M 在 4 处文档命中，
  # plugins/ 0 实现（policy 决策走 quality-eval 5 维加权）。
  # 检测委托给 node bin/_verify-dim10.mjs（自实现 JS 正则遍历，advisory）。
  # 独立于 jq 块（dim10 不需要 jq，node 即可）。
  # 路径：用 BASH_SOURCE 拿 plugin-check.sh 自身位置，避免 $0 被外部传入相对路径
  if command -v node >/dev/null 2>&1; then
    local dim10_script_self="${BASH_SOURCE[0]:-$0}"
    local dim10_script_dir
    dim10_script_dir="$(cd "$(dirname "$dim10_script_self")" 2>/dev/null && pwd)"
    local dim10_script="${dim10_script_dir}/_verify-dim10.mjs"
    if [ -f "$dim10_script" ]; then
      # MSYS 路径 → Windows 路径（避免 node 报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
      # 注意：node 不能用带反斜杠的路径配 forward-slash cwd，bash 反斜杠吃转义
      # → 一律用 cygpath -w 转 Windows 反斜杠路径，但 node 在 Windows 原生下可直接吃
      # → 实测：传 forward-slash 路径 + 用 //D:/... 形式最稳
      local dim10_msys=""
      if command -v cygpath >/dev/null 2>&1; then
        dim10_msys="$(cygpath -w "$dim10_script" 2>/dev/null || printf '%s' "$dim10_script")"
      else
        dim10_msys="$dim10_script"
      fi
      # 不 cd 到 pluginDir（避免 cwd 改变后 node 路径被 bash 反斜杠转义吃错）
      # node 脚本内部自己用 resolve(pluginDir) 即可
      local dim10_out
      dim10_out="$(node "$dim10_msys" "$dir" 2>&1)" || true
      if [ -n "$dim10_out" ]; then
        local dim10_warn_count
        dim10_warn_count="$(printf '%s\n' "$dim10_out" | grep -c '^\s*\[WARN\]' || true)"
        if [ "${dim10_warn_count:-0}" -gt 0 ]; then
          log_warn "维度 10 文档-代码脱节：${dim10_warn_count} 处公式在 README/CHANGELOG 但 plugins/ 无对应实现（详见下方 + bin/_verify-dim10.mjs）"
          printf '%s\n' "$dim10_out" | sed 's/^/    /'
          warns=$((warns + dim10_warn_count))
        fi
      fi
    fi
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

# ── K19 schema 护栏（2026-09-09 加入）──
# 背景：工具参数里每个 `type: "object"` 都必须显式声明 additionalProperties，
# 否则 dsh 的 ajv 严格模式会拒绝挂载**整条 preset**，UI 只冒泡成一句
# "Failed to fetch"，排查成本极高（2026-09-09 实测，dsh 直接起不来）。
#
# 为什么挂在这里：护栏「写了但没人跑」等于没写——这正是 K19 当初翻车的根因
# （约定早已写在文件头注释里，但没有自动校验，照样漏）。接入 plugin-check
# 让它每次准入检查都自动跑一遍。默认扫 $PLUGINS_ROOT（宿主运行副本，真正被
# dsh 加载的那份）；可用 K19_SCAN_ROOT 覆盖。
k19_guard() {
  local repo_root out
  repo_root="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"

  # MSYS 的 /c/... /d/... 这类路径 Windows 原生 node 解析不了（会当相对路径，
  # 报 "Cannot find module"），传给 node 前一律 cygpath 转成 C:\... D:\...
  local to_win='printf %s'
  command -v cygpath >/dev/null 2>&1 && to_win='cygpath -w'

  local guard_msys="$repo_root/test/schema-guard.test.mjs"
  if [ ! -f "$guard_msys" ]; then
    log_warn "未找到 test/schema-guard.test.mjs，跳过 K19 护栏"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    log_warn "未装 node，跳过 K19 护栏"
    return 0
  fi
  local guard
  guard="$($to_win "$guard_msys" 2>/dev/null)" || guard="$guard_msys"

  local scan_root="$PLUGINS_ROOT"
  if command -v cygpath >/dev/null 2>&1; then
    scan_root="$(cygpath -w "$PLUGINS_ROOT" 2>/dev/null || printf '%s' "$PLUGINS_ROOT")"
  fi

  echo
  echo "─── K19 schema 护栏（扫描 $scan_root）───"
  if out="$(K19_SCAN_ROOT="$scan_root" node --test "$guard" 2>&1)"; then
    log_ok "所有 object schema 均已显式声明 additionalProperties"
  else
    log_err "K19 违例：存在未声明 additionalProperties 的 object schema（会导致 preset 挂载失败）"
    printf '%s\n' "$out" | grep -E ':[0-9]+[[:space:]]*$' | sed 's/^/    /' | head -20
    printf '%s\n' "$out" | sed -n '/未声明 additionalProperties 的 object schema/,/^$/p' | sed 's/^/    /' | head -30
  fi
  return 0
}

# 主逻辑
case "${1:-}" in
  --help|-h)
    cat <<EOF
Usage: plugin-check.sh [--all | <plugin-dir>...]

ENV:
  DSH_PLUGINS_ROOT   default \$HOME/.dsh/profiles/web/plugins
  K19_SCAN_ROOT      K19 schema 护栏的扫描根（默认随 DSH_PLUGINS_ROOT）

Lint 模式：失败/警告都不阻断，只列缺失项。
详见 $SPEC_URL
EOF
    ;;
  --all|"")
    shift || true
    k19_guard
    if [ -d "$PLUGINS_ROOT" ]; then
      for d in "$PLUGINS_ROOT"/agint-*/; do
        [ -d "$d" ] || continue
        check_one "$d" || true
      done
    fi
    ;;
  *)
    for d in "$@"; do
      check_one "$d" || true
    done
    ;;
esac

echo
echo "─── plugin-check 完成（lint 模式，不阻断） ───"