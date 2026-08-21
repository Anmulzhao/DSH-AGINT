#!/usr/bin/env bash
# AGINT 安全更新/重启/回滚 SOP（来自 2026-08-21 重启事故复盘）
# 详细文档：docs/operations/safe-update-sop.md
#
# 用法：./safe-update.sh <action> [<target>]
#   action in:
#     mount-patch     快照 + 编辑 cordis.patch.yml（不改源码）
#     edit-source     快照 + 编辑 plugins/.../lib/*.js（改源码）
#     restart         优雅停 dsh web + 启动 + 自动 smoke
#     rollback <TS>   倒序回滚到指定时间戳（plugin → patch → preset）
#     smoke           只跑 smoke test（不重启）
#     help            用法
#
# 依赖：bash 4+, tar, cp, pgrep, pkill, cat, wc, grep
# 不依赖：dsh CLI 任何子命令（脚本不知道 dsh 内部，只看进程 + 文件）

set -uo pipefail   # 不加 -e：希望收集所有错误后统一报告

AGINT_HOME="${AGINT_HOME:-$HOME/projects/AGINT}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
BACKUP_ROOT="$DSH_HOME/.agint-backups"
TS="$(date +%Y%m%d-%H%M%S)"

CORDIS_PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
PRESET="$DSH_HOME/.agent-presets/agint/agent.cordis.yml"
PLUGINS_DIR="$DSH_HOME/profiles/web/plugins"
STORAGE_DIR="$DSH_HOME/storages"
SENTINEL_LEASE="$DSH_HOME/sentinel.lease"

# ── 通用工具 ────────────────────────────────────────────────
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
ok()   { printf '✓ %s\n' "$*"; }
have_cmd() { command -v "$1" >/dev/null 2>&1 || fail "缺依赖：$1"; }

# ── 快照函数 ────────────────────────────────────────────────
snapshot_cordis_patch() {
  [ -f "$CORDIS_PATCH" ] || { log "cordis.patch.yml 不存在，跳过"; return; }
  cp -a "$CORDIS_PATCH" "$CORDIS_PATCH.bak-$TS"
  ok "cordis.patch.yml → .bak-$TS"
}

snapshot_preset() {
  [ -f "$PRESET" ] || { log "agent.cordis.yml 不存在，跳过"; return; }
  cp -a "$PRESET" "$PRESET.bak-$TS"
  ok "agent.cordis.yml → .bak-$TS"
}

snapshot_plugins() {
  mkdir -p "$BACKUP_ROOT"
  if compgen -G "$PLUGINS_DIR/agint-*" >/dev/null; then
    tar czf "$BACKUP_ROOT/agint-plugins-$TS.tar.gz" \
      -C "$PLUGINS_DIR" --exclude='*.bak-*' agint-*
    ok "plugins → $BACKUP_ROOT/agint-plugins-$TS.tar.gz"
  else
    log "无 agint-* 插件，跳过"
  fi
}

snapshot_storages() {
  local f
  shopt -s nullglob
  for f in "$STORAGE_DIR"/agint*.json "$STORAGE_DIR"/agint_tool_stats.jsonl; do
    cp -a "$f" "${f}.bak-$TS"
  done
  shopt -u nullglob
  ok "storages → .bak-$TS"
}

snapshot_all() {
  snapshot_cordis_patch
  snapshot_preset
  snapshot_plugins
  snapshot_storages
}

# ── 进程管理 ────────────────────────────────────────────────
graceful_stop_dsh() {
  local pid
  pid="$(pgrep -f 'dsh web' | head -1 || true)"
  if [ -z "$pid" ]; then
    log "dsh web 未跑"
    return 0
  fi
  log "SIGTERM → $pid"
  kill -SIGTERM "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || { ok "graceful 退出 (${i}s)"; break; }
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "兜底 SIGKILL → $pid"
    kill -SIGKILL "$pid" 2>/dev/null || true
  fi
  # 清临时锁
  rm -f "$SENTINEL_LEASE.tmp" "$STORAGE_DIR"/*.tmp 2>/dev/null || true
}

start_dsh() {
  log "启动 dsh web（cwd=$HOME/projects）"
  ( cd "$HOME/projects" && nohup dsh web >/tmp/dsh-web.log 2>&1 & )
  sleep 5
  if pgrep -f "dsh web" >/dev/null; then
    ok "dsh web 重启 OK（log=/tmp/dsh-web.log）"
  else
    fail "dsh web 起不来，看 /tmp/dsh-web.log"
  fi
}

# ── 验证 ────────────────────────────────────────────────
smoke() {
  log "─── smoke test ───"
  sleep 3
  # 1. sentinel lease
  if [ -f "$SENTINEL_LEASE" ]; then
    log "sentinel.lease: $(cat $SENTINEL_LEASE)"
  else
    log "warning: sentinel.lease 未建（30s 内会自愈）"
  fi
  # 2. 6 个内置 cron job
  if grep -lE 'memory-decay|wiki-lint|night-dream|metrics-collect|prompt-static-check|evolve-review' \
    "$PLUGINS_DIR/agint-cron/lib/jobs.js" >/dev/null 2>&1; then
    ok "agint-cron 6 个内置 job 完整"
  else
    log "warning: agint-cron 6 job 缺失或不完整"
  fi
  # 3. tool_stats
  if [ -f "$STORAGE_DIR/agint_tool_stats.jsonl" ]; then
    log "tool_stats: $(wc -l < $STORAGE_DIR/agint_tool_stats.jsonl) lines"
  fi
  # 4. dom json
  local d
  for d in agint agint_rules agint_metrics agint_evolve; do
    if [ -f "$STORAGE_DIR/${d}.json" ]; then
      ok "${d}.json 存在"
    else
      log "warning: ${d}.json 缺失"
    fi
  done
  ok "smoke 完成（9-service 深度验证请在 agint 会话里跑 cordis_inspect_self）"
}

# ── 前置检查 ────────────────────────────────────────────────
require_clean() {
  mkdir -p "$BACKUP_ROOT" || fail "建备份目录失败：$BACKUP_ROOT"
  if pgrep -f "dsh web" >/dev/null; then
    log "warning: dsh web 在跑（非 restart 动作时会保持运行）"
  fi
}

# ── 动作分发 ────────────────────────────────────────────────
case "${1:-help}" in
  mount-patch)
    require_clean
    snapshot_all
    log "现在可以编辑 $CORDIS_PATCH"
    log "改完后跑：$0 restart"
    ;;
  edit-source)
    require_clean
    snapshot_plugins
    snapshot_cordis_patch
    snapshot_preset
    log "现在可以改 $PLUGINS_DIR/agint-*/lib/*.js 或 preset"
    log "改完后跑：$0 restart"
    ;;
  restart)
    graceful_stop_dsh
    start_dsh
    smoke
    ;;
  rollback)
    TARGET="${2:-}"
    [ -z "$TARGET" ] && fail "用法：$0 rollback <TS>  例如 20260821-122700"
    log "回滚到 $TARGET"
    require_clean
    graceful_stop_dsh
    # plugin → patch → preset 倒序
    if [ -f "$BACKUP_ROOT/agint-plugins-$TARGET.tar.gz" ]; then
      tar xzf "$BACKUP_ROOT/agint-plugins-$TARGET.tar.gz" -C "$PLUGINS_DIR/"
      ok "plugins 已从 $TARGET 恢复"
    else
      log "warning: 找不到 $BACKUP_ROOT/agint-plugins-$TARGET.tar.gz"
    fi
    [ -f "$CORDIS_PATCH.bak-$TARGET" ] && {
      cp -a "$CORDIS_PATCH.bak-$TARGET" "$CORDIS_PATCH"
      ok "cordis.patch.yml 已从 $TARGET 恢复"
    }
    [ -f "$PRESET.bak-$TARGET" ] && {
      cp -a "$PRESET.bak-$TARGET" "$PRESET"
      ok "agent.cordis.yml 已从 $TARGET 恢复"
    }
    rm -f "$SENTINEL_LEASE" "$SENTINEL_LEASE.tmp"
    start_dsh
    smoke
    ;;
  smoke)
    smoke
    ;;
  help|*)
    sed -n '2,18p' "$0"
    ;;
esac