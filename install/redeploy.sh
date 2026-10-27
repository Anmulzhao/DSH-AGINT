#!/usr/bin/env bash
# AGINT 本机部署位「装 + 重启 + 核验」一键脚本
#
# 把 install/install.sh、部署位核验、dsh web 重启三件事串成一条命令，
# 每步都 fail-closed：装失败不重启、核验发现镜像位回潮不重启、
# 端口没释放不拉起（避免 EADDRINUSE 假成功）。
#
# 用法：
#   ./install/redeploy.sh                  # 装到 profile.json 记录的 profile，核验，重启
#   ./install/redeploy.sh --dry-run        # 只打印会做什么，不写文件、不杀进程
#   ./install/redeploy.sh --profile=web    # 指定 profile（默认读 .agint-bundle/profile.json，回退 web）
#   ./install/redeploy.sh --verify-only    # 只核验部署位（不装、不重启）
#   ./install/redeploy.sh --no-install     # 跳过安装，只核验 + 重启
#   ./install/redeploy.sh --no-restart     # 装 + 核验，不动运行中的服务
#
# 其余参数：--port=3080 · --timeout=120 · --log=/tmp/dsh-web.log
#           --cwd=<启动工作目录，默认 $HOME> · --skip-parity · -h|--help
#
# 环境变量：
#   DSH_HOME       部署根（默认解析 $HOME/.dsh 的真实路径，本机 = ~/projects/DSH/AGINT-data）
#   AGINT_DATA_HOME 数据根覆盖口（默认同 DSH_HOME）
#   ⚠️ 脚本会强制把 AGINT_HOME 指回本仓根 —— 该变量在 install.sh 里是「源码根」，
#      在插件里是「数据根」，被外部污染会让安装把源码根指到数据目录（历史事故）。
#
# 退出码：0 全绿 · 1 有告警 · 2 前置失败 · 3 安装失败 · 4 部署位核验失败 · 5 重启失败
#
# 与 bin/safe-update.sh 的分工：那个是 2026-08 重启事故复盘留下的「改源码/改 patch 前
# 拍快照 + rollback」，不含安装；本脚本只管「把仓库装到部署位并让它跑起来」。
# 两者都用；回滚仍走 install/uninstall.sh --restore。

set -uo pipefail

# ── 参数 ────────────────────────────────────────────────────────────────
PROFILE_OPT=""
PORT=3080
TIMEOUT=120
LOGFILE="/tmp/dsh-web.log"
LAUNCH_CWD="$HOME"
DO_INSTALL=1
DO_RESTART=1
DRY_RUN=0
SKIP_PARITY=0

for arg in "$@"; do
  case "$arg" in
    --profile=*)    PROFILE_OPT="${arg#--profile=}" ;;
    --port=*)       PORT="${arg#--port=}" ;;
    --timeout=*)    TIMEOUT="${arg#--timeout=}" ;;
    --log=*)        LOGFILE="${arg#--log=}" ;;
    --cwd=*)        LAUNCH_CWD="${arg#--cwd=}" ;;
    --dry-run)      DRY_RUN=1 ;;
    --verify-only)  DO_INSTALL=0; DO_RESTART=0 ;;
    --no-install)   DO_INSTALL=0 ;;
    --no-restart)   DO_RESTART=0 ;;
    --skip-parity)  SKIP_PARITY=1 ;;
    -h|--help)      sed -n '2,38p' "$0"; exit 0 ;;
    *) printf '✗ 未知参数: %s（-h 看用法）\n' "$arg" >&2; exit 2 ;;
  esac
done

case "$PORT" in ''|*[!0-9]*) printf '✗ --port 必须是数字\n' >&2; exit 2 ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) printf '✗ --timeout 必须是数字\n' >&2; exit 2 ;; esac

# ── 路径与环境 ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

warn_n=0
FAIL_MSG=""

ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; warn_n=$((warn_n + 1)); }
bad()  { printf '  ✗ %s\n' "$*" >&2; FAIL_MSG="$*"; }
step() { printf '\n\033[1m[%s]\033[0m %s\n' "$1" "$2"; }
inf()  { printf '  · %s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit "${2:-2}"; }

# 只在非 dry-run 时执行；dry-run 打印命令但不落地
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [DRY] %s\n' "$*"
    return 0
  fi
  "$@"
}

# DSH_HOME：优先 env，其次 $HOME/.dsh 的真实路径（本机是 AGINT-data 的软链）
if [ -z "${DSH_HOME:-}" ]; then
  if [ -e "$HOME/.dsh" ]; then
    DSH_HOME="$(realpath "$HOME/.dsh")"
  else
    die "找不到部署根：DSH_HOME 未设且 $HOME/.dsh 不存在。设 DSH_HOME=<部署根> 再跑。"
  fi
fi
[ -d "$DSH_HOME" ] || die "DSH_HOME 不是目录：$DSH_HOME"

export DSH_HOME
export AGINT_DATA_HOME="${AGINT_DATA_HOME:-$DSH_HOME}"
# 把 install.sh 的「源码根」钉死在本仓，顺带抵消外部 AGINT_HOME 污染的两种语义冲突
if [ -n "${AGINT_HOME:-}" ] && [ "$(realpath "$AGINT_HOME" 2>/dev/null)" != "$REPO_ROOT" ]; then
  printf '  ⚠ AGINT_HOME 被外部设为 %s —— 已强制改回本仓 %s（该变量双语义，污染会装错源）\n' \
    "$AGINT_HOME" "$REPO_ROOT"
  warn_n=$((warn_n + 1))
fi
export AGINT_HOME="$REPO_ROOT"

# dsh 必须在 PATH（check-preset-parity 会 spawn 它；缺了报 CRITICAL baseline-unavailable）
if ! command -v dsh >/dev/null 2>&1; then
  for c in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$c/dsh" ] && { export PATH="$c:$PATH"; break; }
  done
fi
command -v dsh >/dev/null 2>&1 || die "dsh 不在 PATH（找不到可执行的 dsh），无法核验/重启"

# DSH_ROOT = dsh 包的安装根（readlink 穿过 bin/dsh 软链后上溯两级）
DSH_BIN_REAL="$(readlink -f "$(command -v dsh)")"
export DSH_ROOT="$(dirname "$(dirname "$DSH_BIN_REAL")")"
if ! node -e "process.exit(require('$DSH_ROOT/package.json').name==='@deepseek-ai/dsh'?0:1)" 2>/dev/null; then
  die "DSH_ROOT 推导失败：$DSH_ROOT 不是 @deepseek-ai/dsh 包根"
fi
DSH_VER="$(node -e "console.log(require('$DSH_ROOT/package.json').version)" 2>/dev/null || echo '?')"

# profile：参数 > 安装事实文件 > web
if [ -z "$PROFILE_OPT" ]; then
  PROFILE_OPT="$(sed -n 's/.*"profile"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$DSH_HOME/.agint-bundle/profile.json" 2>/dev/null | head -1)"
  [ -n "$PROFILE_OPT" ] || PROFILE_OPT="web"
fi
PROFILE="$PROFILE_OPT"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
BUNDLE="$DSH_HOME/.agint-bundle"
[ -f "$PROFILE_DIR/package.json" ] || die "profile 不存在或无 package.json：$PROFILE_DIR（先用 dsh --profile $PROFILE 起一次生成）"
export DSH_PROFILE="$PROFILE"

printf '\033[1mAGINT redeploy\033[0m  repo=%s\n' "$REPO_ROOT"
printf '  DSH_HOME=%s\n  profile=%s  dsh=%s  port=%s%s\n' \
  "$DSH_HOME" "$PROFILE" "$DSH_VER" "$PORT" "$([ "$DRY_RUN" -eq 1 ] && echo '  (dry-run)')"

# ── 小工具 ──────────────────────────────────────────────────────────────
# 端口上的监听进程（比 pgrep -f 'dsh web' 准：后者会匹配到调用它的 shell 自身）
port_pid() { ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }
port_busy() { [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]; }
port_free() { ! port_busy; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
pid_dead() { ! pid_alive "${1:-}"; }

# grep -c 在 0 命中时退出码为 1，`|| echo 0` 会再打一行 → 变量变 "0\n0"。
# 统一走这里取计数，避免 -gt/+ 比较炸掉。
count_of() { local n; n="$(grep -c "$1" "$2" 2>/dev/null)"; printf '%s' "${n:-0}"; }

wait_until() {  # wait_until <秒> <判定函数> [参数...]
  local t="$1" fn="$2"; shift 2
  local i=0
  while [ "$i" -lt "$t" ]; do
    "$fn" "$@" && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

# ── 2. 安装 ────────────────────────────────────────────────────────────
if [ "$DO_INSTALL" -eq 1 ]; then
  step 1/3 "安装到 profile=$PROFILE"
  INSTALL_LOG="/tmp/agint-install-$(date +%Y%m%d-%H%M%S).log"
  if [ "$DRY_RUN" -eq 1 ]; then
    run bash "$REPO_ROOT/install/install.sh" --dry-run "--profile=$PROFILE"
    INSTALL_RC=0
  else
    if bash "$REPO_ROOT/install/install.sh" "--profile=$PROFILE" >"$INSTALL_LOG" 2>&1; then
      INSTALL_RC=0
    else
      INSTALL_RC=$?
    fi
    inf "日志：$INSTALL_LOG"
    grep -E '✗|ERROR|FAIL' "$INSTALL_LOG" | head -8 | sed 's/^/    /'
  fi
  if [ "${INSTALL_RC:-0}" -ne 0 ]; then
    bad "install.sh 退出码 $INSTALL_RC —— 不重启（部署位可能是半装状态，先看日志再决定是否 uninstall.sh --restore）"
    printf '\n✗ 安装失败，已中止（运行中的服务没动）\n' >&2
    exit 3
  fi
  ok "install.sh 退出码 0"
else
  step 1/3 "安装 —— 已跳过"
fi

# ── 3. 部署位核验 ──────────────────────────────────────────────────────
step 2/3 "核验部署位"

PATCH="$BUNDLE/cordis.patch.yml"
[ -f "$PATCH" ] || bad "缺少 $PATCH"
MOUNT_ROWS="$(count_of '^[[:space:]]*name: \./plugins/' "$PATCH")"
PLUGIN_DIRS="$(ls -1d "$BUNDLE"/plugins/*/ 2>/dev/null | wc -l)"
inf "bundle 挂载声明 ${MOUNT_ROWS} 条 · bundle plugin 目录 ${PLUGIN_DIRS} 个"
[ "$MOUNT_ROWS" -gt 0 ] || bad "bundle patch 里 0 条挂载声明（patch 没铺对）"

# ③-1 bundle 注册进 profile 清单
if grep -q '"@agint/host"' "$PROFILE_DIR/package.json" 2>/dev/null; then
  ok "profile 清单已注册 @agint/host"
else
  bad "profile 清单没有 @agint/host（bundle 不会被加载）"
fi

# ③-2 解析软链
LINK="$PROFILE_DIR/node_modules/@agint/host"
if [ -L "$LINK" ] && [ "$(realpath "$LINK")" = "$(realpath "$BUNDLE")" ]; then
  ok "软链在位：node_modules/@agint/host → .agint-bundle"
else
  bad "软链缺失或指错：$LINK $( [ -e "$LINK" ] && realpath "$LINK" || echo '(不存在)')"
fi

# ③-3 安装事实
FACT="$(sed -n 's/.*"profile"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$BUNDLE/profile.json" 2>/dev/null | head -1)"
if [ "$FACT" = "$PROFILE" ]; then
  ok "安装事实 profile.json = $PROFILE"
else
  warn "profile.json = '${FACT:-空}' ≠ 本次 profile=$PROFILE（下次不带 --profile 会读错）"
fi

# ③-4 preset 工具行锚点：必须锚 bundle，镜像位必须 0
#     镜像位 > 0 = 老写法回潮 = 装第二个 profile 会静默指空（v0.14.0 修的就是这个）
shopt -s nullglob
ANY_PRESET=0
for f in "$DSH_HOME"/.agent-presets/*/agent.cordis.yml; do
  ANY_PRESET=1
  name="$(basename "$(dirname "$f")")"
  anchored="$(count_of '\.\./\.\./\.agint-bundle/plugins/' "$f")"
  mirror="$(count_of 'profiles/[A-Za-z0-9._-]\+/plugins/' "$f")"
  if [ "$mirror" -gt 0 ]; then
    bad "$name 有 $mirror 行指向镜像位 profiles/*/plugins/（老写法回潮，重装未生效）"
  elif [ "$anchored" -gt 0 ]; then
    ok "$name 工具行 $anchored 条全锚 .agint-bundle，镜像位 0"
  else
    inf "$name 无工具行（跳过）"
  fi
done
[ "$ANY_PRESET" -eq 1 ] || bad "$DSH_HOME/.agent-presets/ 下没有任何 preset"
shopt -u nullglob

# ③-5 母 preset 与仓库是否一致
REPO_PRESET="$REPO_ROOT/presets/agint/agent.cordis.yml"
DEP_PRESET="$DSH_HOME/.agent-presets/agint/agent.cordis.yml"
if [ -f "$REPO_PRESET" ] && [ -f "$DEP_PRESET" ]; then
  if diff -q "$REPO_PRESET" "$DEP_PRESET" >/dev/null 2>&1; then
    ok "母 preset 与仓库逐字一致"
  else
    warn "母 preset 与仓库不一致：$(diff "$REPO_PRESET" "$DEP_PRESET" | grep -c '^[<>]') 行差异"
  fi
fi

# ③-6 一致性门禁（spawn dsh --dump-config 取 live 基线）
if [ "$SKIP_PARITY" -eq 1 ]; then
  inf "check-preset-parity —— 已跳过"
elif [ "$DRY_RUN" -eq 1 ]; then
  run node "$REPO_ROOT/bin/check-preset-parity.mjs"
else
  PARITY_OUT="$(cd "$REPO_ROOT" && node bin/check-preset-parity.mjs 2>&1)"
  PARITY_RC=$?
  # 明细默认会被截断（只印前几条），条数要从表头 🔵 INFO (N) / 🔴 CRITICAL (N) 读
  P_INFO="$(printf '%s' "$PARITY_OUT" | grep -oE 'INFO \([0-9]+\)' | grep -oE '[0-9]+' | head -1)"
  P_CRIT="$(printf '%s' "$PARITY_OUT" | grep -oE 'CRITICAL \([0-9]+\)' | grep -oE '[0-9]+' | head -1)"
  if [ "$PARITY_RC" -eq 0 ]; then
    ok "check-preset-parity 通过（CRITICAL ${P_CRIT:-0} / INFO ${P_INFO:-0}）"
  else
    printf '%s\n' "$PARITY_OUT" | grep -E 'CRITICAL|WARN|✗' | head -6 | sed 's/^/    /'
    bad "check-preset-parity 退出码 $PARITY_RC"
  fi
fi

if [ -n "$FAIL_MSG" ]; then
  printf '\n✗ 部署位核验失败：%s\n' "$FAIL_MSG" >&2
  [ "$DO_RESTART" -eq 1 ] && printf '  已中止，不重启（带着错配置拉起只会把问题藏起来）\n' >&2
  exit 4
fi

# ── 4. 重启 ────────────────────────────────────────────────────────────
if [ "$DO_RESTART" -eq 0 ]; then
  step 3/3 "重启 —— 已跳过"
  printf '\n✓ 安装 + 核验完成（服务未重启%s）\n' "$([ "$DRY_RUN" -eq 0 ] && echo '，改动要重启才生效')"
  [ "$warn_n" -gt 0 ] && { printf '  告警 %s 条\n' "$warn_n"; exit 1; }
  exit 0
fi

step 3/3 "重启 dsh web"

OLD_PID="$(port_pid)"
if [ -n "$OLD_PID" ]; then
  inf "旧实例 pid=$OLD_PID（端口 $PORT）→ SIGTERM"
  run kill -TERM "$OLD_PID" 2>/dev/null
  if [ "$DRY_RUN" -eq 0 ]; then
    if wait_until 20 pid_dead "$OLD_PID"; then
      ok "旧实例已优雅退出"
    else
      warn "20s 未退出，SIGKILL"
      kill -KILL "$OLD_PID" 2>/dev/null
      sleep 2
    fi
  fi
else
  inf "端口 $PORT 上没有实例（冷启动）"
fi

# 端口必须真的空出来再拉起，否则新实例 EADDRINUSE
if [ "$DRY_RUN" -eq 0 ]; then
  if ! wait_until 15 port_free; then
    bad "端口 $PORT 过了 15s 仍被占用，放弃拉起"
    printf '\n✗ 重启失败：端口未释放\n' >&2
    exit 5
  fi
  ok "端口 $PORT 已释放"
fi

# 日志滚动一份旧的，失败时好对比
START_EPOCH="$(date +%s)"
MARKER="$(mktemp -t agint-redeploy.XXXXXX)"
if [ -s "$LOGFILE" ] && [ "$DRY_RUN" -eq 0 ]; then
  mv -f "$LOGFILE" "${LOGFILE%.log}-$(date +%H%M%S).log" 2>/dev/null && inf "旧日志已滚动"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [DRY] ( cd %s && setsid nohup dsh web --no-open > %s 2>&1 & )\n' "$LAUNCH_CWD" "$LOGFILE"
  printf '\n✓ dry-run 结束：上面就是会执行的完整动作，未做任何改动\n'
  exit 0
fi

( cd "$LAUNCH_CWD" && setsid nohup dsh web --no-open >"$LOGFILE" 2>&1 & ) 2>/dev/null \
  || ( cd "$LAUNCH_CWD" && nohup dsh web --no-open >"$LOGFILE" 2>&1 & )
inf "已拉起，等端口就绪（上限 ${TIMEOUT}s）"

if ! wait_until "$TIMEOUT" port_busy; then
  printf '\n✗ 重启失败：%ss 内端口 %s 没起来，日志尾部：\n' "$TIMEOUT" "$PORT" >&2
  tail -25 "$LOGFILE" | sed 's/^/  /' >&2
  exit 5
fi
READY_S=$(( $(date +%s) - START_EPOCH ))
NEW_PID="$(port_pid)"
ok "端口 $PORT 就绪（pid=${NEW_PID:-?}，耗时 ${READY_S}s）"

# ── 5. 启动后核验 ──────────────────────────────────────────────────────
printf '\n\033[1m[启动后核验]\033[0m\n'

if grep -q 'skipping profile bundle' "$LOGFILE"; then
  bad "日志出现 'skipping profile bundle' —— bundle 层被跳过，插件没加载"
  grep 'skipping profile bundle' "$LOGFILE" | head -3 | sed 's/^/    /'
else
  ok "无 'skipping profile bundle'"
fi

# 1) 插件已加载的实证：日志里出现 agint-* 插件的运行时输出
AGINT_LOG_LINES="$(count_of '\[agint-' "$LOGFILE")"
if [ "$AGINT_LOG_LINES" -gt 0 ]; then
  ok "日志里 ${AGINT_LOG_LINES} 行 agint-* 插件运行时输出（插件真起来了）"
else
  warn "日志里没有 agint-* 插件输出 —— 挂载可能没生效，看会话里的 cordis 插件列表"
fi

# 2) cron job 数（宿主 schedule 懒加载，可能晚一拍）
JOBS=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  JOBS="$(grep -o '"jobs":[0-9]*' "$LOGFILE" 2>/dev/null | head -1 | cut -d: -f2)"
  [ -n "$JOBS" ] && break
  sleep 1
done
[ -n "$JOBS" ] && ok "agint-cron 注册 $JOBS 个 job" || warn "10s 内没读到 agint-cron jobs 计数（可能还在懒加载）"

# 3) 入口地址：token 含 - 和 _，字符集要放宽；且这行比端口就绪晚一拍，得等
TOKEN_URL=""
for _ in $(seq 1 25); do
  TOKEN_URL="$(grep -oE "http://[0-9.]+:${PORT}/\?token=[A-Za-z0-9._-]+" "$LOGFILE" 2>/dev/null | head -1)"
  [ -n "$TOKEN_URL" ] && break
  sleep 1
done
[ -n "$TOKEN_URL" ] && ok "入口：$TOKEN_URL" || warn "25s 内没读到带 token 的入口地址"

# 4) storage 域落盘（弱信号：插件按需写，可能几分钟后才动，缺了只提示不告警）
BOOTED=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  BOOTED="$(find "$DSH_HOME/storages" -maxdepth 1 -name 'agint*' -newer "$MARKER" 2>/dev/null | wc -l)"
  [ "$BOOTED" -gt 0 ] && break
  sleep 1
done
if [ "$BOOTED" -gt 0 ]; then
  ok "启动后写入 ${BOOTED} 个 agint storage 域"
else
  inf "启动后 15s 内没有 agint storage 域落盘（插件按需写，非异常）"
fi
rm -f "$MARKER"

printf '\n'
if [ -n "$FAIL_MSG" ]; then
  printf '✗ 服务起在 :%s，但启动后核验有问题：%s\n' "$PORT" "$FAIL_MSG"
  exit 5
fi
if [ "$warn_n" -gt 0 ]; then
  printf '✓ 完成，但有 %s 条告警（见上）\n' "$warn_n"
  exit 1
fi
printf '✓ 全部通过：装 → 核验 → 重启 → 启动后核验\n'
[ -n "$TOKEN_URL" ] && printf '  浏览器入口（token 每次重启都变）：%s\n' "$TOKEN_URL"
exit 0
