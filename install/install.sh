#!/usr/bin/env bash
# AGINT 安装脚本
# 把 AGINT 仓库内容铺到 $DSH_HOME，对应 preset / plugin / patch 三个注入点
# 幂等：已存在则备份 + 同步，不破坏用户已有内容（非 agint-* 段原样保留）
#
# patch 同步策略（v0.1.2 起）：
#   简单粗暴：先把 dsh patch 里所有 agint-* 段（包括被 [AGINT-removed] 注释掉的、
#   含孤儿注释的整段）整段删除，再把仓库 patch 的全部 agint-* 段按文件顺序
#   append 到 dsh patch 末尾（保留用户手写的非 agint 段）。
#   --dry-run 只打印会改什么，不写盘。
#
# --dry-run：只打印会改什么，不写任何文件
# --force：跳过 AGINT_HOME 是否为 git 仓的检查（用于 CI）

set -euo pipefail

# ── 参数 ────────────────────────────────────────────────────────────────────
DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
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

# ── 解析路径 ────────────────────────────────────────────────────────────────
AGINT_HOME="${AGINT_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

PRESETS_SRC="$AGINT_HOME/presets"
PLUGINS_SRC="$AGINT_HOME/plugins"
PATCH_SRC="$AGINT_HOME/profile-patches/web/cordis.patch.yml"

PRESETS_DST="$DSH_HOME/.agent-presets"
PLUGINS_DST="$DSH_HOME/profiles/web/plugins"
PATCH_DST="$DSH_HOME/profiles/web/cordis.patch.yml"

log() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY] $*"
  else
    echo "[AGINT] $*"
  fi
}

log "AGINT_HOME = $AGINT_HOME"
log "DSH_HOME   = $DSH_HOME"
log ""

# ── 前置检查 ────────────────────────────────────────────────────────────────
if [ ! -d "$PRESETS_SRC" ] || [ ! -d "$PLUGINS_SRC" ]; then
  log "✗ 源目录不完整，确认仓库结构正确" >&2
  exit 1
fi

if [ ! -d "$DSH_HOME" ]; then
  log "✗ $DSH_HOME 不存在，请先运行一次 'dsh web' 初始化 dsh" >&2
  exit 1
fi

if [ "$FORCE" != "1" ] && [ ! -d "$AGINT_HOME/.git" ]; then
  log "✗ AGINT_HOME 不是 git 仓库（$AGINT_HOME），加 --force 跳过此检查" >&2
  exit 1
fi

mkdir -p "$PRESETS_DST" "$PLUGINS_DST" "$(dirname "$PATCH_DST")"

# ── 备份函数 ────────────────────────────────────────────────────────────────
backup() {
  local target="$1"
  if [ -e "$target" ]; then
    local ts
    ts="$(date +%Y%m%d-%H%M%S)"
    local bak="${target}.bak-${ts}"
    if [ "$DRY_RUN" = "1" ]; then
      log "   备份 (dry): $target → $bak"
    else
      mv "$target" "$bak"
      log "   备份: $target → $bak"
    fi
  fi
}

safe_cp() {
  if [ "$DRY_RUN" = "1" ]; then
    log "   cp (dry): $1 → $2"
  else
    cp -a "$1" "$2"
  fi
}

# ── 1. 安装 presets ─────────────────────────────────────────────────────────
log "1/3 同步 presets → $PRESETS_DST"
for src in "$PRESETS_SRC"/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  dst="$PRESETS_DST/$name"
  backup "$dst"
  safe_cp "$src" "$dst"
  log "   ✓ $name"
done

# ── 2. 安装 plugins ─────────────────────────────────────────────────────────
log "2/3 同步 plugins → $PLUGINS_DST"
for src in "$PLUGINS_SRC"/agint-*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  dst="$PLUGINS_DST/$name"
  backup "$dst"
  safe_cp "$src" "$dst"
  log "   ✓ $name"
done

# ── 3. 同步 patch ───────────────────────────────────────────────────────────
log "3/3 同步 patch → $PATCH_DST"

if [ ! -f "$PATCH_SRC" ]; then
  log "✗ 仓库 patch 不存在: $PATCH_SRC" >&2
  exit 1
fi

# 整段重建法：删除 dst 里所有 agint-* 段（含 [AGINT-removed] 注释段 + 孤儿注释），
# 然后 append src 的全部 agint-* 段。简单可靠，不需要复杂行号计算。
python3 - "$PATCH_SRC" "$PATCH_DST" "$DRY_RUN" <<'PY'
import sys, re, os, shutil, datetime

patch_src, patch_dst, dry_run = sys.argv[1], sys.argv[2], sys.argv[3] == "1"

def collect_agint_ranges(text):
    """收集 text 里所有 agint-* 段的位置（含孤儿注释）。"""
    lines = text.splitlines(keepends=True)
    n = len(lines)
    # 用三引号字符串构造正则避免转义问题
    id_pat = re.compile(r"""^\s*- id:\s+(agint-[a-z0-9-]+)\s*$""")
    ranges = []

    i = 0
    while i < n:
        stripped = lines[i].rstrip('\n')
        if id_pat.match(stripped):
            # 向前回溯吃孤儿注释 + 空行
            bs = i
            j = i - 1
            while j >= 0:
                prev = lines[j].rstrip('\n')
                if prev.startswith('#') or prev == '':
                    bs = j
                    j -= 1
                else:
                    break
            # 向后吃本段剩余行
            be = i + 1
            while be < n:
                nxt = lines[be].rstrip('\n')
                if id_pat.match(nxt):
                    break
                if nxt == '':
                    break
                be += 1
            ranges.append((bs, be))
            i = be
        else:
            i += 1
    return ranges

with open(patch_src, encoding='utf-8') as f:
    src_text = f.read()
with open(patch_dst, encoding='utf-8') as f:
    dst_text = f.read() if os.path.exists(patch_dst) else ''

if not dst_text:
    if dry_run:
        print("[DRY]   dsh patch 不存在，将整体复制仓库 patch")
    else:
        shutil.copy(patch_src, patch_dst)
        print("[AGINT]   ✓ 首次安装：复制仓库 patch")
    sys.exit(0)

dst_ranges = collect_agint_ranges(dst_text)
src_id_pat = re.compile(r"""^\s*- id:\s+(agint-[a-z0-9-]+)\s*$""")
src_id_count = sum(1 for line in src_text.splitlines() if src_id_pat.match(line.rstrip('\n')))

print(f"[AGINT]   仓库 patch: {src_id_count} 个 agint-* id")
print(f"[AGINT]   dsh patch: {len(dst_ranges)} 个 agint-* 段（含 [AGINT-removed]）")

# 计算 dst 中的 agint-* 段在 dst 里的总行数
agint_line_count = sum(e - s for s, e in dst_ranges)

# 策略：删 dst 里所有 agint-* 段（含孤儿注释）→ 末尾 append src_text
lines = dst_text.splitlines(keepends=True)
for s, e in sorted(dst_ranges, key=lambda x: x[0], reverse=True):
    lines = lines[:s] + lines[e:]
remaining_text = ''.join(lines).rstrip('\n') + '\n\n'
new_text = remaining_text + src_text

if dry_run:
    print("[DRY] --dry-run：未修改任何文件")
    sys.exit(0)

# 幂等性：若 dst 已经包含 src_text 的完整副本（之前 install 留下的），
# 且没有 [AGINT-removed] 痕迹（没有未恢复的卸载痕迹），
# 视为「dst 已同步」，跳过写盘。
removed_count = dst_text.count('# [AGINT-removed]')
if src_text in dst_text and removed_count == 0:
    print("[AGINT]   ✓ patch 已包含仓库最新版 agint-* 段（无卸载痕迹），跳过")
    sys.exit(0)

# 如果 dst 里包含 src_text 但有卸载痕迹，仍然重写一次清理
ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
bak = f"{patch_dst}.bak-{ts}"
shutil.copy(patch_dst, bak)
print(f"[AGINT]   备份: {patch_dst} → {bak}")
with open(patch_dst, 'w', encoding='utf-8') as f:
    f.write(new_text)
print(f"[AGINT]   ✓ patch 已同步到仓库最新版（清理 {removed_count} 个卸载痕迹）")
PY

log ""
log "✅ 安装完成"
log ""
log "下一步："
log "  1. 重启 dsh web（user-patch 层不热更新）："
log "       dsh web"
log "  2. 验证：看 dsh 日志中是否出现 9 个 agint-* Service 加载"
log "  3. 在浏览器里选 agint preset 开新会话，确认工具齐全"
log ""
log "回滚：把 .bak-YYYYMMDD-HHMMSS 文件 mv 回原位即可"