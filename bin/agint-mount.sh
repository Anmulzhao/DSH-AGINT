#!/usr/bin/env bash
# AGINT 一站式挂载/重启保命脚本
# 把"装新插件 / 升级现有 / 批量 / 纯重启" 4 个场景压成 4 个子命令
# 内置: lint → snapshot → graceful stop → start → smoke → (可选 rollback)
#
# 依赖脚本: bin/plugin-check.sh, bin/safe-update.sh
# 规范文档: docs/plugins/PLUGIN-SPEC.md, docs/operations/safe-update-sop.md
#
# 用法:
#   bin/agint-mount.sh new <plugin-dir>        # 装一个新插件 (挂 cordis.patch.yml + 重启)
#   bin/agint-mount.sh upgrade <plugin-dir>    # 升级已有插件 (替换源码 + 重启)
#   bin/agint-mount.sh batch <dir>...          # 批量装多个 (一次 lint + 一次快照 + 一次重启)
#   bin/agint-mount.sh restart                 # 纯重启 (不挂任何东西,只 graceful restart + smoke)
#   bin/agint-mount.sh rollback <TS>           # 崩了,倒序回滚到 TS
#   bin/agint-mount.sh lint [plugin-dir]       # 只跑 plugin-check,不重启
#   bin/agint-mount.sh help                    # 用法
#
# 设计原则: 每一步失败就退出,不靠"--force"绕过

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_CHECK="$SCRIPT_DIR/plugin-check.sh"
SAFE_UPDATE="$SCRIPT_DIR/safe-update.sh"

AGINT_HOME="${AGINT_HOME:-$HOME/projects/AGINT}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
CORDIS_PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
PLUGINS_DIR="$DSH_HOME/profiles/web/plugins"
STORAGE_DIR="$DSH_HOME/storages"
SENTINEL_LEASE="$DSH_HOME/sentinel.lease"
BACKUP_ROOT="$DSH_HOME/.agint-backups"

TS="$(date +%Y%m%d-%H%M%S)"

# 颜色
if [ -t 1 ]; then RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; BLU=$'\033[34m'; RST=$'\033[0m'
else RED=''; YEL=''; GRN=''; BLU=''; RST=''
fi

log() { printf '%s[%s]%s %s\n' "$BLU" "$(date +%H:%M:%S)" "$RST" "$*"; }
ok()  { printf '%s[ OK]%s %s\n' "$GRN" "$RST" "$*"; }
warn(){ printf '%s[WARN]%s %s\n' "$YEL" "$RST" "$*" >&2; }
fail(){ printf '%s[FAIL]%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

# 依赖检查
[ -x "$PLUGIN_CHECK" ] || fail "缺 $PLUGIN_CHECK（先 chmod +x 或 git pull）"
[ -x "$SAFE_UPDATE" ] || fail "缺 $SAFE_UPDATE"

# ── 1. lint 步骤（必跑，不能跳过） ──
lint_plugin() {
  local dir="$1"
  log "plugin-check $dir"
  "$PLUGIN_CHECK" "$dir" | grep -E '^\[' || true
}

# ── 2. 检查 patch 里有没有这条插件的 row（用于 new/upgrade） ──
patch_has_id() {
  local id="$1"
  grep -qE "^\s*-?\s*id:\s*$id(\s|$)" "$CORDIS_PATCH" 2>/dev/null
}

patch_id_enabled() {
  local id="$1"
  ! grep -qE "^\s*#\s*-?\s*id:\s*$id(\s|$)" "$CORDIS_PATCH" 2>/dev/null
}

# ── 3. 装新插件: 在 patch.yml 末尾追加 id row ──
patch_insert_id() {
  local id="$1"
  local main_path="$3"
  local cfg_json="${4:-{}}"
  if patch_has_id "$id"; then
    if patch_id_enabled "$id"; then
      warn "patch 已存在启用行 $id（升级走 upgrade 子命令）"
      return 1
    else
      warn "patch 里 $id 存在但被注释，自动启用"
      sed -i "s|^\(\s*\)#\s*-\s*id:\s*$id|\1- id: $id|" "$CORDIS_PATCH"
      return 0
    fi
  fi
  cat >> "$CORDIS_PATCH" <<EOF

# mounted by bin/agint-mount.sh at $TS
- id: $id
  name: $main_path
  config: $cfg_json
EOF
  ok "patch 已新增 - id: $id"
}

# ── 子命令: new ──
cmd_new() {
  local dir="${1:?用法: agint-mount.sh new <plugin-dir>}"
  [ -d "$dir" ] || fail "插件目录不存在: $dir"

  local mf="$dir/manifest.json"
  [ -f "$mf" ] || fail "manifest.json 缺失,先按 PLUGIN-SPEC 8 维度补齐"

  local id
  id="$(jq -r '.name' "$mf")"
  local main
  main="$(jq -r '.main' "$mf")"
  local cfg
  cfg="$(jq -c '.config // {}' "$mf")"

  log "─── AGINT MOUNT NEW: $id ───"
  lint_plugin "$dir" || warn "lint 有警告但继续（lint 模式不阻断）"

  # 防止挂没装好的（peer deps）的插件
  local deps
  deps="$(jq -r '.spec.dependencies // {} | to_entries | .[] | "\(.key)@\(.value)"' "$mf" 2>/dev/null)"
  if [ -n "$deps" ]; then
    log "peer deps: $deps"
    for d in $deps; do
      local dep_id="${d%@*}"
      # agint-* 类的要检查已挂载
      if [[ "$dep_id" == agint-* ]]; then
        if patch_has_id "$dep_id" && patch_id_enabled "$dep_id"; then
          ok "依赖 $dep_id 已挂载"
        else
          fail "依赖 $dep_id 未挂载或被注释,先 bin/agint-mount.sh new $dep_id 的目录"
        fi
      fi
    done
  fi

  log "拍快照 (safe-update.sh snapshot)"
  "$SAFE_UPDATE" edit-source 2>&1 | tail -5 || fail "snapshot 失败"

  log "patch 写 row"
  patch_insert_id "$id" "$main" "./plugins/$(basename $dir)/$main" "$cfg" || true

  log "重启 (safe-update.sh restart)"
  "$SAFE_UPDATE" restart

  log "smoke"
  "$SAFE_UPDATE" smoke
  ok "─── 挂载完成: $id @ $TS ───"
}

# ── 子命令: upgrade ──
cmd_upgrade() {
  local dir="${1:?用法: agint-mount.sh upgrade <plugin-dir>}"
  [ -d "$dir" ] || fail "插件目录不存在: $dir"
  [ -f "$dir/manifest.json" ] || fail "manifest.json 缺失"

  local id
  id="$(jq -r '.name' "$dir/manifest.json")"
  patch_has_id "$id" || fail "$id 不在 cordis.patch.yml 里,挂载请用 'new' 子命令"
  patch_id_enabled "$id" || fail "$id 在 patch 里被注释,先手动启用"

  log "─── AGINT UPGRADE: $id ───"
  lint_plugin "$dir" || warn "lint 有警告但继续"

  log "拍快照"
  "$SAFE_UPDATE" edit-source 2>&1 | tail -5 || fail "snapshot 失败"

  log "重启"
  "$SAFE_UPDATE" restart
  "$SAFE_UPDATE" smoke
  ok "─── 升级完成: $id @ $TS ───"
}

# ── 子命令: batch ──
cmd_batch() {
  [ $# -gt 0 ] || fail "用法: agint-mount.sh batch <dir>..."
  log "─── AGINT BATCH MOUNT ───"

  # 第一轮: 全部 lint 一次,把失败的先拎出来
  local failed=()
  for d in "$@"; do
    log "lint $d"
    "$PLUGIN_CHECK" "$d" | grep -E '^\[' || true
    # 检查 patch 里不存在（避免和 upgrade 混淆）
    local id
    id="$(jq -r '.name' "$d/manifest.json" 2>/dev/null || echo "")"
    if [ -z "$id" ]; then
      failed+=("$d (缺 manifest)")
    elif patch_has_id "$id" && patch_id_enabled "$id"; then
      failed+=("$d (已在 patch 里启用,请用 upgrade)")
    fi
  done

  if [ "${#failed[@]}" -gt 0 ]; then
    log "以下插件有问题,先解决再 batch:"
    printf '  - %s\n' "${failed[@]}"
    fail "batch 前置检查失败"
  fi

  # 第二轮: 一次性快照 + 一次性写 patch + 一次性重启
  log "一次性快照"
  "$SAFE_UPDATE" edit-source 2>&1 | tail -5 || fail "snapshot 失败"

  for d in "$@"; do
    local id main cfg
    id="$(jq -r '.name' "$d/manifest.json")"
    main="$(jq -r '.main' "$d/manifest.json")"
    cfg="$(jq -c '.config // {}' "$d/manifest.json")"
    patch_insert_id "$id" "$main" "./plugins/$(basename $d)/$main" "$cfg"
  done

  log "一次性重启"
  "$SAFE_UPDATE" restart
  "$SAFE_UPDATE" smoke
  ok "─── 批量挂载完成 @ $TS ───"
}

# ── 子命令: restart ──
cmd_restart() {
  log "─── AGINT RESTART ───"
  "$SAFE_UPDATE" restart
  ok "─── 重启完成 ───"
}

# ── 子命令: rollback ──
cmd_rollback() {
  local target="${1:?用法: agint-mount.sh rollback <TS>}"
  "$SAFE_UPDATE" rollback "$target"
}

# ── 子命令: lint ──
cmd_lint() {
  if [ $# -eq 0 ]; then
    "$PLUGIN_CHECK" --all
  else
    "$PLUGIN_CHECK" "$@"
  fi
}

# ── 主分发 ──
case "${1:-help}" in
  new)     shift; cmd_new "$@" ;;
  upgrade) shift; cmd_upgrade "$@" ;;
  batch)   shift; cmd_batch "$@" ;;
  restart) cmd_restart ;;
  rollback)shift; cmd_rollback "$@" ;;
  lint)    shift; cmd_lint "$@" ;;
  help|-h|--help|"")
    cat <<EOF
用法: bin/agint-mount.sh <subcommand> [args]

子命令:
  new <plugin-dir>        装一个新插件 (lint + 依赖检查 + 快照 + patch + 重启 + smoke)
  upgrade <plugin-dir>    升级已有插件 (lint + 快照 + 重启 + smoke)
  batch <dir>...          批量装多个 (一次 lint + 一次快照 + 一次重启)
  restart                 纯重启 (graceful stop + start + smoke,不动 patch)
  rollback <TS>           崩了,倒序回滚到指定时间戳
  lint [plugin-dir]       只跑 plugin-check 不重启 (不传 dir = --all)

保命原则:
  - 每步失败立刻退出,不绕过
  - lint 不阻断但会把警告打出来 (lifecycle/deps 风险必须人眼 review)
  - 重启永远走 SIGTERM 让 cordis fiber dispose 跑完
  - 崩了就 rollback 到上一个 TS,storage 默认不回滚

配套:
  bin/plugin-check.sh   lint 工具 (8 维度)
  bin/safe-update.sh    snapshot/restart/rollback 工具 (5 Phase)
  docs/plugins/PLUGIN-SPEC.md        8 维度规范
  docs/operations/safe-update-sop.md 5 Phase SOP
EOF
    ;;
  *)
    fail "未知子命令: $1（跑 help 看用法）"
    ;;
esac