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

# ⛔ 2026-09-28 修坑：某些 Git Bash 环境（如本机）预先导出 **反斜杠格式** 的
#   DSH_HOME（C:\Users\Administrator\.dsh）。bash 工具链大多容忍混合斜杠，但：
#   ① run() 的 eval 二次解析会把 \U \A \. 里的反斜杠当转义吃掉 → rm/cp 拿到
#      毁掉的路径，rm -f 还静默 exit 0（「已清理」假日志，实际没删）；
#   ② Windows python3 认 C:\ 但脚本侧配合复杂。
#   统一在入口处规范化成 C:/ 正斜杠格式：MSYS 工具链（cp/rm/ls/test）与
#   Windows python 全都认，且 cygpath -m 对已是 C:/ 的输入幂等。
#   Linux/macOS 无 cygpath，原样保留。
if command -v cygpath >/dev/null 2>&1; then
  DSH_HOME="$(cygpath -m "$DSH_HOME" 2>/dev/null || printf '%s' "$DSH_HOME")"
fi

# ── MSYS → Windows 路径转换 ──────────────────────────────────────────────────
# 与 install.sh 里同一个坑：Git Bash 的 $DSH_HOME 形如 /c/Users/...（MSYS 路径），
# bash 自己能读，但传给 Windows 原生 python3 会被当成不存在的相对路径，
# open() 直接 FileNotFoundError。本脚本所有 python3 读文件路径的调用都必须过
# 一次 winpath()，否则版本号会静默读成 "0"，zod 被误判为版本不符而跳过。
#
# ⛔ 2026-09-28 修坑：旧实现用「拿 SCRIPT_DIR 探测 python 认不认」来决定转不转，
#   但探测样本（D:/DSH/...，Windows python 认得）与实际查找路径（$HOME 派生的
#   /c/Users/...，Windows python 不认得）**路径风格不一致** ⇒ 探测得出「不用转」，
#   python3 读版本全部静默失败 ⇒ 本机明明有 zod 4.6.5 却误报「没找到」。
#   修法：删掉探测，cygpath 存在就**无条件**过 `cygpath -m` ——
#   它对 C:/、D:/ 格式输入幂等，对 /c/、/d/ 格式做转换，两个世界通吃；
#   Linux/macOS 没有 cygpath，走 fallback 原样输出（那边路径本来就认）。
# 用 `cygpath -m`（输出 C:/Users/...）而不是 `-w`（输出 C:\Users\...）：
# 本脚本把路径嵌进 Python 字符串字面量（open('...')），-w 的反斜杠会被 Python
# 当成转义符（\U / \x 尤其致命），路径当场变形。-m 的正斜杠两处都安全。
winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

# 2026-09-24 起 AGINT 以 bundle 形态交付 ⇒ zod 主位在 **bundle 包内**
# （bundle patch 的 insert 行相对 bundle 包根解析，插件已搬去那里）。
# 兼容位与主位同源再放一份：AGINT 自身代码与三条 preset 的 tools 行仍按
# $DSH_HOME/profiles/web/plugins/... 定位插件。
REL="agint-quality/node_modules/zod"
DST="$DSH_HOME/profiles/web/node_modules/@agint/host/plugins/$REL"
DST_PARENT="$(dirname "$DST")"
MIRROR="$DSH_HOME/profiles/web/plugins/$REL"
# 2026-10-01 新增第三位：bundle 自身的依赖根（<bundle>/node_modules/zod）。
#
# ⛔ 为什么必须有这一位：上面那两个位置**都只解决相对路径导入**
# （agint-quality-eval 用 `../../node_modules/zod/index.js` 借 zod）。
# 裸 `import { z } from 'zod'` 走的是 Node 的向上查找，而查找的祖先链取决于
# **bundle 实体装在哪**：
#   · 旧部署位 profiles/web/node_modules/@agint/host/ → 祖先链含
#     profiles/node_modules → 恰好命中那里的 zod（能用，但纯属位置巧合）；
#   · 新部署位 $DSH_HOME/.agint-bundle/ → 祖先链只有 .agint-bundle 与 .dsh，
#     **不含 profiles/** ⇒ 11 个插件（memory / dream / cron / metrics /
#     evolve / tool-stats / compress-guard / input-gateway / aesthetic-oracle /
#     family-panel）全部 ERR_MODULE_NOT_FOUND: Cannot find package 'zod'。
# <bundle>/node_modules 是这个包**自己的**依赖根，对插件而言恒为祖先，
# 与 bundle 装在哪、与 node_modules 那条软链都解耦。
BUNDLE_DEP_ROOT="$DSH_HOME/.agint-bundle/node_modules"
BUNDLE_ZOD="$BUNDLE_DEP_ROOT/zod"

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
  # ⛔ 2026-09-28 修坑：旧实现 `eval "$@"` 会把参数做**二次解析**——
  #   反斜杠格式的 Windows 路径（C:\Users\...）里的 \U \A \. 被当转义吃掉，
  #   rm/cp 拿到毁掉的路径；rm -f 对不存在路径静默 exit 0 ⇒ uninstall 假删
  #   （「已清理」日志照打，目标原封不动）。本脚本 run 的调用方全是
  #   简单命令（无管道/重定向/通配），`"$@"` 直接执行即可，不需要 eval。
  if [ "$DRY_RUN" = "1" ]; then echo "DRY: $*"; else "$@"; fi
}

# ── uninstall 路径 ───────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
  for d in "$DST" "$MIRROR" "$BUNDLE_ZOD"; do
    if [ ! -e "$d" ]; then
      log "no-op: $d 不存在"
      continue
    fi
    if [ -L "$d" ]; then
      run rm "$d"
    else
      run rm -rf "$d"
    fi
    log "已清理 $d"
  done
  exit 0
fi

# ── 已就绪检查（三个位都齐才算就绪）─────────────────────────────────────────
if [ -f "$DST/index.js" ] && [ -f "$DST/package.json" ] && [ -f "$MIRROR/index.js" ] && [ -f "$BUNDLE_ZOD/index.js" ]; then
  ver=$(python3 -c "import json,sys; print(json.load(open('$(winpath "$DST/package.json")'))['version'])" 2>/dev/null || echo "?")
  log "已就绪: $DST + 兼容位 + bundle 依赖根 (zod $ver)"
  exit 0
fi

# ── 找本机已有 zod 4+ ──────────────────────────────────────────────────────
# 偏好顺序：
#   1) $DSH_HOME/profiles/node_modules/zod      ← 首选：dsh 全局软链的目标
#      （profiles/node_modules 是 web/headless 共用的依赖池，多数 AGINT
#        部署里 dsh 安装时已经把它链到 /usr/lib/.../@deepseek-ai/dsh/node_modules/zod）
#   2) $DSH_HOME/profiles/web/node_modules/zod  ← 次选
#   3) claude-projects/openclaw（本机已知稳定 zod 4.x）
#   4) ~/projects 下任何含 zod 4+ 的 node_modules
#   5) ~/文档 / ~/下载 下的 zod 4+
#   6) warn 并退出 1
#
# 为什么 1) 是首选：裸 `from 'zod'`（contract/eval/sandbox/report/policy 用）
# 本来就由 Node 向上查找到 profile 的 node_modules/zod。这里再放一份同源拷贝，
# 相对路径导入和裸导入命中的就是同一份 zod —— 不会出现两个 zod 实例，
# 从而避免跨实例的 instanceof / schema 校验诡异失败。
# 附带好处：这条路径跨平台恒成立，不像 2)~4) 依赖 macOS 的 ~/{文档,projects} 布局
# （Windows 上这些目录全不存在，导致 bootstrap 必然失败，见 2026-09-03）。
find_local_zod() {
  local roots=(
    "${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/zod"
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
if [ -n "$SRC" ]; then
  # ⛔ 2026-09-28 修坑：首选源 $DSH_HOME/profiles/node_modules/zod 本机是个
  #   symlink（→ AppData 全局 npm 里 dsh 自带的 zod）。MSYS(Git Bash) 的
  #   `cp -r <symlink> <dst>` 会**静默什么都不复制且 exit 0**，症状是
  #   「脚本说复制成功、目标目录空」。cp 前先 readlink -f 解析到真实物理路径；
  #   不是 symlink 时 readlink -f 原样返回（Linux 也安全，macOS 老版无 -f 时
  #   fallback 原路径，行为同旧版）。
  local_src="$(readlink -f "$SRC" 2>/dev/null || printf '%s' "$SRC")"
  if [ -d "$local_src" ]; then SRC="$local_src"; fi
fi
if [ -z "$SRC" ]; then
  cat >&2 <<'MSG'
[zod-bootstrap] ✗ 本机没找到可用的 zod (v3+/v4+)。

修复方式（任选一）：
  1. AGINT_HOME 之外的任意项目跑一次 npm install zod@^4，bootstrap 下次会自动复用
  2. 手动放置（主位 = bundle 包内；兼容位同步放一份）：
       mkdir -p ~/.dsh/profiles/web/node_modules/@agint/host/plugins/agint-quality/node_modules
       cd /tmp && npm pack zod@^4
       tar -xzf zod-*.tgz -C ~/.dsh/profiles/web/node_modules/@agint/host/plugins/agint-quality/node_modules/
       mv ~/.dsh/profiles/web/node_modules/@agint/host/plugins/agint-quality/node_modules/package \
          ~/.dsh/profiles/web/node_modules/@agint/host/plugins/agint-quality/node_modules/zod

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

# ⛔ 2026-10-01 修坑：原实现对每个目标位只判 `[ -e "$d" ]` 就 die
# 「已存在但不是合法 zod 目录」。三个位里只要有一个已就绪、另一个还没有
# （部分就绪态，例如换过部署位、只补了 bundle 依赖根），重跑就必然卡死在这里
# —— 而它唯一的补救手段是人工删目录。改为**按内容判**：
#   已是合法 zod → 跳过；存在但不是 zod → 才拒绝。
# 「同一个 bundle 里出现两份不同版本的 zod」是真正要防的事，所以跳过时比版本。
place_zod() {
  local dst="$1" label="$2" want="$src_ver" have
  run mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ]; then
    if [ -f "$dst/index.js" ] && [ -f "$dst/package.json" ]; then
      have=$(python3 -c "import json; print(json.load(open('$(winpath "$dst/package.json")'))['version'])" 2>/dev/null || echo "?")
      if [ "$have" = "$want" ]; then
        log "↻ $label 已是 zod $have，跳过"
        return 0
      fi
      warn "$label 已有 zod $have（期望 $want）——两份 zod 实例可能导致跨实例校验失败，请人工确认"
      return 0
    fi
    die "$label 已存在但不是合法 zod 目录（$dst），拒绝覆盖。请人工检查。"
  fi
  run cp -r "$SRC" "$dst"
  log "✓ $label 就绪：$dst（zod $want）"
}

place_zod "$DST"        "主位（bundle 内 agint-quality，相对路径导入用）"
place_zod "$MIRROR"     "兼容位（mirror，AGINT 自身代码 / preset tools 行用）"
place_zod "$BUNDLE_ZOD" "bundle 依赖根（裸 import 'zod' 唯一解析入口）"

if [ "$DRY_RUN" != "1" ]; then
  for d in "$DST" "$MIRROR" "$BUNDLE_ZOD"; do
    [ -f "$d/index.js" ] || die "放置失败：$d/index.js 不存在"
  done
  log "✓ 三位齐备（zod $src_ver）"
fi
exit 0
