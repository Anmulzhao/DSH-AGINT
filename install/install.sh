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

# 整段重建法（v0.1.3）：dst 与 src 都被视为「顶层 YAML 数组」，
# src 里的每个顶层项（- insert: 段 / - id: 段）作为整段 list 元素。
# 合并时只搬运 agint-* 段 → 追加到 dst 数组末尾。用户手写的非 agint 段原样保留。
# 不依赖 PyYAML（dsh patch 里含 !!js 自定义 tag，yaml.load 解析不了）。
python3 - "$PATCH_SRC" "$PATCH_DST" "$DRY_RUN" <<'PY'
import sys, re, os, shutil, datetime

patch_src, patch_dst, dry_run = sys.argv[1], sys.argv[2], sys.argv[3] == "1"

AGINT_ID = re.compile(r"""^\s*- id:\s+(agint-[a-z0-9-]+)\s*$""")

def split_top_level_items(text):
    """把 YAML 文本拆成 (header, items, footer)：
      - header: 任何顶层 list 元素之前的注释
      - items: 每个顶层 list 元素（以零缩进 "- " / "- x" 开头）的字符串
      - footer: 顶层 list 之后的尾巴（通常空）
    顶层 list 元素识别：行首「- 」(零缩进)。
    嵌套 - id: agint-*（缩进 4）不算顶层项。
    dsh patch 的顶层「[]」空数组会被识别为「无 item」、整段被剥到 header。
    """
    lines = text.splitlines(keepends=True)

    items = []
    cur = []
    header_lines = []
    started = False
    for line in lines:
        if not started:
            if line.startswith('-') and (len(line) == 1 or line[1] in (' ', '\n')):
                # 第一个顶层项开始
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

    # 剥离 header 末尾的「[]」空数组标记（dsh 默认文件的 [] 写法）
    # 但保留注释行
    while header_lines and header_lines[-1].strip() in ('[]', ''):
        header_lines.pop()

    header = ''.join(header_lines)
    return header, items, ''

def is_agint_item(item_text):
    """判断一个顶层 list 元素是否属于 AGINT。
    - 直接 - id: agint-* 段：是
    - - insert: 段，且其内含 - id: agint-* 子项：是
    - 其他：否
    """
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

# 备份旁路：先看 dst 是否需要重写
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

# 拆 dst：保留非 agint 项，移除所有 agint 项
keep_items = [it for it in dst_items if not is_agint_item(it)]
existing_agint_ids = [iid for it in dst_items if is_agint_item(it) for iid in item_agint_ids(it)]
removed_count = sum(1 for it in dst_items if is_agint_item(it))

print(f"[AGINT]   dsh patch: {len(existing_agint_ids)} 个 agint-* 段将被清理 + {len(keep_items)} 个非 agint 段保留")

# 需要写入的最终 dst 列表 = keep + src_agint_items
new_items = keep_items + src_agint_items

# 序列化：dst_header + items 直接拼接（YAML 顶层数组自动识别，
# 不需要 [ ] 包裹——参考 dsh 内部 bundle patch 的写法）。
new_text = dst_header + ''.join(new_items)

if dry_run:
    print("[DRY] --dry-run：未修改任何文件")
    sys.exit(0)

# 幂等检查：比较「dst 端所有 agint id」与 src 是否一致（顺序忽略）
if sorted(existing_agint_ids) == sorted(src_agint_ids) and not dst_text.count('# [AGINT-removed]'):
    print("[AGINT]   ✓ patch 已包含仓库最新版 agint-* 段（无卸载痕迹），跳过")
    sys.exit(0)

# 写盘 + 备份
ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
bak = f"{patch_dst}.bak-{ts}"
shutil.copy(patch_dst, bak)
print(f"[AGINT]   备份: {patch_dst} → {bak}")
with open(patch_dst, 'w', encoding='utf-8') as f:
    f.write(new_text)
print(f"[AGINT]   ✓ patch 已同步到仓库最新版（清理 {removed_count} 个 agint 段）")
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