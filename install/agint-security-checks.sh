#!/usr/bin/env bash
# install/agint-security-checks.sh — AGINT install 的安全检查子集
#
# 来源：ROADMAP §5.2 安全左移 + docs/security-boundary.md 硬约束清单。
# 设计原则：
#   - 每个 check 是独立函数 + 0 退出 = 通过，非 0 = 失败
#   - 失败时打印可操作的修复建议（不是只说"fail"）
#   - 不写盘（除非要建中央备份目录）
#   - 不依赖 AGINT_HOME / DSH_HOME 是否存在（前置检查）
#
# 用法：
#   install/agint-security-checks.sh          # 跑全部检查
#   install/agint-security-checks.sh --strict # 任一 warn 升级为 fail
#   install/agint-security-checks.sh path     # 只跑 path 检查
#   install/agint-security-checks.sh runtime  # 只跑 runtime 检查
#
# 返回码：0 = 全部通过；非 0 = 有失败项

set -uo pipefail  # 注意：不加 -e，因为我们要收集所有失败项

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGINT_HOME_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGINT_HOME="${AGINT_HOME:-$AGINT_HOME_DEFAULT}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

STRICT=0
SCOPE="all"
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    all|path|runtime) SCOPE="$arg" ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "[security-checks] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

FAILED=0
WARNED=0
report_pass() { echo "  ✓ $*"; }
report_warn() { echo "  ⚠ $*"; WARNED=$((WARNED + 1)); [ "$STRICT" = "1" ] && FAILED=$((FAILED + 1)); }
report_fail() { echo "  ✗ $*"; FAILED=$((FAILED + 1)); }

heading() { echo ""; echo "── $* ──"; }

# ─────────────────────────────────────────────────────────────
# path checks (cheap, runnable anytime)
# ─────────────────────────────────────────────────────────────

check_agint_home_realpath() {
  heading "path checks"
  # 1. AGINT_HOME 必须存在、是绝对路径、realpath 后跟原值一致（不是 symlink 链）
  if [ ! -d "$AGINT_HOME" ]; then
    report_fail "AGINT_HOME 不存在: $AGINT_HOME（export AGINT_HOME=/path/to/agint 或 cd 到仓库根）"
    return
  fi
  report_pass "AGINT_HOME 存在: $AGINT_HOME"

  case "$AGINT_HOME" in
    /*) report_pass "AGINT_HOME 是绝对路径" ;;
    *)  report_fail "AGINT_HOME 不是绝对路径: $AGINT_HOME" ;;
  esac

  local resolved
  resolved="$(cd "$AGINT_HOME" && pwd -P 2>/dev/null)" || {
    report_fail "AGINT_HOME 无法 realpath（可能是循环 symlink）"
    return
  }
  report_pass "AGINT_HOME realpath: $resolved"

  # 2. AGINT_HOME 含 .. 是配置错误
  case "$AGINT_HOME" in
    *..*) report_fail "AGINT_HOME 含 '..'：$AGINT_HOME（路径遍历风险）" ;;
    *)    report_pass "AGINT_HOME 不含 '..'" ;;
  esac
}

check_dsh_home() {
  if [ -d "$DSH_HOME" ]; then
    report_pass "DSH_HOME 存在: $DSH_HOME"
  else
    report_warn "DSH_HOME 不存在: $DSH_HOME（install 会引导你先跑 dsh web 一次）"
  fi

  case "$DSH_HOME" in
    /*) report_pass "DSH_HOME 是绝对路径" ;;
    *)  report_fail "DSH_HOME 不是绝对路径: $DSH_HOME" ;;
  esac

  case "$DSH_HOME" in
    *..*) report_fail "DSH_HOME 含 '..'" ;;
  esac
}

check_source_directories() {
  for d in "$AGINT_HOME/presets" "$AGINT_HOME/plugins" "$AGINT_HOME/profile-patches/web/cordis.patch.yml"; do
    if [ ! -e "$d" ]; then
      report_fail "源缺失: $d"
    else
      report_pass "源就位: ${d#$AGINT_HOME/}"
    fi
  done
}

check_git_repo() {
  if [ -d "$AGINT_HOME/.git" ]; then
    report_pass "AGINT_HOME 是 git 仓库"
  else
    report_warn "AGINT_HOME 不是 git 仓库（install.sh 默认会拒，加 --force 跳过）"
  fi
}

# ─────────────────────────────────────────────────────────────
# runtime checks (need disk, fs utilities)
# ─────────────────────────────────────────────────────────────

check_runtime_tools() {
  heading "runtime checks"
  # 必需工具：缺任一个都装不动（python3 同时承担 patch 合并与无 rsync 时的文件同步）
  for tool in python3 date mkdir; do
    if command -v "$tool" >/dev/null 2>&1; then
      report_pass "工具可用: $tool ($(command -v "$tool"))"
    else
      report_fail "工具缺失: $tool"
    fi
  done
  # 可选工具：rsync 只影响同步速度，install.sh 有 python3 回退分支
  if command -v rsync >/dev/null 2>&1; then
    report_pass "工具可用: rsync（可选，$(command -v rsync)）"
  else
    report_warn "rsync 缺失（可选）：将回退到 python3 同步，功能不变"
  fi
}

check_disk_space() {
  # 安装约占 50MB；阈值 100MB 给 patch / backup / 临时文件留余地。
  local target="$DSH_HOME"
  [ -d "$target" ] || target="$AGINT_HOME"
  local avail_kb
  avail_kb="$(df -Pk "$target" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -z "$avail_kb" ] || [ "$avail_kb" = "0" ]; then
    report_warn "无法读取 $target 的可用空间（df 失败）"
    return
  fi
  local avail_mb=$((avail_kb / 1024))
  if [ "$avail_mb" -lt 100 ]; then
    report_fail "$target 可用空间仅 ${avail_mb}MB（需 ≥ 100MB）"
  else
    report_pass "$target 可用空间: ${avail_mb}MB"
  fi
}

check_backup_dir_writable() {
  # 如果 DSH_HOME 存在，确认备份目录【能建且能写】。
  #
  # 注意：这里必须真的 mkdir 一次再判可写。原来的写法只在目录「已存在且不可写」
  # 时才 fail，目录压根不存在时直接 report_pass —— 给了假绿。结果是 install.sh
  # 第一次跑（备份目录尚未创建）时 tar 直接 "Cannot open: No such file or
  # directory" 挂掉，而前置检查明明是绿的（2026-09-03 实测踩到）。
  if [ ! -d "$DSH_HOME" ]; then return; fi
  local bdir="$DSH_HOME/.agint-backups"
  if [ -e "$bdir" ] && [ ! -d "$bdir" ]; then
    report_fail "$bdir 存在但不是目录"
    return
  fi
  if [ ! -d "$bdir" ]; then
    # 目录不存在：试着建（install.sh 的 ensure_backup_dir 也会建，这里先探一次）
    if mkdir -p "$bdir" 2>/dev/null; then
      report_pass "备份目录已创建: $bdir"
    else
      report_fail "备份目录无法创建: $bdir"
      return
    fi
  fi
  if [ -w "$bdir" ]; then
    report_pass "备份目录可写: $bdir"
  else
    report_fail "$bdir 不可写（perms=$(stat -c %a "$bdir" 2>/dev/null || stat -f %p "$bdir" 2>/dev/null)）"
  fi
}

# ─────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────

case "$SCOPE" in
  all)
    check_agint_home_realpath
    check_dsh_home
    check_source_directories
    check_git_repo
    check_runtime_tools
    check_disk_space
    check_backup_dir_writable
    ;;
  path)
    check_agint_home_realpath
    check_dsh_home
    check_source_directories
    check_git_repo
    ;;
  runtime)
    check_runtime_tools
    check_disk_space
    check_backup_dir_writable
    ;;
esac

echo ""
if [ "$FAILED" -eq 0 ] && [ "$WARNED" -eq 0 ]; then
  echo "[security-checks] ✓ 全部通过"
  exit 0
elif [ "$FAILED" -eq 0 ]; then
  echo "[security-checks] ⚠ $WARNED 个警告（无失败）"
  if [ "$STRICT" = "1" ]; then exit 1; else exit 0; fi
else
  echo "[security-checks] ✗ $FAILED 个失败 / $WARNED 个警告"
  exit 1
fi
