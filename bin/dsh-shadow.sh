#!/usr/bin/env bash
# AGINT 影子 dsh web —— 本机隔离的 dsh 实例，用于 agint-* 插件修改后
# 在不污染 host 的前提下做 e2e 验证。
#
# 老板 2026-09-21 立下的三阶段流程：
#   1. 热加载（本会话 cordis_define + cordis_run update）── 不需要本脚本
#   2. 影子 dsh web（隔离实例）                       ── ★ 本脚本
#   3. host 挂载（plugin-preflight 第 5 步 + safe-update.sh restart）
#
# 隔离原则（4 层）：
#   a) 独立 DSH_HOME       → 不碰 /dsh/profiles/web/cordis.patch.yml，不抢 3080
#   b) 独立 AGINT_HOME     → 不写 host 的 dream / memory / wiki 数据
#   c) 独立 storages       → 不污染 host 的 agint_tool_stats.jsonl 等
#   d) plugins 走软链     → 改本仓 plugins/agint-* 源码，影子立即生效
#                          (避免 cp -r 拷贝带来的「改完忘记同步」陷阱)
#
# 用法:
#   bin/dsh-shadow.sh up [PORT]            拉起影子 (默认 3081)
#   bin/dsh-shadow.sh down                 停掉影子
#   bin/dsh-shadow.sh status               看影子状态
#   bin/dsh-shadow.sh logs [N]             tail 最近 N 行日志 (默认 50)
#   bin/dsh-shadow.sh reset                清空影子状态 (DSH_HOME+AGINT_HOME+storages)
#                                          保留本仓 plugins 软链
#   bin/dsh-shadow.sh path                 打印影子所有路径
#   bin/dsh-shadow.sh help
#
# 环境变量 (有默认):
#   AGINT_REPO   本仓根目录 (默认自动探测: 上两级)
#   DSH_HOST     host 的 DSH_HOME (默认 /dsh)
#   PORT         影子监听端口 (默认 3081)
#   SHADOW_HOME  影子 DSH_HOME (默认 /tmp/dsh-shadow-<ts>)
#   SHADOW_DATA  影子 AGINT_HOME (默认 /tmp/agint-shadow-data-<ts>)
#
# 依赖: bash 4+, ln, mkdir, pgrep, pkill, tar, dsh (PATH 里能找到)
# 不依赖: 任何 dsh 内部 API（脚本只看进程 + 文件）

set -uo pipefail

# ── 默认值 & 环境变量 ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGINT_REPO="${AGINT_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DSH_HOST="${DSH_HOST:-/dsh}"
PLUGINS_SRC="$AGINT_REPO/plugins"

PORT="${PORT:-3081}"
# 用稳定路径（不带 ts），方便后续 down/status 找到；reset 时再带 ts 备份
SHADOW_HOME_DEFAULT="/tmp/dsh-shadow"
SHADOW_DATA_DEFAULT="/tmp/agint-shadow-data"
SHADOW_HOME="${SHADOW_HOME:-$SHADOW_HOME_DEFAULT}"
SHADOW_DATA="${SHADOW_DATA:-$SHADOW_DATA_DEFAULT}"

SHADOW_PROFILE_NAME="${SHADOW_PROFILE_NAME:-rescue}"   # dsh rescue 创建的 profile 名
SHADOW_PROFILE_DIR="$SHADOW_HOME/profiles/$SHADOW_PROFILE_NAME"
SHADOW_PLUGINS_DIR="$SHADOW_PROFILE_DIR/plugins"
SHADOW_PRESETS_DIR="$SHADOW_HOME/.agent-presets/agint"
SHADOW_STORAGES_DIR="$SHADOW_HOME/storages"
SHADOW_LOG="/tmp/dsh-shadow.log"
SHADOW_PIDFILE="/tmp/dsh-shadow.pid"

# ── 颜色 ────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; BLU=$'\033[34m'; RST=$'\033[0m'
else RED=''; YEL=''; GRN=''; BLU=''; RST=''; fi

log() { printf '%s[%s]%s %s\n' "$BLU" "$(date +%H:%M:%S)" "$RST" "$*"; }
ok()  { printf '%s[ OK]%s %s\n' "$GRN" "$RST" "$*"; }
warn(){ printf '%s[WARN]%s %s\n' "$YEL" "$RST" "$*" >&2; }
fail(){ printf '%s[FAIL]%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

have_cmd() { command -v "$1" >/dev/null 2>&1 || fail "缺依赖：$1"; }

# ── 依赖 & 前提检查 ─────────────────────────────────────────
check_prereqs() {
  have_cmd dsh
  have_cmd pgrep
  have_cmd pkill
  [ -d "$AGINT_REPO" ] || fail "AGINT_REPO 不存在：$AGINT_REPO"
  [ -d "$PLUGINS_SRC" ] || fail "plugins 目录不存在：$PLUGINS_SRC"
  # host DSH_HOME 探测：必须能读到 cordis.yml 才算 host 健康
  if [ ! -f "$DSH_HOST/profiles/web/cordis.yml" ]; then
    warn "host DSH_HOME ($DSH_HOST) 缺 cordis.yml —— 影子仍可起，但参考 host 配置时可能 404"
  fi
  # host 3080 占着 → 提醒但不阻止（影子 3081 不会冲突）
  if pgrep -f 'dsh.*--profile web' >/dev/null 2>&1; then
    log "检测到 host dsh web 在跑 —— 影子用 :$PORT 不冲突"
  fi
  # 本仓 plugins 里至少要有一个 agint-* 才有意义
  if ! compgen -G "$PLUGINS_SRC/agint-*" >/dev/null; then
    fail "plugins/ 下没找到任何 agint-* 目录（$PLUGINS_SRC）"
  fi
}

# ── 端口空闲探测 ─────────────────────────────────────────────
check_port_free() {
  local port="$1"
  # 用 node -e 探端口（比 ss/lsof 通用，依赖 node 即可）
  if command -v node >/dev/null 2>&1; then
    if node -e "
      const net = require('net');
      const s = net.createServer();
      s.listen($port, '127.0.0.1', () => s.close(() => process.exit(0)));
      s.on('error', () => process.exit(1));
    " 2>/dev/null; then
      return 0
    else
      return 1
    fi
  else
    # 退化：grep /proc/net/tcp（不靠谱但聊胜于无）
    return 0
  fi
}

# ── 初始化影子 DSH_HOME（首次启动） ─────────────────────────
init_shadow_home() {
  log "初始化影子 DSH_HOME: $SHADOW_HOME"
  # 只建 $SHADOW_HOME 顶层目录，profiles/rescue/web 由 dsh rescue 自己 mkdir
  # （提前建会触发 dsh EEXIST "profile directory already exists" 抛错）
  mkdir -p "$SHADOW_HOME"

  # 1) web profile 骨架：用 dsh rescue 从 default 模板拉一份（自带 cordis.yml + package.json）
  #    只在 cordis.yml 不存在时跑一次
  #    关键：rescue 创建 profile 后会**同步起 webserver**（即便 --no-open），所以要给个
  #    --port 避开 host 的 3080；rescue 启动后立即 kill，留下完整 profile 目录
  if [ ! -f "$SHADOW_PROFILE_DIR/cordis.yml" ]; then
    log "dsh rescue --from-default-profile web (拉 web profile 骨架，临时起 3099)"
    local rescue_port="${RESCUE_PORT:-3099}"
    local rescue_log="/tmp/dsh-shadow-rescue-$$.log"
    DSH_HOME="$SHADOW_HOME" dsh rescue --from-default-profile web \
      --port "$rescue_port" --no-open >"$rescue_log" 2>&1 &
    local rescue_pid=$!
    # 给 rescue 2~5s 落盘 profile（典型 1~3s）
    for i in 1 2 3 4 5 6 7 8 9 10; do
      [ -f "$SHADOW_PROFILE_DIR/cordis.yml" ] && break
      sleep 1
    done
    # 立刻杀 rescue 起的 webserver（profile 已落盘，不再需要它活着）
    kill -SIGTERM "$rescue_pid" 2>/dev/null || true
    sleep 1
    kill -0 "$rescue_pid" 2>/dev/null && kill -SIGKILL "$rescue_pid" 2>/dev/null || true
    rm -f "$rescue_log"
    if [ -f "$SHADOW_PROFILE_DIR/cordis.yml" ]; then
      ok "web profile 骨架已落到 $SHADOW_PROFILE_DIR"
    else
      fail "dsh rescue 5s 内没产出 cordis.yml —— 看 $rescue_log 排查"
    fi
  else
    log "web profile 已存在，跳过 rescue"
  fi

  # 2) AGINT-data 隔离：写一份 .env 让 dsh 子进程把 AGINT_HOME 指到 SHADOW_DATA
  cat > "$SHADOW_HOME/.env" <<EOF
# AGINT 影子 dsh 实例的隔离环境变量（脚本自动维护，勿手改）
AGINT_HOME=$SHADOW_DATA
EOF
  mkdir -p "$SHADOW_DATA"

  # 3) plugins 软链：整目录软链 plugins → 仓 plugins
  #    关键设计：软链而非拷贝，改本仓源码即生效（达成"热加载"目的）
  #    选用整目录软链而非逐个 plugin 子目录软链的原因：
  #    本仓 plugins/node_modules/@deepseek-ai 本身就是软链 → host 的
  #    /dsh/profiles/web/plugins/node_modules/@deepseek-ai。node ESM resolver
  #    从 plugins/agint-*/lib/*.js 沿目录向上找 plugins/node_modules 时，
  #    必须 plugins 整目录是同一 fs 命名空间才能解析；逐个子目录软链会断链
  log "软链 plugins: $SHADOW_PLUGINS_DIR → $PLUGINS_SRC"
  if [ -L "$SHADOW_PLUGINS_DIR" ]; then
    log "plugins 已链到 $(readlink "$SHADOW_PLUGINS_DIR")，跳过"
  elif [ -e "$SHADOW_PLUGINS_DIR" ]; then
    # 兼容模式：上次残留的物理目录可能是旧版「逐个软链」策略遗留的产物
    # 自动 rmdir 后重建软链（不影响 SHADOW_HOME 其它状态）
    warn "$SHADOW_PLUGINS_DIR 是物理目录（残留），自动 rmdir 后重建软链"
    rm -rf "$SHADOW_PLUGINS_DIR" || fail "rm $SHADOW_PLUGINS_DIR 失败 —— 手 rmdir 后再 up"
    ln -s "$PLUGINS_SRC" "$SHADOW_PLUGINS_DIR" || fail "ln 软链失败"
    ok "plugins 整目录软链完成 → $PLUGINS_SRC"
  else
    ln -s "$PLUGINS_SRC" "$SHADOW_PLUGINS_DIR" || fail "ln 软链失败"
    ok "plugins 整目录软链完成 → $PLUGINS_SRC"
  fi
  # 验证依赖链可解析（fail fast）
  local sample="agint-trajectory"
  if [ -d "$PLUGINS_SRC/$sample/lib" ]; then
    # 必须用 realpath 而不是 -e：-e 能跨一层软链，realpath 跟着软链链走到底
    # （仓 plugins/node_modules 是软链 → host plugins/node_modules → 又是软链 → /usr/local/lib/...）
    if ! realpath "$PLUGINS_SRC/node_modules/@deepseek-ai/dsh-storage-domain" >/dev/null 2>&1; then
      warn "本仓 plugins/node_modules/@deepseek-ai/dsh-storage-domain 依赖链断 —— 影子 dsh 启动 plugin 时会 MODULE_NOT_FOUND"
      warn "  排查:"
      warn "    ls -la $PLUGINS_SRC/node_modules/@deepseek-ai"
      warn "    ls -la \$(readlink $PLUGINS_SRC/node_modules/@deepseek-ai)/dsh-storage-domain"
      warn "    确认 host dsh 实际安装路径存在（典型: /usr/local/lib/node_modules/@deepseek-ai/dsh/...）"
      warn "  本地 sandbox 镜像 dsh 装在 /usr/lib/node_modules/ 而非 /usr/local/lib/node_modules/ 时必踩此坑"
    fi
  fi

  # 4) preset 软链：把 host 的 .agent-presets/agint 软链过来（skill 工具链要用）
  #    注意：preset 里 include 的 plugin 名要能解析到 shadow plugins，
  #    host 端已挂载的 plugin 在 shadow 也得有（上面软链已覆盖）
  if [ -d "$DSH_HOST/.agent-presets/agint" ] && [ ! -e "$SHADOW_PRESETS_DIR" ]; then
    log "软链 preset: $SHADOW_PRESETS_DIR → $DSH_HOST/.agent-presets/agint"
    mkdir -p "$(dirname "$SHADOW_PRESETS_DIR")"
    ln -s "$DSH_HOST/.agent-presets/agint" "$SHADOW_PRESETS_DIR"
    ok "preset 软链完成"
  fi
}

# ── cordis.patch.yml 同步策略 ────────────────────────────────
# 影子必须挂跟 host 同一份 cordis.patch.yml（不然 plugin 不加载）
# 选用「拷 + 标记」而非软链：避免影子误改 patch 时影响 host
sync_cordis_patch() {
  local host_patch="$DSH_HOST/profiles/web/cordis.patch.yml"
  local shadow_patch="$SHADOW_PROFILE_DIR/cordis.patch.yml"

  if [ ! -f "$host_patch" ]; then
    warn "host 没有 cordis.patch.yml —— 影子也不会挂任何 agint plugin"
    return 0
  fi

  # 用 rsync/cp 比较再覆盖（保留时间戳感知），避免每次重启都改 mtime
  if ! cmp -s "$host_patch" "$shadow_patch" 2>/dev/null; then
    cp -a "$host_patch" "$shadow_patch"
    log "cordis.patch.yml 已从 host 同步到影子"
  fi
}

# ── 拉起 dsh web（后台） ─────────────────────────────────────
launch_dsh() {
  local port="$1"
  check_port_free "$port" || fail ":$port 已被占用 —— 换 PORT 或先 down 旧影子"

  log "拉起 dsh --profile $SHADOW_PROFILE_NAME --port $port (DSH_HOME=$SHADOW_HOME)"
  log "日志: $SHADOW_LOG"

  # nohup + setsid 让 dsh 脱离当前终端（即便脚本退出也活着）
  DSH_HOME="$SHADOW_HOME" \
    nohup setsid dsh --profile "$SHADOW_PROFILE_NAME" --port "$port" --no-open \
      >"$SHADOW_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$SHADOW_PIDFILE"
  log "PID=$pid 已记录到 $SHADOW_PIDFILE"

  # 探活：最多等 30s
  log "等 dsh 就绪..."
  local ready=0
  for i in $(seq 1 30); do
    sleep 1
    # node 探端口判断是否真起来（比 ps 靠谱 —— 进程在 ≠ 端口在）
    if node -e "
      const net = require('net');
      const s = net.createServer();
      s.listen($port, '127.0.0.1', () => { s.close(); process.exit(0); });
      s.on('error', () => process.exit(1));
    " >/dev/null 2>&1; then
      # 端口被 dsh 占 = 影子活着
      if ! node -e "
        const net = require('net');
        const s = net.createServer();
        s.listen($port, '127.0.0.1', () => { s.close(); process.exit(0); });
        s.on('error', () => process.exit(1));
      " >/dev/null 2>&1; then
        ready=1
        ok "影子已就绪 (端口 $port 占用中)"
        break
      fi
    fi
    [ $((i % 5)) -eq 0 ] && log "  等待 ${i}s..."
  done

  if [ "$ready" -ne 1 ]; then
    fail "30s 内 dsh 未就绪 —— 看 $SHADOW_LOG 排查（可能 cordis.patch.yml 有坏行）"
  fi

  ok "🌑 影子 dsh 已起 → http://127.0.0.1:$port"
  log "提示：浏览器开新窗口连影子，别连 host(:3080)；本仓 plugins/ 改动 → 重启影子即生效"
}

# ── 停止 dsh web ─────────────────────────────────────────────
stop_dsh() {
  local pid=""
  if [ -f "$SHADOW_PIDFILE" ]; then
    pid="$(cat "$SHADOW_PIDFILE" 2>/dev/null || true)"
  fi
  # 双保险：pidfile + pgrep
  if [ -z "$pid" ]; then
    pid="$(pgrep -f "DSH_HOME=$SHADOW_HOME" | head -1 || true)"
  fi
  if [ -z "$pid" ]; then
    log "影子没在跑"
    rm -f "$SHADOW_PIDFILE"
    return 0
  fi

  log "SIGTERM → $pid"
  kill -SIGTERM "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || { ok "graceful 退出 (${i}s)"; rm -f "$SHADOW_PIDFILE"; return 0; }
    sleep 1
  done
  warn "10s 未退出，SIGKILL"
  kill -SIGKILL "$pid" 2>/dev/null || true
  rm -f "$SHADOW_PIDFILE"
  ok "影子已停"
}

# ── status ───────────────────────────────────────────────────
cmd_status() {
  if [ -f "$SHADOW_PIDFILE" ] && kill -0 "$(cat "$SHADOW_PIDFILE")" 2>/dev/null; then
    ok "🌑 影子运行中 (PID=$(cat "$SHADOW_PIDFILE"), port=$PORT)"
  else
    log "🌑 影子未运行"
  fi
  printf '   DSH_HOME   %s\n' "$SHADOW_HOME"
  printf '   AGINT_HOME %s\n' "$SHADOW_DATA"
  printf '   plugins    %s → %s\n' "$SHADOW_PLUGINS_DIR" "$PLUGINS_SRC"
  printf '   log        %s\n' "$SHADOW_LOG"
}

# ── logs ─────────────────────────────────────────────────────
cmd_logs() {
  local n="${1:-50}"
  [ -f "$SHADOW_LOG" ] || fail "日志不存在：$SHADOW_LOG（先 up）"
  tail -n "$n" "$SHADOW_LOG"
}

# ── reset ────────────────────────────────────────────────────
cmd_reset() {
  warn "将清空 $SHADOW_HOME 和 $SHADOW_DATA（plugins 软链会重建，AGINT 数据会丢）"
  read -r -p "确认? (yes/no) " ans
  [ "$ans" = "yes" ] || { log "取消"; return 0; }
  stop_dsh
  local ts="$(date +%Y%m%d-%H%M%S)"
  [ -d "$SHADOW_HOME" ] && mv "$SHADOW_HOME" "${SHADOW_HOME}.bak-$ts" && ok "SHADOW_HOME → .bak-$ts"
  [ -d "$SHADOW_DATA" ] && mv "$SHADOW_DATA" "${SHADOW_DATA}.bak-$ts" && ok "SHADOW_DATA → .bak-$ts"
  log "下次 up 会重建影子（全新状态）"
}

# ── path ─────────────────────────────────────────────────────
cmd_path() {
  printf 'AGINT_REPO=%s\n' "$AGINT_REPO"
  printf 'DSH_HOST=%s\n' "$DSH_HOST"
  printf 'SHADOW_HOME=%s\n' "$SHADOW_HOME"
  printf 'SHADOW_DATA=%s\n' "$SHADOW_DATA"
  printf 'SHADOW_PLUGINS_DIR=%s\n' "$SHADOW_PLUGINS_DIR"
  printf 'SHADOW_LOG=%s\n' "$SHADOW_LOG"
}

# ── help ─────────────────────────────────────────────────────
cmd_help() {
  sed -n '2,/^# 不依赖:/p' "$0" | sed 's/^# *//'
  echo ""
  echo "环境变量:"
  echo "  AGINT_REPO   本仓根目录 (默认自动探测)"
  echo "  DSH_HOST     host 的 DSH_HOME (默认 /dsh)"
  echo "  PORT         影子端口 (默认 3081)"
  echo "  SHADOW_HOME  影子 DSH_HOME (默认 /tmp/dsh-shadow)"
  echo "  SHADOW_DATA  影子 AGINT_HOME (默认 /tmp/agint-shadow-data)"
}

# ── dispatch ─────────────────────────────────────────────────
main() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    up)
      check_prereqs
      init_shadow_home
      sync_cordis_patch
      launch_dsh "$PORT"
      cmd_status
      ;;
    down)   stop_dsh ;;
    status) cmd_status ;;
    logs)   cmd_logs "${1:-50}" ;;
    reset)  cmd_reset ;;
    path)   cmd_path ;;
    help|-h|--help) cmd_help ;;
    *) fail "未知命令：$cmd（help 看用法）" ;;
  esac
}

main "$@"