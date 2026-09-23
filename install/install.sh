#!/usr/bin/env bash
# AGINT 安装脚本（v0.2 — 安全左移版）
#
# 把 AGINT 仓库内容铺到 $DSH_HOME，对应 preset / bundle-plugin / bundle-patch
# 三个注入点（外加一处兼容镜像位）。
#
# ## 交付形态（2026-09-24 起）
#   $DSH_HOME/.agent-presets/<id>/                      ← 三条 preset 的定义文件
#   $DSH_HOME/.agent-presets/node_modules               ← preset 裸包名解析入口
#   $DSH_HOME/profiles/web/node_modules/@agint/host/    ← the bundle（主载体）
#        ├── cordis.patch.yml   挂载行（insert 行 name 相对本目录解析）
#        ├── package.json       dsh.bundle.patch 声明
#        ├── plugins/           agint-* 插件
#        └── node_modules/@deepseek-ai  官方包解析入口
#   $DSH_HOME/profiles/web/plugins/                     ← 兼容镜像位（AGINT 自身代码按此路径找插件）
#   $DSH_HOME/profiles/web/cordis.patch.yml             ← ⛔ 只读：AGINT 不再写它（写了 = 双重挂载）
# 幂等：已存在则备份 + 同步，不破坏用户已有内容（非 agint-* 段原样保留）。
#
# ## 安全设计（§5.2 安全左移 + docs/security-boundary.md）
#   1. 前置：跑 install/agint-security-checks.sh，任意 fail → 退出
#   2. 复制：优先 rsync（--no-links + exclude 列表），无 rsync 时回退 python3
#      copytree，两者都禁止跟随 symlink（AGINT 仓内 node_modules 全是
#      symlink，会污染 $DSH_HOME 树）。实现见 safe_rsync()
#   3. 备份：中央目录 $DSH_HOME/.agint-backups/，保留最近 10 个，超限删最老
#   4. 回滚：trap EXIT 跟踪 partial install 状态；失败时还原
#   5. 装后：静态校验（YAML 解析 / package.json 存在 / preset cordis.yml 存在）
#
# ## 参数
#   --dry-run  只打印会改什么，不写任何文件
#   --force    跳过 AGINT_HOME 是否为 git 仓的检查（用于 CI）
#   --no-check 跳过 agint-security-checks.sh 前置检查（仅 dev 用）
#   -h|--help  帮助
#
# ## 备份与回滚
#   备份目录：$DSH_HOME/.agint-backups/agint-{presets,plugins,patch}-TS.tar.gz
#   uninstall.sh 支持从备份列表选一个回滚
#
# ## 已知限制
#   - bundle patch 是**整份复制**（不再与 profile 级 patch 做段合并）；
#     python3 仍用于：残留段检测 + 装后 YAML 语法校验
#   - 无 rsync 环境（Windows）走 python3 回退：--delete 语义靠 stage+换入实现，
#     换入前 dst 的旧内容仍在盘上，异常中断时可从 $DSH_HOME/.agint-backups 恢复

set -uo pipefail  # 注意：不加 -e，因为我们要收集失败后 trap 回滚

# ── 参数 ────────────────────────────────────────────────────────────────────
DRY_RUN=0
FORCE=0
SKIP_CHECK=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --force)    FORCE=1 ;;
    --no-check) SKIP_CHECK=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "[AGINT] ✗ 未知参数: $arg" >&2
      exit 2
      ;;
  esac
done

# ── 路径 ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGINT_HOME="${AGINT_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# realpath 校验一次（防 symlink 逃逸）
if command -v realpath >/dev/null 2>&1; then
  AGINT_HOME="$(realpath "$AGINT_HOME")"
  DSH_HOME="$(realpath -m "$DSH_HOME")"
fi

# 拒绝路径含 ..
for v in AGINT_HOME DSH_HOME; do
  case "${!v}" in
    *..*)
      echo "[AGINT] ✗ $v 含 '..'：${!v}（拒绝以防路径遍历）" >&2
      exit 1
      ;;
  esac
done

# ── MSYS → Windows 路径转换 ──────────────────────────────────────────────────
# Git Bash 下 $AGINT_HOME 形如 /d/DSH/project/DSH-AGINT（MSYS 路径）。
# 这个路径 bash 内部能用，但传给 **Windows 原生** 解释器（本机的 python3.exe）
# 会被当成不存在的相对路径——典型症状是 python 报 FileNotFoundError，
# 而同一个文件 ls 明明存在。node 也是同理（见 2026-09-03 笔记）。
#
# 不做平台硬编码猜测，直接拿 SCRIPT_DIR 探一次：python 认得就用原样，
# 认不得就判定为「需要 Windows 路径」，后续统一过 cygpath -w。
PYTHON_NEEDS_WINPATH=0
if command -v cygpath >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  if ! python3 -c 'import os,sys; sys.exit(0 if os.path.isdir(sys.argv[1]) else 1)' \
      "$SCRIPT_DIR" 2>/dev/null; then
    PYTHON_NEEDS_WINPATH=1
  fi
fi

# winpath <path> → 按探测结果决定是否转成 Windows 形式
#
# 用 `cygpath -m`（输出 C:/Users/... 正斜杠）而不是 `-w`（输出 C:\Users\...）。
# 区别很要命：-w 的反斜杠一旦被嵌进 Python 字符串字面量，`\U` / `\x` 就会被
# 当成 Unicode / 十六进制转义，路径当场变形（Windows 上 \Users 是必踩的）。
# -m 的正斜杠在 argv 和字符串字面量里都安全，Windows 版 python/node 都认。
winpath() {
  if [ "$PYTHON_NEEDS_WINPATH" = "1" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

PRESETS_SRC="$AGINT_HOME/presets"
PLUGINS_SRC="$AGINT_HOME/plugins"

# ── 2026-09-24：AGINT 改以 dsh **bundle** 形态交付 ──────────────────────────
# 挂载层 = 仓库根 cordis.patch.yml（package.json 里 dsh.bundle.patch 指向它）
# 插件   = 仓库根 plugins/
# 部署位 = $DSH_HOME/profiles/web/node_modules/@agint/host/
# profile-patches/web/cordis.patch.yml 已**不再写入** profile 级 patch，
# 仅保留为「卸载时的 id 清单源」（uninstall.sh 依赖它）。
BUNDLE_PATCH_SRC="$AGINT_HOME/cordis.patch.yml"
BUNDLE_MANIFEST_SRC="$AGINT_HOME/package.json"
PATCH_SRC="$AGINT_HOME/profile-patches/web/cordis.patch.yml"

BUNDLE_NAME="@agint/host"
BUNDLE_DST="$DSH_HOME/profiles/web/node_modules/$BUNDLE_NAME"
BUNDLE_PLUGINS_DST="$BUNDLE_DST/plugins"
BUNDLE_PATCH_DST="$BUNDLE_DST/cordis.patch.yml"
BUNDLE_MANIFEST_DST="$BUNDLE_DST/package.json"

PRESETS_DST="$DSH_HOME/.agent-presets"
# 兼容位（与 bundle 同源、同一次 sync）：AGINT 自身代码（agint-dream/lib/
# quality-bridge.js）与三条 preset 的 tools 行按 <此路径>/<plugin-id> 定位插件。
PLUGINS_DST="$DSH_HOME/profiles/web/plugins"
# 只读：用于「AGINT 挂载段残留」检测，不再由本脚本写入
PROFILE_PATCH_DST="$DSH_HOME/profiles/web/cordis.patch.yml"

BACKUP_DIR="$DSH_HOME/.agint-backups"
BACKUP_KEEP=10

# ── 日志 ────────────────────────────────────────────────────────────────────
log() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY]   $*"
  else
    echo "[AGINT] $*"
  fi
}
warn() { echo "[AGINT] ⚠ $*" >&2; }
die()  { echo "[AGINT] ✗ $*" >&2; exit 1; }

log "AGINT_HOME = $AGINT_HOME"
log "DSH_HOME   = $DSH_HOME"
log ""

# ── 前置安全检查 ────────────────────────────────────────────────────────────
if [ "$SKIP_CHECK" != "1" ]; then
  log "0/4 运行安全检查（install/agint-security-checks.sh）"
  if ! AGINT_HOME="$AGINT_HOME" DSH_HOME="$DSH_HOME" bash "$SCRIPT_DIR/agint-security-checks.sh"; then
    die "安全检查失败，加 --no-check 跳过（仅 dev 用）"
  fi
  log ""
fi

# ── 前置业务检查 ────────────────────────────────────────────────────────────
[ -d "$PRESETS_SRC" ] || die "presets 源缺失: $PRESETS_SRC"
[ -d "$PLUGINS_SRC" ] || die "plugins 源缺失: $PLUGINS_SRC"
[ -f "$BUNDLE_PATCH_SRC" ]    || die "bundle patch 源缺失: $BUNDLE_PATCH_SRC"
[ -f "$BUNDLE_MANIFEST_SRC" ] || die "bundle 清单源缺失: $BUNDLE_MANIFEST_SRC"
[ -f "$PATCH_SRC" ]   || die "patch 源缺失（卸载 id 清单仍依赖它）: $PATCH_SRC"
[ -d "$DSH_HOME" ]    || die "$DSH_HOME 不存在，请先跑 'dsh web' 初始化 dsh"

if [ "$FORCE" != "1" ] && [ ! -d "$AGINT_HOME/.git" ]; then
  die "AGINT_HOME 不是 git 仓库（$AGINT_HOME），加 --force 跳过"
fi

# rsync 不再是硬依赖：macOS/Linux 有则优先用（增量快），
# Windows / 精简容器没有 rsync 时回退到 python3 同步（见 safe_rsync 的 fallback 分支）。
command -v python3 >/dev/null 2>&1 || die "需要 python3（patch 合并 + 无 rsync 时的文件同步用）"

# ── partial-install 跟踪 + EXIT trap ────────────────────────────────────────
# 任何 step 标 "done=1" 后失败，trap 会按顺序 reverse 回滚。
PARTIAL_STEPS=()  # 每个元素："<reverse_action>|<args>"
register_step() {
  # register_step "<reverse_action>|<args...>"
  PARTIAL_STEPS+=("$1")
}

rollback() {
  local rc=$?
  if [ "${#PARTIAL_STEPS[@]}" -eq 0 ] || [ "$DRY_RUN" = "1" ]; then
    return
  fi
  warn "安装失败，开始回滚 (rc=$rc)..."
  # reverse 顺序执行回滚
  for ((i=${#PARTIAL_STEPS[@]}-1; i>=0; i--)); do
    local step="${PARTIAL_STEPS[$i]}"
    IFS='|' read -r action args <<< "$step"
    case "$action" in
      rm_dst)
        if [ -e "$args" ]; then rm -rf "$args" && warn "  ✓ 已删除: $args"; fi
        ;;
      restore_backup)
        if [ -e "$args.bak-current" ]; then
          rm -rf "$args" && mv "$args.bak-current" "$args" && warn "  ✓ 已恢复: $args"
        fi
        ;;
    esac
  done
}
trap rollback EXIT

# ── 备份函数：中央备份目录 + 数量上限 ────────────────────────────────────────
ensure_backup_dir() {
  if [ "$DRY_RUN" = "1" ]; then
    log "   备份目录 (dry): $BACKUP_DIR"
    return
  fi
  mkdir -p "$BACKUP_DIR"
}

backup() {
  # backup <component-name> <target-path>
  # - 在 $BACKUP_DIR 建 tar.gz（含 target 当时完整快照）
  # - 注册回滚步骤：rm_dst 删掉新装的，回滚到 tar 内容
  local component="$1"
  local target="$2"
  if [ ! -e "$target" ]; then
    log "   备份跳过: $target 不存在（首次安装）"
    return
  fi
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local archive="$BACKUP_DIR/agint-${component}-${ts}.tar.gz"
  if [ "$DRY_RUN" = "1" ]; then
    log "   备份 (dry): $target → $archive"
    return
  fi
  # 把 target 父目录 + basename 一起打包，便于精确还原路径
  local parent
  parent="$(dirname "$target")"
  local base
  base="$(basename "$target")"
  (cd "$parent" && tar -czf "$archive" "$base") || die "备份失败: $target → $archive"
  log "   备份: $target → $archive"

  # 注册回滚：从 target 删除 + 把 archive 解到原位
  register_step "restore_backup|$target"

  # 数量上限：保留最近 BACKUP_KEEP 个对应 component 备份，超限删最老
  prune_old_backups "$component"
}

prune_old_backups() {
  # prune_old_backups <component>
  local component="$1"
  if [ "$DRY_RUN" = "1" ]; then return; fi
  # 列所有匹配 component 的备份，按 mtime 倒序，删超出 KEEP 的
  local files=()
  while IFS= read -r f; do
    [ -n "$f" ] && files+=("$f")
  done < <(find "$BACKUP_DIR" -maxdepth 1 -name "agint-${component}-*.tar.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  local n="${#files[@]}"
  if [ "$n" -gt "$BACKUP_KEEP" ]; then
    for ((i=BACKUP_KEEP; i<n; i++)); do
      rm -f "${files[$i]}" && log "   旧备份清理: ${files[$i]}"
    done
  fi
}

# ── 复制函数：rsync + --no-links + exclude ──────────────────────────────────
safe_rsync() {
  # safe_rsync <src_dir> <dst_dir>
  #
  # 语义等价于 `rsync -a --no-links --delete`：
  #   - -a        ：保留权限/时间戳（两个后端都保留 mtime+mode）
  #   - --no-links：软链整个跳过，不复制也不跟随
  #                 （AGINT 仓内 node_modules 全是软链，跟过去会污染 $DSH_HOME 树）
  #   - --delete  ：dst 完全镜像 src（src 里没有的，dst 里删掉）
  #
  # 后端选择：
  #   1) rsync 存在 → 用 rsync（macOS 自带 / Linux 常见，增量快）
  #   2) 否则       → python3 shutil.copytree（Windows 兜底）
  #      --delete 语义用「先 stage 到 dst.tmp，整体成功后换入」实现，
  #      比逐项 diff 更可靠，也顺带保证了换入的原子性。
  if [ "$DRY_RUN" = "1" ]; then
    log "   sync (dry): $1/ → $2/"
    return
  fi
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --no-links --delete \
      --exclude='.git/' \
      --exclude='.git' \
      --exclude='node_modules/' \
      --exclude='node_modules' \
      --exclude='eval/node_modules/' \
      --exclude='*.bak-*' \
      --exclude='*.bundle' \
      "$1/" "$2/" \
      || die "rsync 失败: $1 → $2"
  else
    python3 - "$(winpath "$1")" "$(winpath "$2")" <<'PY' || die "python 同步失败: $1 → $2"
import os, sys, shutil, fnmatch

src, dst = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])

# 与上面 rsync 分支的 --exclude 列表保持一致（排除表有两个副本，改一处要改两处）
EXCLUDE_NAMES  = {'.git', 'node_modules'}
EXCLUDE_GLOBS  = ('*.bundle', '*.bak-*')

def ignore(path, names):
    drop = set()
    for n in names:
        if n in EXCLUDE_NAMES:                                  drop.add(n)
        elif any(fnmatch.fnmatch(n, g) for g in EXCLUDE_GLOBS):  drop.add(n)
        # --no-links：软链整个跳过（目录软链尤其危险，会整棵跟过去）
        elif os.path.islink(os.path.join(path, n)):              drop.add(n)
    return drop

tmp = dst + '.tmp'
if os.path.exists(tmp):
    shutil.rmtree(tmp)
os.makedirs(tmp)
shutil.copytree(src, tmp, ignore=ignore, dirs_exist_ok=True)

# 兜底清扫：copytree 的 ignore 已挡掉绝大多数软链，这里再扫一遍确保零残留
for root, dirnames, filenames in os.walk(tmp):
    for n in list(dirnames) + filenames:
        p = os.path.join(root, n)
        if os.path.islink(p):
            os.unlink(p)

# --delete 语义：stage 成功后整体换入
if os.path.exists(dst):
    shutil.rmtree(dst)
os.rename(tmp, dst)
PY
  fi
}

# ── 0.5 确保中央备份目录存在 ─────────────────────────────────────────────────
# backup() 里 tar -czf 打开的是 $BACKUP_DIR 下的文件，目录不存在会直接
# "Cannot open: No such file or directory"。首次安装时它还没建，必须先建出来。
ensure_backup_dir

# ── 1. 安装 presets ─────────────────────────────────────────────────────────
log "1/4 同步 presets → $PRESETS_DST"
mkdir -p "$PRESETS_DST"
for src in "$PRESETS_SRC"/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  dst="$PRESETS_DST/$name"
  backup "presets" "$dst"
  safe_rsync "$src" "$dst"
  if [ "$DRY_RUN" != "1" ]; then register_step "rm_dst|$dst"; fi
  log "   ✓ $name"
done

# ── 1.1 preset 依赖解析入口（dsh ≥ 0.1.7 必需）────────────────────────────────
#
# 0.1.7 起 preset 不再靠「扫 .agent-presets/ 目录」发现，必须在 composition 里声明。
# 我们用 `cordis:include` 复用 .agent-presets/<id>/agent.cordis.yml（保持单一事实源）。
#
# ⚠ 代价（2026-09-23 影子环境实测）：include 会把子条目的 baseUrl 设成「被读文件
#   所在目录」= .agent-presets/<id>/，于是 preset 里所有**裸包名**
#   （@deepseek-ai/dsh-persona / dsh-tool-fs / dsh-tool-web …）都从该目录向上解析，
#   而它天然没有 node_modules ⇒ 官方插件行全部 `never started` ⇒ registry 判定
#   broken ⇒ **UI 只显示「加载失败」，真实原因不落日志**（agint 实测 23 条）。
#
# 修法：在 presets **父目录**放一个解析入口 → dsh 安装目录的 node_modules（那里有
#   276 个包，含全部官方 preset 依赖）。子目录向上第一级就命中。
#   ⛔ 不能放进 .agent-presets/<id>/ 里 —— 步骤 1 的 safe_rsync 带 --delete，
#      下次重装会把 preset 目录整个镜像一遍，入口当场消失（症状复活）。
#
# 失败只 warn 不阻断：dsh < 0.1.7 压根不注册 preset，缺它无影响；
# 手工补一条 `mklink /J` 即可恢复。
ensure_preset_module_entry() {
  local link="$PRESETS_DST/node_modules" target
  if [ -d "$link" ]; then
    log "   ✓ preset 解析入口已存在（$link）"
    return 0
  fi
  target="$(npm root -g 2>/dev/null)/@deepseek-ai/dsh/node_modules"
  if [ -z "$target" ] || [ ! -d "$target" ]; then
    warn "未能定位 dsh 的 node_modules（npm root -g 不可用？），跳过 preset 解析入口。"
    warn "  dsh ≥ 0.1.7 上智进 preset 会显示「加载失败」。手工补："
    warn "    mklink /J \"$link\" \"<npm root -g>\\@deepseek-ai\\dsh\\node_modules\""
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "   [DRY] 建 preset 解析入口 $link → $target"
    return 0
  fi
  if command -v cmd >/dev/null 2>&1; then
    # Windows：junction（普通权限可建，symlink 需要管理员/开发者模式）
    local wl wt
    wl="$(cygpath -w "$link" 2>/dev/null || printf '%s' "$link")"
    wt="$(cygpath -w "$target" 2>/dev/null || printf '%s' "$target")"
    if cmd //c "mklink /J \"$wl\" \"$wt\"" >/dev/null 2>&1; then
      log "   ✓ preset 解析入口已建立（junction）"
      return 0
    fi
  fi
  if ln -s "$target" "$link" 2>/dev/null; then
    log "   ✓ preset 解析入口已建立（symlink）"
    return 0
  fi
  warn "preset 解析入口创建失败（$link → $target）。dsh ≥ 0.1.7 上智进会显示「加载失败」。"
}
ensure_preset_module_entry

# ── 1.2 bundle 内解析入口（bundle 形态必需）──────────────────────────────────
#
# bundle 里的插件用**裸包名** import 官方包（@deepseek-ai/dsh-storage-domain /
# dsh-tools / dsh-cordis …）。bundle 包自己不带依赖（刻意不写 dependencies，
# 避免 pnpm 去 registry 找 @agint/host），所以必须在包内给一条解析入口。
#
# 修法：<bundle>/node_modules/@deepseek-ai → dsh 安装目录的 node_modules/@deepseek-ai
#   （266+ 个官方包）。⛔ 必须链在**包内**：profile 层的 node_modules 不参与包内解析。
#   与 preset 入口同一个坑：safe_rsync 排除 node_modules，否则下次 sync 被删。
#
# 失败只 warn 不阻断：真正的后果是 bundle 层被 dsh 跳过
# （stderr 打 `skipping profile bundle "@agint/host"`），届时按上面提示手工补链。
ensure_bundle_module_entry() {
  local link="$BUNDLE_DST/node_modules/@deepseek-ai" target
  if [ -d "$link" ]; then
    log "   ✓ bundle 解析入口已存在（$link）"
    return 0
  fi
  target="$(npm root -g 2>/dev/null)/@deepseek-ai/dsh/node_modules/@deepseek-ai"
  if [ -z "$target" ] || [ ! -d "$target" ]; then
    warn "未能定位 dsh 的 node_modules（npm root -g 不可用？），跳过 bundle 解析入口。"
    warn "  bundle 插件的官方包 import 会失败。手工补："
    warn "    mklink /J \"$BUNDLE_DST\\node_modules\\@deepseek-ai\" \"<npm root -g>\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\""
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "   [DRY] 建 bundle 解析入口 $link → $target"
    return 0
  fi
  mkdir -p "$BUNDLE_DST/node_modules"
  if command -v cmd >/dev/null 2>&1; then
    local wl wt
    wl="$(cygpath -w "$link" 2>/dev/null || printf '%s' "$link")"
    wt="$(cygpath -w "$target" 2>/dev/null || printf '%s' "$target")"
    if cmd //c "mklink /J \"$wl\" \"$wt\"" >/dev/null 2>&1; then
      log "   ✓ bundle 解析入口已建立（junction）"
      return 0
    fi
  fi
  if ln -s "$target" "$link" 2>/dev/null; then
    log "   ✓ bundle 解析入口已建立（symlink）"
    return 0
  fi
  warn "bundle 解析入口创建失败（$link → $target）。"
}
ensure_bundle_module_entry

# ── 1.5 zod bootstrap（必须在 plugin 同步之前）───────────────────────────────
# 见 install/agint-zod-bootstrap.sh。
# 顺序约束：步骤 2 用 safe_rsync --delete 把 plugins/agint-quality/node_modules/zod
# 清掉（仓源没有），所以 zod 必须先放进 host，再让 plugin 同步覆盖。
# 失败仅 warn，不阻断（用户可手动跑）。
# 同时在 4.5 段保留一份兜底（理论上不会再跑，但万一 bootstrap 失败，
# 后面 2/4 plugin 同步不会自愈——4.5 段的存在确保下一个 stage 还能补救）。
if [ "$DRY_RUN" != "1" ]; then
  if bash "$SCRIPT_DIR/agint-zod-bootstrap.sh" >/dev/null 2>&1; then
    log "   ✓ zod bootstrap OK（pre-plugin）"
  else
    warn "zod bootstrap 失败（agint-quality-* plugin 启动时会找不到 zod）。手动跑：bash $SCRIPT_DIR/agint-zod-bootstrap.sh"
  fi
else
  log "   ⊘ 跳过 zod bootstrap（dry-run）"
fi

# ── 2. 安装 plugins ─────────────────────────────────────────────────────────
log "2/4 同步 plugins → $PLUGINS_DST"
mkdir -p "$PLUGINS_DST"
for src in "$PLUGINS_SRC"/agint-*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  dst="$PLUGINS_DST/$name"
  backup "plugins" "$dst"
  safe_rsync "$src" "$dst"
  if [ "$DRY_RUN" != "1" ]; then register_step "rm_dst|$dst"; fi
  log "   ✓ $name"
done

# ── 2.5 镜像到 bundle 部署位（dsh bundle 形态的主挂载源）─────────────────────
# 为什么同一份源铺两处：
#   · bundle patch 的 insert 行按「本 patch 文件所在目录」解析（app-boot
#     anchorInsertedPluginNames）⇒ 插件必须在 <bundle>/plugins/ 下；
#   · 而 AGINT 自身代码按老路径定位插件（agint-dream/lib/quality-bridge.js 用
#     $DSH_HOME/profiles/web/plugins/<id>），三条 preset 的 tools 行同理 ⇒ 保留兼容位。
#   两处同源、同一次 sync，天然一致，不引入漂移。
log "2.5/4 镜像到 bundle → $BUNDLE_PLUGINS_DST"
mkdir -p "$BUNDLE_DST"
for src in "$PLUGINS_SRC"/agint-*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  safe_rsync "$src" "$BUNDLE_PLUGINS_DST/$name"
  log "   ✓ $name"
done

# ── 3. 同步 bundle 挂载层（patch + 清单 + 解析入口）─────────────────────────
# 2026-09-24 起 AGINT 的挂载行住在 **bundle 层**，不再写 profile 级 patch：
# 官方口径 profile 级 patch 优先级高于 bundle 层，两边都写 = 同一批 id 重复挂载。
log "3/4 同步 bundle 挂载层 → $BUNDLE_PATCH_DST"
mkdir -p "$BUNDLE_DST"
backup "patch" "$BUNDLE_PATCH_DST"
cp -f "$BUNDLE_PATCH_SRC"    "$BUNDLE_PATCH_DST"    || die "bundle patch 复制失败: $BUNDLE_PATCH_SRC"
cp -f "$BUNDLE_MANIFEST_SRC" "$BUNDLE_MANIFEST_DST" || die "bundle package.json 复制失败: $BUNDLE_MANIFEST_SRC"

# bundle 内解析入口：插件用裸包名 import 的官方包（@deepseek-ai/dsh-*）必须能在
# 包内解析到（zod 之外的全部）。链到 dsh 安装目录的 node_modules。
# ⛔ 必须链在包内，且 safe_rsync 排除 node_modules，否则下次 sync 被 --delete 删掉。
ensure_bundle_module_entry

# 残留检测：profile 级 patch 若还留着 agint-* 挂载段 → 会与 bundle 层重复挂载。
# 直接失败，不"打包带过"。
if [ -f "$PROFILE_PATCH_DST" ]; then
  python3 - "$(winpath "$PROFILE_PATCH_DST")" <<'PY' || die "profile 级 patch 仍含 AGINT 挂载段（会上双重挂载）。删掉该段后重跑；备份在 .agint-backups/"
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
hits = re.findall(r'^\s*- id:\s+(agint-[a-z0-9-]+)\s*$', text, re.M)
if hits:
    print(f"[AGINT]   ✗ profile 级 patch 残留 {len(hits)} 个 agint-* 挂载段（如 {', '.join(hits[:5])} ...）")
    sys.exit(1)
print("[AGINT]   ✓ profile 级 patch 无 AGINT 挂载段（只剩本机本地覆盖）")
PY
fi

if [ "$DRY_RUN" != "1" ]; then
  # 注册 patch 回滚：删当前 + 从 backup_dir 最新 patch 备份恢复
  register_step "restore_backup|$BUNDLE_PATCH_DST"
fi

# ── 4. 装后静态校验 ─────────────────────────────────────────────────────────
log "4/4 装后静态校验"
if [ "$DRY_RUN" = "1" ]; then
  log "   跳过（dry-run）"
else
  failed=0
  # 4a. bundle patch YAML 能被 python yaml.safe_load 解析（剥离 !!js 等自定义 tag 后）
  python3 - "$(winpath "$BUNDLE_PATCH_DST")" <<'PY' || failed=$((failed+1))
import sys, re
try:
    import yaml
except ImportError:
    print("[AGINT]   ⚠ python3-yaml 未装，跳过 patch YAML 校验（pip install pyyaml 可启用）")
    sys.exit(0)
text = open(sys.argv[1], encoding='utf-8').read()
# 剥离 dsh 自定义 tag（!!js 表达式：!!js expr 或 !!js/function ...），仅做语法检查
# dsh 实际写法两种：!!js (expr) 或 !!js/function ...；原 regex r"!!js/\w+" 不覆盖前者
stripped = re.sub(r"!!js(/\w+)?", "", text)
try:
    yaml.safe_load(stripped)
    print("[AGINT]   ✓ patch YAML 语法 OK")
except yaml.YAMLError as e:
    print(f"[AGINT]   ✗ patch YAML 语法错误: {e}")
    sys.exit(1)
PY

  # 4b. 每个 active plugin 含 package.json
  # glob 'agint-*' 会包含 '.bak-*' 历史备份目录和子模块目录（agint-quality-contract /
  # agint-quality-eval 等通过相对路径引用父模块，没有自己的 package.json）。
  # dsh loader 对缺 package.json 的 plugin 子模块用 MODULE_TYPELESS fallback 处理，
  # 不是 fatal 错——只 warn 不计入失败。备份目录直接跳过。
  for plugin in "$PLUGINS_DST"/agint-*; do
    [ -d "$plugin" ] || continue
    name="$(basename "$plugin")"
    # 跳过 .bak-* 历史备份
    case "$name" in
      *.bak-*) continue ;;
    esac
    if [ -f "$plugin/package.json" ]; then
      log "   ✓ plugin $name 有 package.json"
    else
      warn "plugin $name 缺 package.json（MODULE_TYPELESS 警告，dsh loader fallback，非 fatal）"
      # 不计入 failed：plugin 子模块（通过相对路径引用父模块）无需自己的 package.json
    fi
  done

  # 4b2. manifest.json 同步校验（evolve 提案 cbda60d3，2026-09-07 处理）
  # 背景：2026-09-04 sync 核对发现 host 端插件缺 manifest.json，plugin-check /
  # mountOrder 校验全失明。v0.2 的 safe_rsync 是整目录同步、本应带上 manifest，
  # 但 agint-event-bus 仍出现过 host manifest 停在旧版（08-29）的情况——
  # 说明只靠"同步应该会带上"不够，装后必须显式校验。
  # 规则：仓库有 manifest.json 的插件，host 必须存在且与仓库逐字节一致。
  for plugin in "$PLUGINS_SRC"/agint-*/; do
    [ -f "$plugin/manifest.json" ] || continue
    name="$(basename "$plugin")"
    host_m="$PLUGINS_DST/$name/manifest.json"
    if [ ! -f "$host_m" ]; then
      warn "plugin $name 仓库有 manifest.json 但 host 缺失（plugin-check 将失明）"
      failed=$((failed+1))
    elif ! cmp -s "$plugin/manifest.json" "$host_m"; then
      warn "plugin $name host manifest 与仓库不一致（疑似旧版残留）"
      failed=$((failed+1))
    fi
  done

  # 4c. 每个 active preset 含 agent.cordis.yml
  # 同 4b：排除 .bak-* 备份
  for preset in "$PRESETS_DST"/agint-*; do
    [ -d "$preset" ] || continue
    name="$(basename "$preset")"
    # 跳过 .bak-* 历史备份
    case "$name" in
      *.bak-*) continue ;;
    esac
    if [ -f "$preset/agent.cordis.yml" ]; then
      log "   ✓ preset $name 有 agent.cordis.yml"
    else
      warn "preset $name 缺 agent.cordis.yml"
      failed=$((failed+1))
    fi
  done

  if [ "$failed" -gt 0 ]; then
    die "装后校验失败 $failed 项（已自动回滚）"
  fi
fi

# ── 4.5 zod bootstrap 兜底（正常情况下已被 1.5 覆盖；保留以应对手动 rsync）────
# 主入口在 1.5 段（pre-plugin）。本段是冗余兜底，覆盖「步骤 2 同步 plugin 之后
# 有人手动跑了 rsync 清掉 node_modules」之类的边角场景。
# 见 install/agint-zod-bootstrap.sh。失败仅 warn，不阻断。
if [ "$DRY_RUN" != "1" ]; then
  if bash "$SCRIPT_DIR/agint-zod-bootstrap.sh" >/dev/null 2>&1; then
    log "   ✓ zod bootstrap OK（post-plugin 兜底）"
  else
    warn "zod bootstrap 失败（agint-quality-* plugin 启动时会找不到 zod）。手动跑：bash $SCRIPT_DIR/agint-zod-bootstrap.sh"
  fi
else
  log "   ⊘ 跳过 zod bootstrap（dry-run）"
fi

# ── 4.55 zstd bootstrap（修复 agint-dream sweep ENOENT）─────────────────────
# 背景：sweep.js 第 111 行用 `execFile('zstd', ...)` 读 session.jsonl.zstd。
# DSH 沙箱镜像（Debian / Ubuntu）按最小化原则装了 libzstd1 但跳过 zstd CLI
# （Priority: optional），sweep 每晚 ENOENT 静默失败（2026-09-12 教训）。
# 镜像层不主动装（保持精简），由本脚本在 install 阶段兜底。
# 失败仅 warn，不阻断（与 zod bootstrap 同策略）。
if [ "$DRY_RUN" != "1" ]; then
  if bash "$SCRIPT_DIR/agint-zstd-bootstrap.sh" >/dev/null 2>&1; then
    log "   ✓ zstd bootstrap OK"
  else
    warn "zstd bootstrap 失败（agint-dream nightly sweep 会 ENOENT）。手动跑：bash $SCRIPT_DIR/agint-zstd-bootstrap.sh"
  fi
else
  log "   ⊘ 跳过 zstd bootstrap（dry-run）"
fi

# ── 4.6 AGENTS.md 本机实况自动同步（evolve 提案 95d78c05 · 阶段 1）───────────
# 探测本机 host 实况（插件装载 / preset tool rows / skills / patch 段 / cron），
# 回写仓库 AGENTS.md 文末 sentinel 围栏块。失败仅 warn，不阻断安装。
if [ "$DRY_RUN" != "1" ]; then
  if command -v node >/dev/null 2>&1; then
    if node "$SCRIPT_DIR/../bin/agents-local-state.mjs"; then
      log "   ✓ AGENTS.md 本机实况已同步"
    else
      warn "AGENTS.md 本机实况同步失败（可手动跑：node bin/agents-local-state.mjs）"
    fi
  else
    warn "未找到 node，跳过 AGENTS.md 本机实况同步（手动：node bin/agents-local-state.mjs）"
  fi
else
  log "   ⊘ 跳过 AGENTS.md 本机实况同步（dry-run）"
fi

# 装成功 → 清空 partial-steps（trap 不再回滚）
PARTIAL_STEPS=()
trap - EXIT

# ── 4.7 防御性补装 dsh-workflow-worker-thread（AGINT evolve 提案上下文）────
# 历史：AGINT preset 历史上引用过 @deepseek-ai/dsh-workflow-worker-thread，
# 但该包是 dsh 0.0.1-rc.3 发布候选、dsh 官方不携带。2026-09-20 智进
# picker 显示 4 个 preset 全部「加载失败」，根因即此包未装。
# 修法（已落地于 presets/*.yml）：三处 preset 改用 dsh 默认的
# workflow-ptc（stable、dsh 官方 deps 携带），不再依赖 worker-thread。
# 本步骤作为防御性兜底：profile node_modules 中残留的孤儿 worker-thread
# 软链可能仍在，若未来 preset 临时回退或 fork 复制者引用旧版，
# 此处确保包就位。失败仅 warn，不阻断安装。
if [ "$DRY_RUN" != "1" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    if [ -d "$DSH_HOME/profiles" ] && [ -d "$DSH_HOME/profiles/node_modules" ]; then
      if pnpm add --silent --no-frozen-lockfile @deepseek-ai/dsh-workflow-worker-thread --dir "$DSH_HOME/profiles" 2>/dev/null; then
        log "   ✓ 防御性补装 dsh-workflow-worker-thread OK"
      else
        warn "防御性补装 dsh-workflow-worker-thread 失败（preset 已不依赖，可忽略）"
      fi
    else
      log "   ⊘ 跳过防御性补装（profiles/node_modules 不存在）"
    fi
  else
    warn "未找到 pnpm，跳过防御性补装（preset 已不依赖，可忽略）"
  fi
else
  log "   ⊘ 跳过防御性补装（dry-run）"
fi

log ""
log "✅ 安装完成"
log ""
log "下一步："
log "  1. 重启 dsh web（bundle 层与 profile 层都不热更新）："
log "       dsh web"
log "  2. 验证：dsh 启动 stderr 不应出现 'skipping profile bundle \"@agint/host\"'"
log "     （出现即 bundle 层被跳过，按上文提示补 node_modules 解析入口）"
log "  3. 在浏览器里新建会话，确认 agint preset 可选、工具齐全"
log ""
log "回滚方式："
log "  install/uninstall.sh                # 全量卸载"
log "  install/uninstall.sh --restore      # 从备份选一个回滚"
