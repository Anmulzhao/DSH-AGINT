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

# ── MSYS → Windows 路径转换 ──────────────────────────────────────────────────
# 与 install.sh 里同一个坑：Git Bash 的 $DSH_HOME 形如 /c/Users/...（MSYS 路径），
# bash 自己能读，但传给 Windows 原生 python3 会被当成不存在的相对路径，
# open() 直接 FileNotFoundError。本脚本所有 python3 读文件路径的调用都必须过
# 一次 winpath()，否则版本号会静默读成 "0"，zod 被误判为版本不符而跳过。
# 探测方式同 install.sh：拿 SCRIPT_DIR 试一次，python 认得就不转。
PYTHON_NEEDS_WINPATH=0
if command -v cygpath >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  if ! python3 -c 'import os,sys; sys.exit(0 if os.path.isdir(sys.argv[1]) else 1)' \
      "$SCRIPT_DIR" 2>/dev/null; then
    PYTHON_NEEDS_WINPATH=1
  fi
fi
# 用 `cygpath -m`（输出 C:/Users/...）而不是 `-w`（输出 C:\Users\...）：
# 本脚本把路径嵌进 Python 字符串字面量（open('...')），-w 的反斜杠会被 Python
# 当成转义符（\U / \x 尤其致命），路径当场变形。-m 的正斜杠两处都安全。
winpath() {
  if [ "$PYTHON_NEEDS_WINPATH" = "1" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

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
  ver=$(python3 -c "import json,sys; print(json.load(open('$(winpath "$DST/package.json")'))['version'])" 2>/dev/null || echo "?")
  log "已就绪: $DST (zod $ver)"
  exit 0
fi

# ── 找本机已有 zod 4+ ──────────────────────────────────────────────────────
# 偏好顺序：
#   1) $DSH_HOME/profiles/web/node_modules/zod  ← 首选，见下方说明
#   2) claude-projects/openclaw（本机已知稳定 zod 4.x）
#   3) ~/projects 下任何含 zod 4+ 的 node_modules
#   4) ~/文档 / ~/下载 下的 zod 4+
#   5) warn 并退出 1
#
# 为什么 1) 是首选：裸 `from 'zod'`（contract/eval/sandbox/report/policy 用）
# 本来就由 Node 向上查找到 profile 的 node_modules/zod。这里再放一份同源拷贝，
# 相对路径导入和裸导入命中的就是同一份 zod —— 不会出现两个 zod 实例，
# 从而避免跨实例的 instanceof / schema 校验诡异失败。
# 附带好处：这条路径跨平台恒成立，不像 2)~4) 依赖 macOS 的 ~/{文档,projects} 布局
# （Windows 上这些目录全不存在，导致 bootstrap 必然失败，见 2026-09-03）。
find_local_zod() {
  local roots=(
    "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/zod"
    "$HOME/文档/claude-projects/openclaw/node_modules/zod"
    "$HOME/projects/Metaversefans/metaverse-fans-web/node_modules/zod"
  )
  for src in "${roots[@]}"; do
    if [ -f "$src/package.json" ] && [ -f "$src/index.js" ]; then
      local v
      v=$(python3 -c "import json; print(json.load(open('$(winpath "$src/package.json")'))['version'])" 2>/dev/null || echo "0")
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
        v=$(python3 -c "import json; print(json.load(open('$(winpath "$pj")'))['version'])" 2>/dev/null)
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
src_ver=$(python3 -c "import json; print(json.load(open('$(winpath "$SRC/package.json")'))['version'])")
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
