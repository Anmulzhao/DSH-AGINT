#!/usr/bin/env bash
# AGINT 卸载脚本
# 移除 install.sh 装入的内容。备份过的 .bak-* 文件**不**自动删，可手动清理。
#
# 策略（v0.1.2 起）：
#   patch 中只删 AGINT 仓库声明的 agint-* id 段；用户在 dsh patch 里手写的
#   非 agint-* 配置原样保留。

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
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

PRESETS_DST="$DSH_HOME/.agent-presets"
PLUGINS_DST="$DSH_HOME/profiles/web/plugins"
PATCH_DST="$DSH_HOME/profiles/web/cordis.patch.yml"
PATCH_SRC="$AGINT_HOME/profile-patches/web/cordis.patch.yml"

log() { echo "[AGINT] $*"; }

log "AGINT_HOME = $AGINT_HOME"
log "DSH_HOME   = $DSH_HOME"
log ""

# ── 1. 移除 presets ─────────────────────────────────────────────────────────
log "1/3 移除 presets"
for name in agint agint-coder agint-investor; do
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

# ── 2. 移除 plugins ─────────────────────────────────────────────────────────
# 从仓库 patch 里读出所有 agint-* id（与 install.sh 一致）
log "2/3 移除 plugins"
if [ -f "$PATCH_SRC" ]; then
  ids=$(python3 - "$PATCH_SRC" <<'PY'
import sys, re
with open(sys.argv[1], encoding='utf-8') as f:
    text = f.read()
for m in re.finditer(r'^    - id: (agint-[a-z0-9-]+)', text, re.M):
    # 取 basename（如 agint-quality-contract → agint-quality）
    bid = m.group(1)
    # 顶级 plugin 目录名：第一个 - 之后的部分（含嵌套子目录）
    # AGINT v0.1.1 起 agint-quality 是顶层，agint-quality-contract 是其子目录
    if bid == 'agint-quality-contract':
        top = 'agint-quality'
    else:
        top = bid
    print(top)
PY
)
  for top in $ids; do
    dst="$PLUGINS_DST/$top"
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
else
  log "   ↻ 仓库 patch 不存在，跳过 plugin 移除（请手动清理）"
fi

# ── 3. 从 patch 中按 id 摘除 agint-* 段 ─────────────────────────────────────
log "3/3 摘除 patch 中的 agint-* 段"
if [ -f "$PATCH_DST" ]; then
  python3 - "$PATCH_SRC" "$PATCH_DST" "$DRY_RUN" <<'PY'
import sys, re, os, shutil, datetime
patch_src, patch_dst, dry_run = sys.argv[1], sys.argv[2], sys.argv[3] == "1"

if not os.path.exists(patch_src):
    print("[AGINT]   ↻ 仓库 patch 不存在，跳过 patch 清理")
    sys.exit(0)

with open(patch_src, encoding='utf-8') as f:
    src_text = f.read()

# 收集所有要摘除的 agint-* id
agint_ids = [m.group(1) for m in re.finditer(r'^    - id: (agint-[a-z0-9-]+)', src_text, re.M)]
if not agint_ids:
    print("[AGINT]   ↻ 仓库 patch 无 agint-* id，跳过")
    sys.exit(0)

with open(patch_dst, encoding='utf-8') as f:
    dst_text = f.read()

# 对每个 id 找其在 dst 中的位置，注释掉整段
removed = 0
for bid in agint_ids:
    pat = re.compile(rf'(?ms)^(    - id: {re.escape(bid)}\s*\n(?:      [^\n]*\n)*)')
    new_text, n = pat.subn('# [AGINT-removed] \\1', dst_text)
    if n:
        dst_text = new_text
        removed += n

if removed:
    if dry_run:
        print(f"[AGINT]   注释 (dry): {removed} 个 agint-* insert 段（未写文件）")
        sys.exit(0)
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    bak = f"{patch_dst}.bak-{ts}"
    shutil.copy(patch_dst, bak)
    print(f"[AGINT]   备份: {patch_dst} → {bak}")
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