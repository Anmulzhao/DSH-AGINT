#!/usr/bin/env bash
# AGINT 安装脚本（v0.2 — 安全左移版）
#
# 把 AGINT 仓库内容铺到 $DSH_HOME，对应 preset / bundle-plugin / bundle-patch
# 三个注入点（外加一处兼容镜像位）。
#
# ## 交付形态（2026-09-24 起）
#   $DSH_HOME/.agent-presets/<id>/                      ← 三条 preset 的定义文件
#   $DSH_HOME/.agent-presets/node_modules               ← preset 裸包名解析入口
#   $DSH_HOME/.agint-bundle/                            ← the bundle 的实体（主载体）
#        ├── cordis.patch.yml   挂载行（insert 行 name 相对本目录解析）
#        ├── package.json       dsh.bundle.patch 声明
#        ├── plugins/           agint-* 插件
#        └── node_modules/@deepseek-ai  官方包解析入口
#   $DSH_HOME/profiles/web/node_modules/@agint/host     ← 指向上面那个目录的 symlink
#   $DSH_HOME/profiles/web/plugins/                     ← 兼容镜像位（AGINT 自身代码按此路径找插件）
#   $DSH_HOME/profiles/web/cordis.patch.yml             ← ⛔ 只读：AGINT 不再写它（写了 = 双重挂载）
#
# ⛔ 为什么 bundle 实体不在 node_modules 里（2026-10-01 修，AGINT 自毁坑）：
#   dsh 的 plugin_manager 每次 install_bundle / remove_bundle 都会在 profile 目录
#   跑一次 `pnpm add|remove`，而 pnpm 会**剪掉 package.json 里没声明的包**。
#   AGINT 的 bundle 当初是 rsync 一整份目录到 profiles/web/node_modules/@agint/host/，
#   只在 dsh.profile.bundles 里注册、**没进 dependencies** ⇒ 任何一次插件热插拔
#   （包括 AGINT 自己用 plugin_manager 装东西）都会把整个 bundle 删掉，症状是
#   「AGINT 从 preset 列表里凭空消失、37 个插件全没了、host 一声不吭」。
#   修法：实体挪到 .agint-bundle/，node_modules/@agint/host 改成 symlink，并且把
#   "@agint/host": "link:<实体目录>" 写进 profile 的 dependencies —— pnpm 认账的
#   条目它不剪，dsh 的 createRequire 解析照旧穿过 symlink 找到 package.json。
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

# ⛔ 2026-09-29 修坑：python3 子进程 stdout 强制 UTF-8。
# 本脚本 4 处 python heredoc 的 print 里带 ✓ / ✗ / ↻ / ⚠ 等符号；中文 Windows 上
# python 的 stdout 编码是 GBK，打印 U+2713 直接抛 UnicodeEncodeError
# （'gbk' codec can't encode character '\u2713'），**非零退出**。
# 致命之处在于它伪装成业务故障：install.sh:560 的残留检测本来 hits=0（干净），
# 却在紧随其后的 print("✓ …") 上崩掉 → `|| die` 触发 → 报「profile 级 patch 仍含
# AGINT 挂载段」，把人引向完全错误的修复方向（去删本来正确的 profile patch）。
# 同一坑在 uninstall.sh 也中招：python 输出喂给 shell 变量时崩溃，会被管道吞掉
# 退出码，导致「静默跳过全部插件删除」。
# 这里用环境变量而非 sys.stdout.reconfigure()：不依赖 Python 版本，且对
# `-c` 单行调用与 heredoc 块一视同仁。
export PYTHONIOENCODING=utf-8

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
# 部署位 = $DSH_HOME/.agint-bundle/（实体）+ profiles/web/node_modules/@agint/host
#         （symlink，且必须在 profile 的 dependencies 里声明，见文件头）
# profile-patches/web/cordis.patch.yml 已**不再写入** profile 级 patch，
# 仅保留为「卸载时的 id 清单源」（uninstall.sh 依赖它）。
BUNDLE_PATCH_SRC="$AGINT_HOME/cordis.patch.yml"
BUNDLE_MANIFEST_SRC="$AGINT_HOME/package.json"
PATCH_SRC="$AGINT_HOME/profile-patches/web/cordis.patch.yml"

BUNDLE_NAME="@agint/host"
BUNDLE_DST="$DSH_HOME/.agint-bundle"
BUNDLE_PLUGINS_DST="$BUNDLE_DST/plugins"
BUNDLE_PATCH_DST="$BUNDLE_DST/cordis.patch.yml"
BUNDLE_MANIFEST_DST="$BUNDLE_DST/package.json"
# dsh 解析 bundle 只认这一个位置（app-boot resolveBundleDir → profile 目录下的
# node_modules/<name>）；实体放别处时，这里必须是指过去的 symlink。
BUNDLE_LINK="$DSH_HOME/profiles/web/node_modules/$BUNDLE_NAME"

# profile 清单：dsh.profile.bundles 的注册位。
# ⛔ 不注册 = bundle 目录与 patch 都在，但 dsh 根本不加载它，**零报错**（见步骤 3.5）
PROFILE_MANIFEST="$DSH_HOME/profiles/web/package.json"

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
  # ⛔ rc=0 = **正常跑完**，不是失败。`trap rollback EXIT` 在成功退出时同样触发 ——
  #    少了这一句守卫，安装成功的那一次会把刚铺好的 presets / plugins 全部删掉
  #    （2026-09-24 最小复现：脚本 rc=0 退出，却打印「安装失败，开始回滚 (rc=0)」并删目录）。
  if [ "$rc" -eq 0 ] || [ "${#PARTIAL_STEPS[@]}" -eq 0 ] || [ "$DRY_RUN" = "1" ]; then
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

# ── 成功收尾：清回滚标记 ────────────────────────────────────────────────────
# 安装正常跑完时调用：把 backup() 留下的 `<file>.bak-current` 清掉（否则安装位里
# 会残留一份旧内容副本），并清空回滚栈 —— rollback 另有 rc=0 守卫，这里是双保险。
commit_install() {
  [ "${#PARTIAL_STEPS[@]}" -gt 0 ] || return 0
  local step action target
  for step in "${PARTIAL_STEPS[@]}"; do
    IFS='|' read -r action target <<< "$step"
    if [ "$action" = "restore_backup" ] && [ -e "$target.bak-current" ]; then
      rm -f "$target.bak-current" && log "   清理回滚标记: $target.bak-current"
    fi
  done
  PARTIAL_STEPS=()
}

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
  # --force-local：Git Bash/MSYS 下 $archive 形如 C:/Users/...，GNU tar 会把
  #   「C:」误判为远程主机（报 "Cannot connect to C: resolve failed"）——
  #   该选项强制含冒号路径按本地文件处理；Linux 上无副作用（2026-09-28 实测坑）。
  (cd "$parent" && tar --force-local -czf "$archive" "$base") || die "备份失败: $target → $archive"
  log "   备份: $target → $archive"

  # 回滚标记：rollback 的 restore_backup 分支就是靠 `<target>.bak-current` 还原的
  # （tar 只作历史留档 / 人工恢复，路径带时间戳，回滚逻辑不解析它）。
  # ⚠️ 只对**文件**建标记：目录类（presets/<id>）的还原语义是 rm_dst「删掉新装的」，
  #    原内容在 tar 里；安装成功后由 commit_install 清掉这些标记。
  if [ -f "$target" ]; then
    cp -f "$target" "$target.bak-current" || die "写回滚标记失败: $target.bak-current"
  fi

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
os.makedirs(tmp, exist_ok=True)  # 同 rsync 分支：中间层缺失时 os.makedirs 负责补
shutil.copytree(src, tmp, ignore=ignore, dirs_exist_ok=True)

# 兜底清扫：copytree 的 ignore 已挡掉绝大多数软链，这里再扫一遍确保零残留
for root, dirnames, filenames in os.walk(tmp):
    for n in list(dirnames) + filenames:
        p = os.path.join(root, n)
        if os.path.islink(p):
            os.unlink(p)

# --delete 语义：stage 成功后整体换入。
# ⚠ dsh 运行时 chokidar 会锁 dst，rmtree 必 PermissionError(WinError 5)。
#   捕获后退化为「覆盖式同步」：只把 tmp 的文件写进 dst（dirs_exist_ok=True），
#   不删目录、不清旧实体。代价是 dst 内 src 已删除的文件会残留（--delete 语义丢失）——
#   这是「装不动」与「残留旧文件」之间的取舍，优先保证安装能完成。
mode = 'replace'
if os.path.exists(dst):
    try:
        shutil.rmtree(dst)
    except PermissionError as e:
        mode = 'overwrite'
        sys.stderr.write(f"WARN safe_rsync: dst 被占用（{e.__class__.__name__}），退化覆盖式同步（不删旧文件）: {dst}\n")

if mode == 'replace':
    os.rename(tmp, dst)
else:
    shutil.copytree(tmp, dst, ignore=ignore, dirs_exist_ok=True)
    # 覆盖式同样要挡软链：再扫一遍 dst，清掉跟进来的符号链接
    for root, dirnames, filenames in os.walk(dst):
        for n in list(dirnames) + filenames:
            p = os.path.join(root, n)
            if os.path.islink(p):
                try:
                    os.unlink(p)
                except OSError:
                    pass
    try:
        shutil.rmtree(tmp)
    except OSError:
        pass
PY
  fi
}

# ── 0.4 dsh 运行检测（信息性，不阻断）─────────────────────────────────────────
# dsh 在跑时 chokidar 会锁插件目录文件，令 rmtree 失败。真正的安全网是 safe_rsync
# 的覆盖式退化分支（见上）；本检测只负责「能认出来就提前提醒一声」，认不出也不误报。
# pgrep 在 Windows Git Bash 常缺失，缺失即静默跳过——不假装检测过。
detect_dsh_running() {
  command -v pgrep >/dev/null 2>&1 || return 0
  if pgrep -x dsh >/dev/null 2>&1 || pgrep -if 'dsh-app-boot|dsh/bin/dsh' >/dev/null 2>&1; then
    warn "检测到 dsh 进程疑似在运行。"
    warn "  建议先停 dsh 再装以避免文件锁；不停也行 —— safe_rsync 会自动退化为覆盖式同步。"
  fi
  return 0
}
detect_dsh_running

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

# ── 1.45 mirror 位解析卫兵（2026-10-06 dsh-tools stub 事故修）────────────────
#
# 兼容镜像位 $PLUGINS_DST 里的 AGINT 插件仍按**裸包名** import 官方包
# （@deepseek-ai/dsh-tools / cordis / dsh-storage-domain），解析走
# $PLUGINS_DST/node_modules/@deepseek-ai/<pkg>。
#
# ⛔ 2026-10-06 容器事故（gzsx dsh-agint）：该位置曾有一份手写的 0.0.0-stub
#   （defineTool 恒等函数 + main 指向 stub 的 index.js）→
#   valueSchemaSpecToJsonSchema 从不执行 → required 严格校验裸奔 →
#   agint preset 挂载必炸（25 插件 / 136 工具全灭）。
#   官方 npm tarball 从无顶层 index.js；stub 是部署调试期手工放入的
#   （物证：$DSH_HOME/.agint-backups/2026-10-06-dsh-tools-stub/stub-package/）。
#
# 本步保证：mirror 位这三个名字要么不存在、要么解析到 dsh 自带**真包**；
# 任何 0.0.0-stub 一律替换为指向真包的链接。幂等；失败仅 warn 不阻断。
# 与 1.1/1.2 同一坑族：safe_rsync 排除 node_modules ⇒ rsync 分支下本步产物
# 能活过步骤 2；python 回退分支（无 rsync）会整树换入删掉 ⇒ 4.6 有 post-plugin 复跑。
ensure_mirror_module_entry() {
  local base="$PLUGINS_DST/node_modules/@deepseek-ai" target name link
  target="$(npm root -g 2>/dev/null)/@deepseek-ai/dsh/node_modules/@deepseek-ai"
  # npm root -g 在部分环境指向错误前缀（10-06 容器实测：dsh 实际在 /usr/lib，
  # 悬空的 /usr/local/lib 链接即此问题产物）→ 多候选兜底，取真有 dsh-tools 的那个
  if [ -z "$target" ] || [ ! -d "$target/dsh-tools" ]; then
    local cand
    for cand in "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai" \
                "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"; do
      if [ -d "$cand/dsh-tools" ]; then target="$cand"; break; fi
    done
  fi
  if [ -z "$target" ] || [ ! -d "$target/dsh-tools" ]; then
    warn "未能定位 dsh 自带官方包（npm root -g 与常见前缀都没有），跳过 mirror 解析卫兵。"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "   [DRY] mirror 解析卫兵：$base → $target"
    return 0
  fi
  # 拓扑分派（2026-10-06 教训：scope 目录可能是 symlink，逐包操作会穿透到
  # dsh 自带树、搬走/覆盖真包 ⇒ symlink 拓扑下只允许整链级操作，禁逐包 rm/mv）
  if [ -L "$base" ]; then
    # 整 scope 已是链接：健康判定 = 解析后三入口都有真包 lib/index.js
    if [ -e "$base/dsh-tools/lib/index.js" ] && [ -e "$base/cordis/lib/index.js" ] \
       && [ -e "$base/dsh-storage-domain/lib/index.js" ]; then
      log "   ✓ mirror 位 @deepseek-ai 整链 → 真包树（$base）"
      return 0
    fi
    rm -f "$base"
    if ln -s "$target" "$base" 2>/dev/null; then
      log "   ✓ mirror 位 @deepseek-ai 链接已重指 → $target"
      return 0
    fi
    warn "mirror 位 @deepseek-ai 重指失败（$base → $target）。"
    return 0
  fi
  # 实体目录拓扑：逐包卫兵
  mkdir -p "$base"
  local rebuilt=0
  for name in dsh-tools cordis dsh-storage-domain; do
    link="$base/$name"
    # 已就绪判定：解析目标存在、有 lib/index.js、且不是 0.0.0-stub
    if [ -e "$link/lib/index.js" ] && ! grep -q '"0.0.0-stub"' "$link/package.json" 2>/dev/null; then
      continue
    fi
    if [ ! -d "$target/$name" ]; then
      warn "dsh 自带包里也没有 $name，mirror 位 $name 保持原样。"
      continue
    fi
    # 删除旧条目。⛔ 顺序敏感：Windows 上 junction 必须先走 cmd rmdir（只摘链
    #   不下钻）；rm -rf 对 MSYS 里的 junction 行为不可靠，误下钻会删掉真包
    #   （10-06 事故处理中「误删真包」的教训）。
    if [ -L "$link" ]; then
      rm -f "$link"
    elif [ -d "$link" ]; then
      if command -v cmd >/dev/null 2>&1; then
        cmd //c "rmdir /Q \"$(cygpath -w "$link" 2>/dev/null || printf '%s' "$link")\"" >/dev/null 2>&1 || true
      fi
      [ -e "$link" ] && rm -rf "$link"
    fi
    if command -v cmd >/dev/null 2>&1; then
      local wl wt
      wl="$(cygpath -w "$link" 2>/dev/null || printf '%s' "$link")"
      wt="$(cygpath -w "$target/$name" 2>/dev/null || printf '%s' "$target/$name")"
      if cmd //c "mklink /J \"$wl\" \"$wt\"" >/dev/null 2>&1; then
        log "   ✓ mirror 位 $name 已重建（junction → 真包）"
        rebuilt=$((rebuilt+1))
        continue
      fi
    fi
    if ln -s "$target/$name" "$link" 2>/dev/null; then
      log "   ✓ mirror 位 $name 已重建（symlink → 真包）"
      rebuilt=$((rebuilt+1))
    else
      warn "mirror 位 $name 重建失败（$link → $target/$name）。preset 挂载会报 required 校验错。"
    fi
  done
  # 全量清查：mirror 位不允许任何 0.0.0-stub 存活（防同一手法再放别的包）
  local stubbed
  stubbed="$(grep -l '"0.0.0-stub"' "$base"/*/package.json 2>/dev/null || true)"
  if [ -n "$stubbed" ]; then
    warn "mirror 位仍检出 0.0.0-stub 包（不在上述三名内，未自动替换，请人工核查）："
    warn "$stubbed"
  fi
  # 终态判定（诚实日志：重建 0 个 ≠ 三个都就绪，必须真验存在性）
  local ok=1 bad=""
  for name in dsh-tools cordis dsh-storage-domain; do
    [ -e "$base/$name/lib/index.js" ] || { ok=0; bad="$bad $name"; }
  done
  if [ "$ok" = 1 ]; then
    log "   ✓ mirror 位三入口均解析到真包（dsh-tools / cordis / dsh-storage-domain）"
  else
    warn "mirror 位以下入口未就绪（缺 lib/index.js）：$bad —— preset 挂载会报 required 校验错。"
  fi
}
ensure_mirror_module_entry

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
# ⛔ 必须建到 plugins 这一层：rsync 3.1.3 只建 dst 的最后一级，中间目录缺失就
#    `mkdir ... failed: No such file or directory (2)` + code 11（python3 后端
#    走 os.makedirs，会自动补中间层——两个后端在这里的行为不对称）。
mkdir -p "$BUNDLE_PLUGINS_DST"
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

# 3a. 抓取模板值与本机已存在的 override（**都必须在 cp 之前**）。
#     背景：cordis.patch.yml 是**两机共用的模板**。机器私有绝对路径按 AGENTS.md:16
#     红线不入库，早期靠「各机手改 $DSH_HOME 侧副本（HOME override）」解决；实测事故
#     （2026-10-04 20:30）：另一会话 deploy family-panel 0.2.3 时，下面这行 `cp -f`
#     把生效位整文件覆盖回模板值，麒麟机 override 被**静默**冲掉（事后生效位与仓库
#     模板 md5 完全相同）⇒ frozen-anchor 每日 10:30 重新硬失败。
#     现在模板改用 `!!js` 加载时求值（见仓库 cordis.patch.yml 两处 repoRoot），于是：
#       模板值是 `!!js…`  ⇒ **不保留**：表达式才是本机真值来源，强行保留会把
#                        旧字面量钉死、让 AGINT_REPO_ROOT 逃生口失效（本条即那次事故的
#                        同类隐患：机制被静默冻结）。
#       模板值是字面量    ⇒ 保留本机 override（老模板/未来新增的机器私有键仍受保护）。
#     只认 agint-evolution-driver 段里那一处 repoRoot；要扩到别的机器私有键时，
#     在下面两个正则里各加一条即可。
patch_read_repo_root() {  # $1=文件 → 打印该文件 agint-evolution-driver 段的 repoRoot 原值（无则空）
  python3 - "$(winpath "$1")" <<'PY' 2>/dev/null || true
import re, sys
try:
    text = open(sys.argv[1], encoding='utf-8').read()
except OSError:
    sys.exit(0)
# 只在 agint-evolution-driver 这个 - id: 块内找，别处同名键不误伤
m = re.search(r'-\s+id:\s+agint-evolution-driver\b(?:(?!-\s+id:).)*?repoRoot:\s*(\S[^\n]*)', text, re.S)
print(m.group(1).strip() if m else '')
PY
}
PATCH_TPL_REPO_ROOT=""
[ -f "$BUNDLE_PATCH_SRC" ] && PATCH_TPL_REPO_ROOT="$(patch_read_repo_root "$BUNDLE_PATCH_SRC")"
PATCH_KEPT_REPO_ROOT=""
[ -f "$BUNDLE_PATCH_DST" ] && PATCH_KEPT_REPO_ROOT="$(patch_read_repo_root "$BUNDLE_PATCH_DST")"

cp -f "$BUNDLE_PATCH_SRC"    "$BUNDLE_PATCH_DST"    || die "bundle patch 复制失败: $BUNDLE_PATCH_SRC"

# 3a-bis. 展开 `__DSH_HOME__` 占位符 → 本机真实路径。
#     为什么需要（dsh 0.2.0-rc.2 实测，AGINT 0.11.0 模板踩坑）：
#       cordis:include 用 new URL(config.path, ctx.baseUrl) 解析 include 路径
#       （cordis-plugin-include/lib/index.js:123），而 dsh 把 ctx.baseUrl 定为
#       **本层配置文件所在目录**（dsh-app-boot/lib/index.js:4070）——bundle 层的
#       preset 声明行因此按 $DSH_HOME/.agint-bundle/ 解析，不是 profile 根。
#       模板里写死 `../../.agent-presets/…` 会落到 file:///.agent-presets/…
#       （文件系统根，不存在）⇒ `agent-preset/invalid: … config file not found`
#       ⇒ agint / agint-blockchain / agint-investor / agint-ops 四个 preset
#         永远不注册，UI 里只剩 standard/ptc/minimal/cordis。
#     为什么用占位符而不是直接写绝对路径：
#       ① include 的 path 禁止 `!!js`（app-boot:3041
#          "include path must be literal; config expressions are not evaluated"）；
#       ② cordis.patch.yml 是**两机共用模板**（见 3a 段事故记录），机器私有绝对
#          路径按 AGENTS.md:16 红线不入库。
#     本步骤与 3a/3b 同构：模板给占位符，装脚本按 $DSH_HOME 求真值。
if grep -q '__DSH_HOME__' "$BUNDLE_PATCH_DST" 2>/dev/null; then
  if [ "$DRY_RUN" = "1" ]; then
    log "   [DRY] 将把 __DSH_HOME__ 展开为：$DSH_HOME"
  else
    python3 - "$(winpath "$BUNDLE_PATCH_DST")" "$DSH_HOME" <<'PY' \
      || die "bundle patch 的 __DSH_HOME__ 展开失败"
import re, sys
path, home = sys.argv[1], sys.argv[2].rstrip('/')
text = open(path, encoding='utf-8').read()
# 只替换 `path:` 键上的占位符。注释里也会出现 __DSH_HOME__（K83 说明段举例
# 引用了旧写法的 ../../.agent-presets/…），那些是文档不是配置，替换掉会
# 让注释指向与自身描述不符的路径。
pattern = re.compile(r'(^\s*path:\s*)__DSH_HOME__', re.M)
new_text, n = pattern.subn(lambda m: m.group(1) + 'file://' + home, text)
if n == 0:
    print('[AGINT]   ! 没有 `path:` 行含 __DSH_HOME__，未改动')
    sys.exit(0)
open(path, 'w', encoding='utf-8', newline='').write(new_text)
print(f"[AGINT]   ✓ 展开 __DSH_HOME__ → file://{home}（{n} 处 preset include 路径）")
PY
  fi
else
  log "   ✓ 模板无 __DSH_HOME__ 占位符（老模板，无需展开）"
fi

# 3b. 写回 override（模板是 `!!js` 表达式时不写回，见上方注释）。
case "$PATCH_TPL_REPO_ROOT" in
  '!!js'*)
    log "   ✓ 模板用 !!js 求值 repoRoot，不做保留（各机加载时自算，逃生口 AGINT_REPO_ROOT 有效）"
    ;;
  *)
    if [ -n "$PATCH_KEPT_REPO_ROOT" ]; then
      if [ "$DRY_RUN" = "1" ]; then
        log "   [DRY] 将保留本机 repoRoot override：$PATCH_KEPT_REPO_ROOT"
      else
        python3 - "$(winpath "$BUNDLE_PATCH_DST")" "$PATCH_KEPT_REPO_ROOT" <<'PY' \
          || warn "保留 repoRoot override 失败（槽里是模板值，frozen-anchor 等依赖本机路径的 job 会失败）"
import re, sys
path, keep = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
m = re.search(r'(-\s+id:\s+agint-evolution-driver\b(?:(?!-\s+id:).)*?repoRoot:\s*)(\S[^\n]*)', text, re.S)
if not m:
    print('[AGINT]   ! 模板里没有 repoRoot 行，本机 override 未写回')
    sys.exit(0)
if m.group(2).strip() == keep:
    sys.exit(0)          # 这台机本来就没 override（值与模板相同）⇒ 不动、不吵
open(path, 'w', encoding='utf-8', newline='').write(
    text[:m.start(2)] + keep + text[m.end(2):])
print(f'[AGINT]   ✓ 保留本机 repoRoot override：{keep}（模板值「{m.group(2).strip()}」已让位）')
PY
      fi
    fi
    ;;
esac

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

# ── 3.5 注册 bundle 到 profile 清单（dsh.profile.bundles + dependencies）──────
# 与 uninstall.sh 2.6「摘除」对称。⛔ 少这一步：bundle 目录在、patch 在，
# 但 dsh 根本不加载它 —— 现象是「装完像没装」，**且没有任何报错**。
# 幂等：已注册则只打印跳过，不重写文件。
#
# ⛔ dependencies 里那一项是 2026-10-01 新增的，**不是冗余**：plugin_manager 每次
# 装/卸 bundle 都在 profile 目录跑 pnpm，pnpm 会剪掉没声明的包。bundle 实体
# 改成 symlink 之后，声明这一项才让它免于被剪（详见文件头）。
log "3.5/4 注册 bundle 到 profile 清单（dsh.profile.bundles + dependencies）"
if [ ! -f "$PROFILE_MANIFEST" ]; then
  warn "  跳过：$PROFILE_MANIFEST 不存在（该 profile 还没被 dsh 初始化过？）"
  warn "  手工补救：在 dsh.profile.bundles 里加上 $BUNDLE_NAME"
elif [ "$DRY_RUN" = "1" ]; then
  log "   注册 (dry): $BUNDLE_NAME @ $PROFILE_MANIFEST"
else
  backup "profile-manifest" "$PROFILE_MANIFEST"
  python3 - "$(winpath "$PROFILE_MANIFEST")" "$BUNDLE_NAME" "link:$BUNDLE_DST" <<'PY' || warn "profile 清单注册失败，请手工把 $BUNDLE_NAME 加入 dsh.profile.bundles（备份见 $BACKUP_DIR）"
import sys, json, io
path, name, spec = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(io.open(path, encoding='utf-8').read())
profile = data.setdefault('dsh', {}).setdefault('profile', {})
changed = []
bundles = profile.get('bundles')
if bundles is None:
    profile['bundles'] = [name]
    changed.append('bundles+')
elif not isinstance(bundles, list):
    print(f"[AGINT]   ✗ dsh.profile.bundles 不是数组（{type(bundles).__name__}），拒绝改写，请手工修")
    sys.exit(1)
elif name not in bundles:
    bundles.append(name)  # 追加末尾 = 优先级最低；官方 bundle 在前
    changed.append('bundles+')
deps = data.setdefault('dependencies', {})
if not isinstance(deps, dict):
    print(f"[AGINT]   ✗ dependencies 不是对象（{type(deps).__name__}），拒绝改写，请手工修")
    sys.exit(1)
if deps.get(name) != spec:
    deps[name] = spec
    changed.append('dependencies')
if not changed:
    print(f"[AGINT]   ↻ {name} 已注册（bundles + dependencies），跳过")
    sys.exit(0)
io.open(path, 'w', encoding='utf-8', newline='\n').write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"[AGINT]   ✓ 已更新 {', '.join(changed)}：bundles = {', '.join(profile['bundles'])}，dependencies[{name}] = {spec}")
PY
fi

# ── 3.6 materialize node_modules/@agint/host 软链 ────────────────────────────
# dsh 解析 bundle 的唯一位置是 profiles/web/node_modules/<name>，实体在
# $DSH_HOME/.agint-bundle/ ⇒ 这里必须有一条指过去的链接。3.5 已把
# "link:<实体目录>" 写进 dependencies，pnpm 下次跑会认领这条链接；本步只保证
# 「装完当下 dsh 就能看见 bundle」，不依赖 pnpm 被调用过。
log "3.6/4 建立 bundle 解析软链 → $BUNDLE_LINK"
ensure_bundle_link() {
  local link="$BUNDLE_LINK" target="$BUNDLE_DST"
  if [ -L "$link" ]; then
    local cur; cur="$(readlink "$link")"
    if [ "$cur" = "$target" ]; then
      log "   ✓ 软链已就位（$link → $target）"
      return 0
    fi
    log "   ↻ 软链指向已变（$cur → $target），重建"
    rm -f "$link"
  elif [ -e "$link" ]; then
    # 2026-10-01 前的旧部署位：一整份实体目录。让位给软链（内容已由 BUNDLE_DST 持有）。
    log "   ↻ $link 是旧部署留下的实体目录，移入 .agint-bundle 后改为软链"
    if [ "$DRY_RUN" != "1" ]; then
      backup "bundle-legacy" "$link"
      rm -rf "$link"
    fi
  fi
  [ "$DRY_RUN" = "1" ] && { log "   [DRY] 建软链 $link → $target"; return 0; }
  mkdir -p "$(dirname "$link")"
  # -n：已存在同名链接时覆盖，不动实体目录
  ln -sfn "$target" "$link" 2>/dev/null \
    && log "   ✓ 软链已建立（$link → $target）" \
    || warn "软链建立失败：$link → $target。dsh 会因解析不到 $BUNDLE_NAME 跳过整个 bundle。"
}
ensure_bundle_link

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

  # 4d. **裸 import 冒烟**（2026-10-01 新增）：每个 bundle 插件真跑一次
  #     `import(<bundle>/plugins/<…>)`。
  #     为什么必须在这里：dsh 的 boot 期只会打一行
  #     `agint-memory (…): failed to import` 就继续，**不报缺哪个包**；
  #     而「装完 → 重启 → 发现 11 个插件挂了 → 才知道是 zod 解析不到」这条路
  #     要绕一整圈才知道根因。哈希一致 / YAML 合法都不等于代码能 import
  #     （K78 教训：文件一致 ≠ 代码可用）。本步把那个圈砍掉。
  #
  #     条目来源 = **bundle patch 里 `name: ./plugins/…` 的真实声明**
  #     （`^[[:space:]]*name:` 开头，注释行天然不匹配），不是 glob 目录：
  #     agint-quality-eval / -contract / -policy / -report 是 agint-quality 的
  #     **嵌套子模块**（./plugins/agint-quality/agint-quality-eval/lib/index.js），
  #     顶层 `agint-*` glob 扫不到它们。
  if command -v node >/dev/null 2>&1; then
    smoke_fail=0; smoke_n=0
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      full="$BUNDLE_DST/${entry#./}"
      smoke_n=$((smoke_n+1))
      if [ ! -f "$full" ]; then
        warn "patch 声明的插件入口不存在：$entry"
        smoke_fail=$((smoke_fail+1)); continue
      fi
      if ! node --input-type=module -e "await import('file://$full')" >/dev/null 2>&1; then
        warn "插件 import 失败：$entry — $(node --input-type=module -e "await import('file://$full')" 2>&1 | grep -oE "(Cannot find package '[^']*'|Error \[ERR_[A-Z_]+\])" | head -1)"
        smoke_fail=$((smoke_fail+1))
      fi
    done < <(grep -oE '^[[:space:]]*name:[[:space:]]*\./plugins/[^ ]*\.js' "$BUNDLE_PATCH_DST" \
             | sed -E 's/^[[:space:]]*name:[[:space:]]*//' | sort -u)
    if [ "$smoke_n" -eq 0 ]; then
      warn "未能从 bundle patch 解析出任何插件入口，冒烟未执行"
      failed=$((failed+1))
    elif [ "$smoke_fail" -gt 0 ]; then
      warn "插件 import 冒烟：$smoke_fail/$smoke_n 失败（上面已打印根因）"
      failed=$((failed+1))
    else
      log "   ✓ 插件 import 冒烟全通（$smoke_n 个声明入口）"
    fi
  else
    warn "未找到 node，跳过插件 import 冒烟"
  fi

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

# ── 4.6 mirror 解析卫兵复跑（与 1.45 同理：无 rsync 的机器整树换入会清掉）────
# zod 是 1.5 主 + 4.5 兜底；mirror 三入口同理 1.45 主 + 4.6 复跑。幂等，已就绪即跳过。
if [ "$DRY_RUN" != "1" ]; then
  ensure_mirror_module_entry
else
  log "   ⊘ 跳过 mirror 解析卫兵复跑（dry-run）"
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

# ── 4.7 ~~防御性补装 dsh-workflow-worker-thread~~ 已下线（2026-09-29）────
# 历史包袱：AGINT preset 曾在 2026-09-20 硬引用 @deepseek-ai/dsh-workflow-worker-thread
# （0.0.1-rc.3 发布候选，dsh 官方不携带），导致 4 个 preset 全部「加载失败」。
# 根因已修：presets/*.yml 三处全部改用 dsh 默认的 @deepseek-ai/dsh-workflow-ptc
# （stable，随 dsh 官方 deps 携带）。
#
# 本步骤原为「防御性补装旧包」的兜底，2026-09-29 下线，理由三条：
#   1. 补装对象已不存在——dsh 0.1.7-rc.2 官方 deps 只有 dsh-workflow-ptc，
#      worker-thread 是 dsh 0.0.1 时代的 RC 包，当前 dsh 不带。
#   2. preset 不再依赖它——三个 preset 引用的 ptc 走 include baseUrl 向上解析到
#      dsh 官方包，补装一个不受 dsh 版本管理的包救不了任何真实故障。
#   3. 换成 ptc 补装同样不可取——`pnpm add <pkg>` 不带版本号会拉 npm 最新版，
#      与本机 dsh 版本漂移；比留着旧引用更糟。
#
# 若日后确有插件真依赖某个 dsh 未携带的包，正确做法是带精确版本号补装
# （`pnpm add @deepseek-ai/<pkg>@<dsh同版本>`），并同步登记进 VERSION 兼容矩阵。

# 安装成功收尾：清掉回滚标记（rollback 的 rc=0 守卫已保证不会误回滚，这里是清理动作）
if [ "$DRY_RUN" != "1" ]; then
  commit_install
fi

log ""
log "✅ 安装完成"
log ""
log "下一步："
log "  1. 重启 dsh web（bundle 层与 profile 层都不热更新）："
log "       dsh web"
log "  2. 验证 bundle 真的被认（三步都要看）："
log "       ① profile 清单里有它：grep '@agint/host' $PROFILE_MANIFEST"
log "       ② 软链在位：ls -l $BUNDLE_LINK"
log "       ③ stderr 不出现 'skipping profile bundle \"@agint/host\"'"
log "          （出现即 bundle 层被跳过，按上文提示补 node_modules 解析入口）"
log "  3. 在浏览器里新建会话，确认 agint preset 可选、工具齐全"
log ""
log "回滚方式："
log "  install/uninstall.sh                # 全量卸载"
log "  install/uninstall.sh --restore      # 从备份选一个回滚"
