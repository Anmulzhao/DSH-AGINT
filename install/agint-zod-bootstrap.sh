#!/usr/bin/env bash
# install/agint-zod-bootstrap.sh — 放置 zod 到 agint-quality/plugin 树
#
# ## 背景
#   agint-quality-sdk 通过相对路径借 zod：
#     ../../agint-quality/node_modules/zod/index.js
#   而 agint-quality-contract / sandbox / eval / report / policy 子插件
#   使用裸 specifier `from 'zod'`，Node ESM 向上查找会命中同一个目录。
#   dsh plugin loader 不自动跑 `npm install`，peerDependencies 形同虚设。
#
# ## 行为
#   幂等：检查 <dst>/node_modules/zod/index.js 是否可用，存在即跳过。
#   不动 package.json：保留 agint-quality 的 peerDependencies ^3 声明。
#   优先复用本机已有的 zod 4+ 安装（cp -r，比 npm install 快且避免 sparse
#   package.json 下 arborist reify 崩——见 2026-08-21 笔记）。
#   找不到本地源 → 仅 warn，不强制联网（尊重 install 的安全左移哲学）。
#
# ## 用法
#   install/agint-zod-bootstrap.sh                 # 跑一次（DSH_HOME 默认 $HOME/.dsh）
#   DSH_HOME=... install/agint-zod-bootstrap.sh    # 指定 dsh 根
#   install/agint-zod-bootstrap.sh --dry-run       # 只打印，不写
#   install/agint-zod-bootstrap.sh --uninstall     # 删 node_modules/zod
#
# ## 退出码
#   0 = 已就绪（或刚完成放置）；1 = 缺源，需人工；2 = 参数错。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGINT_HOME_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGINT_HOME="${AGINT_HOME:-$AGINT_HOME_DEFAULT}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

DST="$DSH_HOME/profiles/web/plugins/agint-quality/node_modules/zod"
DST_PARENT="$(dirname "$DST")"

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "[zod-bootstrap] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log()  { echo "[zod-bootstrap] $*"; }
warn() { echo "[zod-bootstrap] ⚠ $*" >&2; }
die()  { echo "[zod-bootstrap] ✗ $*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then echo "DRY: $*"; else eval "$@"; fi
}

# ── uninstall 路径 ───────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
  if [ ! -e "$DST" ]; then
    log "no-op: $DST 不存在"
    exit 0
  fi
  if [ -L "$DST" ]; then
    run rm "$DST"
  else
    run rm -rf "$DST"
  fi
  log "已清理 $DST"
  exit 0
fi

# ── 已就绪检查 ──────────────────────────────────────────────────────────────
if [ -f "$DST/index.js" ] && [ -f "$DST/package.json" ]; then
  ver=$(python3 -c "import json,sys; print(json.load(open('$DST/package.json'))['version'])" 2>/dev/null || echo "?")
  log "已就绪: $DST (zod $ver)"
  exit 0
fi

# ── 找本机已有 zod 4+ ──────────────────────────────────────────────────────
# 偏好顺序：
#   1) claude-projects/openclaw（本机已知稳定 zod 4.x）
#   2) ~/projects 下任何含 zod 4+ 的 node_modules
#   3) ~/文档 / ~/下载 下的 zod 4+
#   4) warn 并退出 1
find_local_zod() {
  local roots=(
    "$HOME/文档/claude-projects/openclaw/node_modules/zod"
    "$HOME/projects/Metaversefans/metaverse-fans-web/node_modules/zod"
  )
  for src in "${roots[@]}"; do
    if [ -f "$src/package.json" ] && [ -f "$src/index.js" ]; then
      local v
      v=$(python3 -c "import json; print(json.load(open('$src/package.json'))['version'])" 2>/dev/null || echo "0")
      local major="${v%%.*}"
      if [ "$major" = "4" ] || [ "$major" = "3" ]; then
        echo "$src"; return 0
      fi
    fi
  done
  local found
  found=$(find "$HOME/文档" "$HOME/projects" "$HOME/下载" \
    -path "*/node_modules/zod/package.json" 2>/dev/null \
    | while read pj; do
        v=$(python3 -c "import json; print(json.load(open('$pj'))['version'])" 2>/dev/null)
        case "$v" in 4.*|3.*) echo "$(dirname "$pj")" && break ;; esac
      done | head -1)
  if [ -n "$found" ] && [ -d "$found" ]; then
    echo "$found"; return 0
  fi
  return 1
}

SRC="$(find_local_zod || true)"
if [ -z "$SRC" ]; then
  cat >&2 <<'MSG'
[zod-bootstrap] ✗ 本机没找到可用的 zod (v3+/v4+)。

修复方式（任选一）：
  1. AGINT_HOME 之外的任意项目跑一次 npm install zod@^4，bootstrap 下次会自动复用
  2. 手动放置：
       mkdir -p ~/.dsh/profiles/web/plugins/agint-quality/node_modules
       cd /tmp && npm pack zod@^4
       tar -xzf zod-*.tgz -C ~/.dsh/profiles/web/plugins/agint-quality/node_modules/
       mv ~/.dsh/profiles/web/plugins/agint-quality/node_modules/package \
          ~/.dsh/profiles/web/plugins/agint-quality/node_modules/zod

为何不自动 npm install：dsh plugin 目录的 package.json 是 sparse
（只有 peerDependencies，无 dependencies），npm 10 在这种场景下
arborist reify 会直接 crash（Cannot read properties of undefined reading 'spec'），
强行跑 install 会留下半截 node_modules 让下次更难诊断。
MSG
  exit 1
fi

# ── 放置 ────────────────────────────────────────────────────────────────────
src_ver=$(python3 -c "import json; print(json.load(open('$SRC/package.json'))['version'])")
log "复用本地 zod $src_ver from $SRC"

run mkdir -p "$DST_PARENT"
if [ -e "$DST" ]; then
  die "$DST 已存在但不是合法 zod 目录（可能是历史残留或别的东西），拒绝覆盖。请人工检查。"
fi
run cp -r "$SRC" "$DST"

if [ "$DRY_RUN" != "1" ]; then
  if [ -f "$DST/index.js" ]; then
    log "✓ $DST/index.js 就绪（zod $src_ver）"
    exit 0
  else
    die "cp 失败：$DST/index.js 不存在"
  fi
fi
exit 0
