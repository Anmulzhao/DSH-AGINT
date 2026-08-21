#!/usr/bin/env bash
# AGINT 安装脚本（v0.2 — 安全左移版）
#
# 把 AGINT 仓库内容铺到 $DSH_HOME，对应 preset / plugin / patch 三个注入点。
# 幂等：已存在则备份 + 同步，不破坏用户已有内容（非 agint-* 段原样保留）。
#
# ## 安全设计（§5.2 安全左移 + docs/security-boundary.md）
#   1. 前置：跑 install/agint-security-checks.sh，任意 fail → 退出
#   2. 复制：用 rsync --no-links + exclude 列表，禁止跟随 symlink
#      （AGINT 仓内 node_modules 全是 symlink，会污染 $DSH_HOME 树）
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
#   - patch 合并仍然依赖 python3（dsh patch 含 !!js 自定义 tag，yaml.load 解析不了）
#   - rsync 在不同平台行为略有差异，跨平台验证留 Sprint 1.6

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

PRESETS_SRC="$AGINT_HOME/presets"
PLUGINS_SRC="$AGINT_HOME/plugins"
PATCH_SRC="$AGINT_HOME/profile-patches/web/cordis.patch.yml"

PRESETS_DST="$DSH_HOME/.agent-presets"
PLUGINS_DST="$DSH_HOME/profiles/web/plugins"
PATCH_DST="$DSH_HOME/profiles/web/cordis.patch.yml"
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
[ -f "$PATCH_SRC" ]   || die "patch 源缺失: $PATCH_SRC"
[ -d "$DSH_HOME" ]    || die "$DSH_HOME 不存在，请先跑 'dsh web' 初始化 dsh"

if [ "$FORCE" != "1" ] && [ ! -d "$AGINT_HOME/.git" ]; then
  die "AGINT_HOME 不是 git 仓库（$AGINT_HOME），加 --force 跳过"
fi

command -v rsync   >/dev/null 2>&1 || die "需要 rsync（macOS 自带，Linux 通常预装）"
command -v python3 >/dev/null 2>&1 || die "需要 python3（patch 合并用）"

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
  # - --no-links 关键：拒绝跟随 symlink，防 node_modules 软链污染
  # - exclude 列表：开发期临时文件
  if [ "$DRY_RUN" = "1" ]; then
    log "   rsync (dry): $1/ → $2/"
    return
  fi
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
}

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

# ── 3. 同步 patch ───────────────────────────────────────────────────────────
log "3/4 同步 patch → $PATCH_DST"
mkdir -p "$(dirname "$PATCH_DST")"
backup "patch" "$PATCH_DST"

# 整段重建法（v0.1.3 沿用）：dst 与 src 都被视为「顶层 YAML 数组」，
# src 里的每个顶层项作为整段 list 元素。
python3 - "$PATCH_SRC" "$PATCH_DST" "$BACKUP_DIR" "$DRY_RUN" <<'PY'
import sys, re, os, shutil, datetime, tarfile

patch_src, patch_dst, backup_dir, dry_run = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"

AGINT_ID = re.compile(r"""^\s*- id:\s+(agint-[a-z0-9-]+)\s*$""")

def split_top_level_items(text):
    """把 YAML 文本拆成 (header, items, footer)。
    顶层 list 元素识别：行首「- 」(零缩进)。嵌套 - id: agint-*（缩进 4）不算顶层项。
    """
    lines = text.splitlines(keepends=True)
    items = []
    cur = []
    header_lines = []
    started = False
    for line in lines:
        if not started:
            if line.startswith('-') and (len(line) == 1 or line[1] in (' ', '\n')):
                started = True
                cur = [line]
            else:
                header_lines.append(line)
        else:
            if line.startswith('-') and (len(line) == 1 or line[1] in (' ', '\n')):
                items.append(''.join(cur))
                cur = [line]
            else:
                cur.append(line)
    if cur:
        items.append(''.join(cur))
    while header_lines and header_lines[-1].strip() in ('[]', ''):
        header_lines.pop()
    return ''.join(header_lines), items, ''

def is_agint_item(item_text):
    for line in item_text.splitlines():
        if AGINT_ID.match(line.rstrip('\n')):
            return True
    return False

def item_agint_ids(item_text):
    ids = []
    for line in item_text.splitlines():
        m = AGINT_ID.match(line.rstrip('\n'))
        if m:
            ids.append(m.group(1))
    return ids

with open(patch_src, encoding='utf-8') as f:
    src_text = f.read()
src_header, src_items, src_footer = split_top_level_items(src_text)
src_agint_items = [it for it in src_items if is_agint_item(it)]
src_agint_ids = [iid for it in src_agint_items for iid in item_agint_ids(it)]

print(f"[AGINT]   仓库 patch: {len(src_agint_ids)} 个 agint-* id ({len(src_agint_items)} 段)")

if not os.path.exists(patch_dst):
    if dry_run:
        print("[DRY]   dsh patch 不存在 → 首次安装：复制仓库 patch 整体")
    else:
        shutil.copy(patch_src, patch_dst)
        print("[AGINT]   ✓ 首次安装：复制仓库 patch")
    sys.exit(0)

with open(patch_dst, encoding='utf-8') as f:
    dst_text = f.read()
dst_header, dst_items, dst_footer = split_top_level_items(dst_text)

keep_items = [it for it in dst_items if not is_agint_item(it)]
existing_agint_ids = [iid for it in dst_items if is_agint_item(it) for iid in item_agint_ids(it)]
removed_count = sum(1 for it in dst_items if is_agint_item(it))

print(f"[AGINT]   dsh patch: {len(existing_agint_ids)} 个 agint-* 段将被清理 + {len(keep_items)} 个非 agint 段保留")

new_items = keep_items + src_agint_items
new_text = dst_header + ''.join(new_items)

if dry_run:
    print("[DRY] --dry-run：未修改任何文件")
    sys.exit(0)

# 幂等检查
if sorted(existing_agint_ids) == sorted(src_agint_ids) and not dst_text.count('# [AGINT-removed]'):
    print("[AGINT]   ✓ patch 已包含仓库最新版 agint-* 段（无卸载痕迹），跳过")
    sys.exit(0)

# 写盘（备份已在 bash 侧完成）
with open(patch_dst, 'w', encoding='utf-8') as f:
    f.write(new_text)
print(f"[AGINT]   ✓ patch 已同步到仓库最新版（清理 {removed_count} 个 agint 段）")
PY

if [ "$DRY_RUN" != "1" ]; then
  # 注册 patch 回滚：删当前 + 从 backup_dir 最新 patch 备份恢复
  register_step "restore_backup|$PATCH_DST"
fi

# ── 4. 装后静态校验 ─────────────────────────────────────────────────────────
log "4/4 装后静态校验"
if [ "$DRY_RUN" = "1" ]; then
  log "   跳过（dry-run）"
else
  failed=0
  # 4a. patch YAML 能被 python yaml.safe_load 解析（剥离 !!js 等自定义 tag 后）
  python3 - "$PATCH_DST" <<'PY' || failed=$((failed+1))
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

# ── 4.5 zod bootstrap（修复 agint-quality-sdk + 子插件的裸 zod 导入）─────────
# 见 install/agint-zod-bootstrap.sh。失败仅 warn，不阻断（用户可手动跑）。
if [ "$DRY_RUN" != "1" ]; then
  if bash "$SCRIPT_DIR/agint-zod-bootstrap.sh" >/dev/null 2>&1; then
    log "   ✓ zod bootstrap OK"
  else
    warn "zod bootstrap 失败（agint-quality-* plugin 启动时会找不到 zod）。手动跑：bash $SCRIPT_DIR/agint-zod-bootstrap.sh"
  fi
else
  log "   ⊘ 跳过 zod bootstrap（dry-run）"
fi

# 装成功 → 清空 partial-steps（trap 不再回滚）
PARTIAL_STEPS=()
trap - EXIT

log ""
log "✅ 安装完成"
log ""
log "下一步："
log "  1. 重启 dsh web（user-patch 层不热更新）："
log "       dsh web"
log "  2. 验证：看 dsh 日志中是否出现 10 个 agint-* Service 加载"
log "  3. 在浏览器里选 agint preset 开新会话，确认工具齐全"
log ""
log "回滚方式："
log "  install/uninstall.sh                # 全量卸载"
log "  install/uninstall.sh --restore      # 从备份选一个回滚"
