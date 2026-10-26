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
# ⚠️ 2026-10-26 起分工调整：本脚本保留「拍快照 + 倒序回滚」这一套（它仍是改源码前
#    唯一的回滚点来源）；但「装仓库改动到部署位 + 重启 + 部署位核验」请直接用
#    `install/redeploy.sh`（含挂载行 / preset 锚点 / parity 门禁核验，本脚本没有）。
#    restart 动作保留可用，仅在 redeploy.sh 不可用时兜底。
#
# 依赖：bash 4+, tar, cp, ss（按端口取进程，比 pgrep 准）, pgrep（ss 取不到时兜底）, cat, wc, grep
# 不依赖：dsh CLI 任何子命令（脚本不知道 dsh 内部，只看进程 + 文件）

set -uo pipefail   # 不加 -e：希望收集所有错误后统一报告

# 脚本自定位必须在 AGINT_HOME 推导之前（旧版写死 $HOME/projects/AGINT，本机早就不在那儿）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGINT_HOME="${AGINT_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# DSH_HOME 默认走 $HOME/.dsh 的真实路径（本机是 ~/projects/DSH/AGINT-data 的软链）
if [ -z "${DSH_HOME:-}" ] && [ -e "$HOME/.dsh" ]; then
  DSH_HOME="$(realpath "$HOME/.dsh")"
fi
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_WEB_PORT="${DSH_WEB_PORT:-3080}"

# dsh 可能根本不在 PATH 里（非交互 shell 不读 .bashrc，nvm 的 bin 就丢了）——
# 旧版直接 `nohup dsh web` 会得到「nohup: 无法运行命令'dsh'」，服务当场起不来。
if ! command -v dsh >/dev/null 2>&1; then
  for c in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$c/dsh" ] && { PATH="$c:$PATH"; export PATH; break; }
  done
fi
DSH_BIN="$(command -v dsh 2>/dev/null || true)"
[ -n "$DSH_BIN" ] || DSH_BIN=dsh

# 2026-09-28 根因 fix（本机实测取证）。Windows 上 DSH 运行时注入的 DSH_HOME 是
# 反斜杠路径（实测 DSH_HOME=C:\Users\Administrator\.dsh，而 $HOME=/c/Users/...），
# 于是所有派生路径都成了混合分隔符，引发两个互相掩盖的故障：
#   1) compgen -G "$PLUGINS_DIR/agint-*" 恒 MISS → snapshot_plugins 走「跳过」分支
#      只打一行 warning 却 exit 0 → 改了源码却没回滚点，调用方以为快照成功了；
#   2) tar czf "$BACKUP_ROOT/..." 把 "C:" 当成远程主机前缀解析 →
#      `Cannot connect to C: resolve failed`，tar exit 128，但脚本无 set -e 仍继续
#      并打印 ✓ —— 假成功。
# 在源头归一化成 POSIX 路径，一次修好全部派生变量（BACKUP_ROOT / PLUGINS_DIR / …）。
if command -v cygpath >/dev/null 2>&1; then
  DSH_HOME="$(cygpath -u "$DSH_HOME")"
  AGINT_HOME="$(cygpath -u "$AGINT_HOME")"
fi

BACKUP_ROOT="$DSH_HOME/.agint-backups"
TS="$(date +%Y%m%d-%H%M%S)"
# SCRIPT_DIR 已在上方定义（先于 AGINT_HOME，供其推导源码根）

# 本机「AGINT 装在哪个 profile」的真源：install.sh 3.7 写的安装事实文件。
# ⚠️ 2026-10-21 修：此前写死 web。web profile 已于 2026-10-18 退役（老板令），
# 2026-10-20 确认 profiles/web 目录已删 ⇒ 写死 web = 指向不存在的目录。
# ⚠️ 2026-10-26 再修：兜底值 desktop 也过时了（本机 2026-10 已迁回 web，profile.json
#    就是 web）。兜底改成 web，并校验目录真实存在，否则直接说清楚。
DSH_PROFILE_NAME="$(sed -n 's/.*"profile"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DSH_HOME/.agint-bundle/profile.json" 2>/dev/null | head -1)"
[ -n "$DSH_PROFILE_NAME" ] || DSH_PROFILE_NAME="web"
if [ ! -d "$DSH_HOME/profiles/$DSH_PROFILE_NAME" ]; then
  printf '✗ profile 目录不存在：%s/profiles/%s\n' "$DSH_HOME" "$DSH_PROFILE_NAME" >&2
  printf '  安装事实文件写的是 "%s"，但盘上没有。先跑 install/redeploy.sh --profile=<名> 或改 profile.json\n' "$DSH_PROFILE_NAME" >&2
  exit 1
fi
# ⚠️ 2026-10-26 改指：AGINT 的挂载行由 **bundle patch**（.agint-bundle/cordis.patch.yml）
#    承载，profile 级 patch 自 v0.14.0 起只剩本机本地覆盖（install.sh 明说「不再写它」）。
#    旧版这里快照的是 profile patch ⇒ 回滚了挂载段的"假文件"，挂载其实没回来。
CORDIS_PATCH="$DSH_HOME/.agint-bundle/cordis.patch.yml"
[ -f "$CORDIS_PATCH" ] || CORDIS_PATCH="$DSH_HOME/profiles/$DSH_PROFILE_NAME/cordis.patch.yml"
PROFILE_PATCH="$DSH_HOME/profiles/$DSH_PROFILE_NAME/cordis.patch.yml"
PRESET="$DSH_HOME/.agent-presets/agint/agent.cordis.yml"
# 插件实体自 2026-10-01 起在 .agint-bundle/plugins（主挂载源），profile 下的
# plugins/ 只是兼容镜像位。快照/回滚要拍"真正被加载的那份"，否则回滚回镜像位
# 等于什么都没回滚（镜像位不参与挂载，改了不生效还不报错）。
if [ -d "$DSH_HOME/.agint-bundle/plugins" ]; then
  PLUGINS_DIR="$DSH_HOME/.agint-bundle/plugins"
else
  PLUGINS_DIR="$DSH_HOME/profiles/$DSH_PROFILE_NAME/plugins"
fi
STORAGE_DIR="$DSH_HOME/storages"
SENTINEL_LEASE="$DSH_HOME/sentinel.lease"

# ── 通用工具 ────────────────────────────────────────────────
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
ok()   { printf '✓ %s\n' "$*"; }
have_cmd() { command -v "$1" >/dev/null 2>&1 || fail "缺依赖：$1"; }

# ── 快照函数 ────────────────────────────────────────────────
snapshot_cordis_patch() {
  [ -f "$CORDIS_PATCH" ] || { log "bundle cordis.patch.yml 不存在，跳过"; return; }
  cp -a "$CORDIS_PATCH" "$CORDIS_PATCH.bak-$TS"
  ok "bundle cordis.patch.yml → .bak-$TS"
  # profile 级 patch 顺手也拍（本机本地覆盖，回滚时一起还原才一致）
  if [ -f "$PROFILE_PATCH" ] && [ "$PROFILE_PATCH" != "$CORDIS_PATCH" ]; then
    cp -a "$PROFILE_PATCH" "$PROFILE_PATCH.bak-$TS"
    ok "profile cordis.patch.yml → .bak-$TS"
  fi
}

snapshot_preset() {
  [ -f "$PRESET" ] || { log "agent.cordis.yml 不存在，跳过"; return; }
  cp -a "$PRESET" "$PRESET.bak-$TS"
  ok "agent.cordis.yml → .bak-$TS"
}

snapshot_plugins() {
  mkdir -p "$BACKUP_ROOT"
  # 2026-08-21 fix (evolve_propose id 0938c4b6): 旧写法用 -C "$PLUGINS_DIR" 但 glob agint-*
  # 仍由外层 shell 在 AGINT_HOME 提前展开,会把根目录的 agint-*.bundle 等非 plugin
  # 文件错配进来,导致 tar 报"无法 stat"或打包为空。改为 subshell + cd 进 PLUGINS_DIR
  # 后再展开 glob,确保只匹配真实的 plugin 子目录。
  #
  # 2026-09-28 fix (本机实测取证): 判据 compgen -G "$PLUGINS_DIR/agint-*" 在 Windows 上
  # 恒 MISS —— DSH 运行时注入的 DSH_HOME 是反斜杠路径(C:\Users\x\.dsh),拼出的混合分隔符
  # glob bash 匹配不到。实测同一时刻: compgen MISS 而 (cd 后 ls -d agint-*/) = 35。
  # 后果: 走 else 分支只打一行 warning 就 exit 0 ——「改了源码却没回滚点」,调用方却以为
  # 快照拍成功了。修复两处: (1) 判据改成先 cd 进目录再 ls -d; (2) 拍不到就 fail 而非
  # warning —— 安全网缺失是危险信号,不该当可跳过项。
  local n
  if ! cd "$PLUGINS_DIR" 2>/dev/null; then
    fail "插件目录 cd 失败,plugins 快照未生成,已中止(不会带着无回滚点继续): $PLUGINS_DIR"
  fi
  n="$(ls -d agint-*/ 2>/dev/null | wc -l)"
  if [ "${n:-0}" -eq 0 ]; then
    fail "插件目录存在但未找到 agint-* 子目录,plugins 快照未生成,已中止: $PLUGINS_DIR"
  fi
  ( cd "$PLUGINS_DIR" && tar czf "$BACKUP_ROOT/agint-plugins-$TS.tar.gz" \
      --exclude='*.bak-*' agint-* ) \
    || fail "tar 打包失败,plugins 快照未生成,已中止: $BACKUP_ROOT/agint-plugins-$TS.tar.gz"
  ok "plugins → $BACKUP_ROOT/agint-plugins-$TS.tar.gz（$n 个插件）"
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
# ⚠️ 不能用 `pgrep -f 'dsh web' | head -1` 取进程：
#   ① 它会匹配到**执行本脚本的那个 shell 自身**（命令行里含 "safe-update.sh restart"，
#      而某些包装层会把整条命令带进来），极端情况下 SIGTERM 打到自己；
#   ② 端口上到底是谁在听，只有 ss 说了算。
# 正解：先按端口取 pid，取不到再退回 pgrep 但排除自身 pid 与父 shell。
listening_pid() {
  ss -ltnpH "sport = :$DSH_WEB_PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

dsh_pid() {
  local pid
  pid="$(listening_pid)"
  if [ -z "$pid" ]; then
    pid="$(pgrep -f 'node .*/dsh web' 2>/dev/null | head -1 || true)"
  fi
  [ "${pid:-}" = "$$" ] && pid=""
  printf '%s' "${pid:-}"
}

port_busy() { [ -n "$(ss -ltnH "sport = :$DSH_WEB_PORT" 2>/dev/null)" ]; }

graceful_stop_dsh() {
  local pid
  pid="$(dsh_pid)"
  if [ -z "$pid" ]; then
    log "dsh web 未跑（端口 $DSH_WEB_PORT 空）"
    return 0
  fi
  log "SIGTERM → $pid（端口 $DSH_WEB_PORT）"
  kill -SIGTERM "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 "$pid" 2>/dev/null || { ok "graceful 退出 (${i}s)"; break; }
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "兜底 SIGKILL → $pid"
    kill -SIGKILL "$pid" 2>/dev/null || true
    sleep 2
  fi
  # 必须等端口真释放，否则新实例 EADDRINUSE
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    port_busy || break
    sleep 1
  done
  if port_busy; then
    fail "端口 $DSH_WEB_PORT 仍被占用，放弃启动（避免 EADDRINUSE 假成功）"
  fi
  # 清临时锁
  rm -f "$SENTINEL_LEASE.tmp" "$STORAGE_DIR"/*.tmp 2>/dev/null || true
}

start_dsh() {
  local LOGF=/tmp/dsh-web.log
  log "启动 dsh web（bin=$DSH_BIN，cwd=$HOME，--no-open）"
  # 旧日志滚动一份，起不来时好和上一版对比
  [ -s "$LOGF" ] && mv -f "$LOGF" "${LOGF%.log}-$(date +%H%M%S).log" 2>/dev/null
  ( cd "$HOME" && setsid nohup "$DSH_BIN" web --no-open >"$LOGF" 2>&1 & ) 2>/dev/null \
    || ( cd "$HOME" && nohup "$DSH_BIN" web --no-open >"$LOGF" 2>&1 & )
  local i=0
  while [ "$i" -lt 90 ]; do
    if port_busy; then
      ok "dsh web 重启 OK（pid=$(listening_pid)，端口 $DSH_WEB_PORT，log=$LOGF）"
      if grep -q 'skipping profile bundle' "$LOGF" 2>/dev/null; then
        log "⚠ 日志出现 skipping profile bundle —— bundle 层被跳过，插件没加载"
      fi
      local url
      url="$(grep -oE "http://[0-9.]+:${DSH_WEB_PORT}/\?token=[A-Za-z0-9._-]+" "$LOGF" 2>/dev/null | head -1)"
      [ -n "$url" ] && log "入口：$url"
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  fail "dsh web 90s 内没起来，日志尾部：$(tail -12 "$LOGF" | tr '\n' ' ')"
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
  # 2. cron job：数量从 jobs.js 现读，别写死（2026-10-26 时是 27 个，旧文写 6 个）
  local JOBS_JS="$PLUGINS_DIR/agint-cron/lib/jobs.js"
  if [ -f "$JOBS_JS" ]; then
    local n_jobs n_core missing
    n_jobs="$(grep -coE "id: '[a-z0-9-]+'" "$JOBS_JS" 2>/dev/null || echo 0)"
    # 抽几个跨版本都该在的核心 job 做存在性判据（数量会随版本涨，id 相对稳）
    missing=""
    for j in memory-decay wiki-lint night-dream metrics-collect evolve-review; do
      grep -q "id: '$j'" "$JOBS_JS" || missing="$missing $j"
    done
    if [ -n "$missing" ]; then
      log "warning: agint-cron 缺核心 job:$missing（jobs.js 可能有结构变更）"
    elif [ "${n_jobs:-0}" -lt 10 ]; then
      log "warning: agint-cron 只读到 $n_jobs 个 job（少于 10，疑似 jobs.js 被截断）"
    else
      ok "agint-cron $n_jobs 个 job，5 个核心 job 齐全"
    fi
  else
    log "warning: 找不到 $JOBS_JS（插件快照可能没铺到 $PLUGINS_DIR）"
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

  # 5. LOCAL-STATE 回写：挂载/重启后 AGENTS.md「本机实况」块按 host 实测自动刷新
  #    （2026-09-07 P0-1 挂载教训：插件挂上了但围栏块没登记，文档失真）
  if command -v node >/dev/null 2>&1; then
    # 注意：不能用 POSIX 绝对路径（/d/...）直传 node.exe——MSYS 不转换，Windows node 不认。
    # 用 subshell cd 到 SCRIPT_DIR 后走相对路径（mjs 内部用 import.meta.url 自定位，cwd 无关）。
    if ( cd "$SCRIPT_DIR" && node agents-local-state.mjs ) >/dev/null 2>&1; then
      ok "AGENTS.md LOCAL-STATE 已按 host 实测回写"
    else
      log "warning: agents-local-state 回写失败（不阻塞 smoke，可手动跑 node bin/agents-local-state.mjs）"
    fi
  else
    log "warning: node 不在 PATH，跳过 LOCAL-STATE 回写"
  fi
}

# ── 前置检查 ────────────────────────────────────────────────
require_clean() {
  mkdir -p "$BACKUP_ROOT" || fail "建备份目录失败：$BACKUP_ROOT"
  if port_busy; then
    log "dsh web 在跑（端口 $DSH_WEB_PORT，pid=$(listening_pid)）—— 非 restart 动作时会保持运行"
  fi
}

# ── 动作分发 ────────────────────────────────────────────────
case "${1:-help}" in
  mount-patch)
    require_clean
    snapshot_all
    log "挂载行源在仓库：$AGINT_HOME/cordis.patch.yml"
    log "部署位的生效副本：$CORDIS_PATCH"
    log "改仓库那份后跑：$AGINT_HOME/install/redeploy.sh（会重新铺 + 核验 + 重启）"
    log "只改现场副本（应急）后跑：$0 restart"
    ;;
  edit-source)
    require_clean
    snapshot_plugins
    snapshot_cordis_patch
    snapshot_preset
    log "源码在仓库：$AGINT_HOME/plugins/agint-*/lib/*.js 与 $AGINT_HOME/presets/agint/"
    log "部署位实体（本次已快照）：$PLUGINS_DIR/agint-*"
    log "改仓库后跑：$AGINT_HOME/install/redeploy.sh（会把仓库重新铺下来，覆盖现场改动）"
    log "只改现场（应急）后跑：$0 restart"
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
      ok "cordis.patch.yml 已从 $TARGET 恢复（$CORDIS_PATCH）"
    }
    if [ -f "$PROFILE_PATCH.bak-$TARGET" ] && [ "$PROFILE_PATCH" != "$CORDIS_PATCH" ]; then
      cp -a "$PROFILE_PATCH.bak-$TARGET" "$PROFILE_PATCH"
      ok "profile 级 cordis.patch.yml 已从 $TARGET 恢复"
    fi
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
    # 打印文件头的连续注释块（旧写法写死行号 2,18，加两行说明就截断）
    awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"
    ;;
esac