#!/usr/bin/env bash
# AGINT 卸载脚本（v0.2 — 安全左移版）
#
# 移除 install.sh 装入的内容。默认保留 .agint-backups/ 目录，可手动清理。
#
# ## 用法
#   install/uninstall.sh                  # 默认：全量卸载
#   install/uninstall.sh --dry-run        # 只打印会改什么
#   install/uninstall.sh --list-backups   # 列所有备份
#   install/uninstall.sh --restore        # 从备份选一个回滚（交互式）
#   install/uninstall.sh --restore=AGINT-PRESETS-20260820-200139  # 指定备份回滚
#   install/uninstall.sh --purge-backups  # 删除所有 .agint-backups/
#
# ## 行为
#   patch 中只删 AGINT 仓库声明的 agint-* id 段；用户在 dsh patch 里手写的
#   非 agint-* 配置原样保留。

set -uo pipefail

# ── 参数 ────────────────────────────────────────────────────────────────────
DRY_RUN=0
LIST_BACKUPS=0
RESTORE=""
PURGE_BACKUPS=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)       DRY_RUN=1 ;;
    --list-backups)  LIST_BACKUPS=1 ;;
    --restore)       RESTORE="interactive" ;;
    --restore=*)     RESTORE="${arg#--restore=}" ;;
    --purge-backups) PURGE_BACKUPS=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "[AGINT] ✗ 未知参数: $arg" >&2
      exit 2
      ;;
  esac
done

AGINT_HOME="${AGINT_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if command -v realpath >/dev/null 2>&1; then
  AGINT_HOME="$(realpath "$AGINT_HOME")"
  DSH_HOME="$(realpath -m "$DSH_HOME")"
fi

PRESETS_DST="$DSH_HOME/.agent-presets"
PLUGINS_DST="$DSH_HOME/profiles/web/plugins"
PATCH_DST="$DSH_HOME/profiles/web/cordis.patch.yml"
PATCH_SRC="$AGINT_HOME/profile-patches/web/cordis.patch.yml"

# 2026-09-24：bundle 形态（AGINT 的主载体）
BUNDLE_NAME="@agint/host"
BUNDLE_DST="$DSH_HOME/profiles/web/node_modules/@agint/host"
BUNDLE_PLUGINS_DST="$BUNDLE_DST/plugins"
PROFILE_MANIFEST="$DSH_HOME/profiles/web/package.json"

BACKUP_DIR="$DSH_HOME/.agint-backups"

log() { echo "[AGINT] $*"; }
warn() { echo "[AGINT] ⚠ $*" >&2; }
die()  { echo "[AGINT] ✗ $*" >&2; exit 1; }

log "AGINT_HOME = $AGINT_HOME"
log "DSH_HOME   = $DSH_HOME"
log ""

# ── --list-backups ─────────────────────────────────────────────────────────
if [ "$LIST_BACKUPS" = "1" ]; then
  if [ ! -d "$BACKUP_DIR" ]; then
    log "备份目录不存在: $BACKUP_DIR"
    exit 0
  fi
  log "备份目录: $BACKUP_DIR"
  # 列所有 .tar.gz，按 mtime 倒序，附 size 和 ISO 时间
  find "$BACKUP_DIR" -maxdepth 1 -name 'agint-*.tar.gz' -type f -printf '%T@ %TY-%Tm-%TdT%TH:%TM:%TS %s %p\n' \
    | sort -rn \
    | awk '{ ts=$2; size=$3; path=$4; sub(/.*\//,"",path); printf "  %s  %8d  %s\n", ts, size, path }'
  exit 0
fi

# ── --purge-backups ────────────────────────────────────────────────────────
if [ "$PURGE_BACKUPS" = "1" ]; then
  if [ ! -d "$BACKUP_DIR" ]; then
    log "备份目录不存在: $BACKUP_DIR"
    exit 0
  fi
  count=$(find "$BACKUP_DIR" -maxdepth 1 -name 'agint-*.tar.gz' -type f | wc -l | tr -d ' ')
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY] 将删除 $count 个备份文件"
    exit 0
  fi
  rm -f "$BACKUP_DIR"/agint-*.tar.gz
  log "✓ 删除 $count 个备份文件"
  exit 0
fi

# ── --restore ──────────────────────────────────────────────────────────────
restore_from_backup() {
  local archive="$1"
  if [ ! -f "$archive" ]; then die "备份不存在: $archive"; fi

  log "从备份恢复: $archive"
  log ""
  tar -tzf "$archive" | head -5
  log "  ..."

  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY] 备份恢复未执行"
    return
  fi

  # 解到 archive 同级目录（archive 是绝对路径，-C 到其父目录）
  local parent
  parent="$(dirname "$archive")"
  tar -xzf "$archive" -C "$parent"
  log "✓ 已从 $archive 恢复"
}

if [ -n "$RESTORE" ]; then
  if [ ! -d "$BACKUP_DIR" ]; then die "备份目录不存在: $BACKUP_DIR"; fi
  if [ "$RESTORE" = "interactive" ]; then
    echo ""
    log "可选备份（最新在前）："
    mapfile -t backups < <(find "$BACKUP_DIR" -maxdepth 1 -name 'agint-*.tar.gz' -type f -printf '%T@ %p\n' | sort -rn | awk '{print $2}')
    if [ "${#backups[@]}" -eq 0 ]; then die "无备份可选"; fi
    for i in "${!backups[@]}"; do
      printf "  [%d] %s\n" "$((i+1))" "$(basename "${backups[$i]}")"
    done
    echo ""
    read -rp "[AGINT] 选哪个备份回滚？(1-${#backups[@]}，直接回车取消) " choice
    case "$choice" in
      ""|q|quit) log "已取消"; exit 0 ;;
      *)
        if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#backups[@]}" ]; then
          die "无效选择"
        fi
        restore_from_backup "${backups[$((choice-1))]}"
        ;;
    esac
  else
    # 指定文件名（basename 或绝对路径）
    if [ -f "$RESTORE" ]; then
      restore_from_backup "$RESTORE"
    elif [ -f "$BACKUP_DIR/$RESTORE" ]; then
      restore_from_backup "$BACKUP_DIR/$RESTORE"
    else
      die "找不到备份: $RESTORE（试试 --list-backups）"
    fi
  fi
  exit 0
fi

# ── 默认：全量卸载 ─────────────────────────────────────────────────────────
log "1/3 移除 presets"
for name in agint agint-blockchain agint-investor; do
  dst="$PRESETS_DST/$name"
  if [ -d "$dst" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log "   ✓ 删除 (dry): $dst"
    else
      rm -rf "$dst"
      log "   ✓ 删除 $dst"
    fi
  else
    log "   ↻ $dst 不存在，跳过"
  fi
done

log ""
log "2/3 移除 plugins"
if [ -f "$PATCH_SRC" ]; then
  # ⚠ Windows 坑：python 在 Windows 上把 print 的 '\n' 翻成 '\r\n'，命令替换
  #   只吃掉结尾 \n ⇒ 每个 id 尾部残留 '\r' ⇒ `[ -d "...agint-x\r" ]` 恒假
  #   ⇒ 卸载脚本"静默跳过所有插件"（症状：全部打印「不存在，跳过」）。
  #   故必须 `| tr -d '\r'`。
  ids=$(python3 - "$PATCH_SRC" <<'PY' | tr -d '\r'
import sys, re
with open(sys.argv[1], encoding='utf-8') as f:
    text = f.read()
for m in re.finditer(r'^    - id: (agint-[a-z0-9-]+)', text, re.M):
    bid = m.group(1)
    if bid == 'agint-quality-contract':
        top = 'agint-quality'
    else:
        top = bid
    print(top)
PY
  )
  for top in $ids; do
    for base in "$PLUGINS_DST" "$BUNDLE_PLUGINS_DST"; do
      dst="$base/$top"
      if [ -d "$dst" ]; then
        if [ "$DRY_RUN" = "1" ]; then
          log "   ✓ 删除 (dry): $dst"
        else
          rm -rf "$dst"
          log "   ✓ 删除 $dst"
        fi
      else
        log "   ↻ $dst 不存在，跳过"
      fi
    done
  done
else
  log "   ↻ 仓库 patch 不存在，跳过 plugin 移除（请手动清理）"
fi

log ""
log "2.5/3 移除 bundle 本体（$BUNDLE_DST）"
if [ -d "$BUNDLE_DST" ]; then
  for item in plugins cordis.patch.yml package.json; do
    if [ -e "$BUNDLE_DST/$item" ]; then
      if [ "$DRY_RUN" = "1" ]; then
        log "   ✓ 删除 (dry): $BUNDLE_DST/$item"
      else
        rm -rf "$BUNDLE_DST/$item"
        log "   ✓ 删除 $BUNDLE_DST/$item"
      fi
    fi
  done
  # ⛔ 绝不 rm -rf 这个 node_modules：里面是 → dsh 安装目录的 junction，
  #    rm -rf 会跟进目标，把 dsh 自己的 266 个包一起删掉。
  #    留着无害：bundles 列表摘掉 @agint/host 后就不会再加载它。
  if [ -d "$BUNDLE_DST/node_modules" ]; then
    log "   ⊘ 保留 $BUNDLE_DST/node_modules（junction，删它会连坐 dsh 自身的包）"
  fi
else
  log "   ↻ $BUNDLE_DST 不存在，跳过"
fi

log ""
log "2.6/3 从 dsh.profile.bundles 摘掉 $BUNDLE_NAME"
if [ -f "$PROFILE_MANIFEST" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "   ✓ 摘除 (dry): $BUNDLE_NAME @ $PROFILE_MANIFEST"
  else
    cp -f "$PROFILE_MANIFEST" "$PROFILE_MANIFEST.bak-agint-uninstall-$(date +%Y%m%d-%H%M%S)"
    python3 - "$(winpath "$PROFILE_MANIFEST")" "$BUNDLE_NAME" <<'PY' || warn "profile 清单改写失败，请手动移除（备份已留）"
import sys, json, io
path, name = sys.argv[1], sys.argv[2]
data = json.loads(io.open(path, encoding='utf-8').read())
bundles = (data.get('dsh') or {}).get('profile', {}).get('bundles')
if not isinstance(bundles, list) or name not in bundles:
    print(f"[AGINT]   ↻ bundles 中无 {name}，跳过")
    sys.exit(0)
data['dsh']['profile']['bundles'] = [b for b in bundles if b != name]
io.open(path, 'w', encoding='utf-8', newline='\n').write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"[AGINT]   ✓ 已从 bundles 摘除 {name}")
PY
  fi
else
  log "   ↻ $PROFILE_MANIFEST 不存在，跳过"
fi

log ""
log "3/3 摘除 patch 中的 agint-* 段"
if [ -f "$PATCH_DST" ]; then
  python3 - "$PATCH_SRC" "$PATCH_DST" "$BACKUP_DIR" "$DRY_RUN" <<'PY'
import sys, re, os, shutil, datetime, tarfile
patch_src, patch_dst, backup_dir, dry_run = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"

if not os.path.exists(patch_src):
    print("[AGINT]   ↻ 仓库 patch 不存在，跳过 patch 清理")
    sys.exit(0)

with open(patch_src, encoding='utf-8') as f:
    src_text = f.read()

agint_ids = [m.group(1) for m in re.finditer(r'^    - id: (agint-[a-z0-9-]+)', src_text, re.M)]
if not agint_ids:
    print("[AGINT]   ↻ 仓库 patch 无 agint-* id，跳过")
    sys.exit(0)

with open(patch_dst, encoding='utf-8') as f:
    dst_text = f.read()

# 先备份到中央目录（如果存在）
if not dry_run and not os.path.exists(backup_dir):
    os.makedirs(backup_dir, exist_ok=True)

# 用 [AGINT-removed] 注释掉整段
removed = 0
for bid in agint_ids:
    pat = re.compile(rf'(?ms)^(    - id: {re.escape(bid)}\s*\n(?:      [^\n]*\n)*)')
    new_text, n = pat.subn('# [AGINT-removed] \\1', dst_text)
    if n:
        dst_text = new_text
        removed += n

if removed:
    if dry_run:
        print(f"[DRY]   注释 (dry): {removed} 个 agint-* insert 段（未写文件）")
        sys.exit(0)
    # 备份到中央目录
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    archive = os.path.join(backup_dir, f"agint-patch-{ts}.tar.gz")
    parent = os.path.dirname(patch_dst)
    base = os.path.basename(patch_dst)
    with tarfile.open(archive, 'w:gz') as tf:
        tf.add(os.path.join(parent, base), arcname=base)
    print(f"[AGINT]   备份: {patch_dst} → {archive}")
    with open(patch_dst, 'w', encoding='utf-8') as f:
        f.write(dst_text)
    print(f"[AGINT]   ✓ 注释了 {removed} 个 agint-* insert 段")
else:
    print("[AGINT]   ↻ dsh patch 中未找到 agint-* 段，无需清理")
PY
fi

log ""
log "✅ 卸载完成"
log "下一步：重启 dsh web"
log ""
log "提示：备份还在 $BACKUP_DIR，用 --list-backups 查看，--restore 回滚"
