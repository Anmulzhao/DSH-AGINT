#!/usr/bin/env bash
# AGINT 安装脚本
# 把 AGINT 仓库内容铺到 $DSH_HOME，对应 preset / plugin / patch 三个注入点
# 幂等：已存在则备份 + 合并，不破坏用户已有内容

set -euo pipefail

# ── 解析路径 ────────────────────────────────────────────────────────────────
AGINT_HOME="${AGINT_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

PRESETS_SRC="$AGINT_HOME/presets"
PLUGINS_SRC="$AGINT_HOME/plugins"
PATCH_SRC="$AGINT_HOME/profile-patches/web/cordis.patch.yml"

PRESETS_DST="$DSH_HOME/.agent-presets"
PLUGINS_DST="$DSH_HOME/profiles/web/plugins"
PATCH_DST="$DSH_HOME/profiles/web/cordis.patch.yml"

echo "[AGINT] AGINT_HOME = $AGINT_HOME"
echo "[AGINT] DSH_HOME   = $DSH_HOME"
echo ""

# ── 前置检查 ────────────────────────────────────────────────────────────────
if [ ! -d "$PRESETS_SRC" ] || [ ! -d "$PLUGINS_SRC" ]; then
  echo "[AGINT] ✗ 源目录不完整，确认仓库结构正确" >&2
  exit 1
fi

if [ ! -d "$DSH_HOME" ]; then
  echo "[AGINT] ✗ $DSH_HOME 不存在，请先运行一次 'dsh web' 初始化 dsh" >&2
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
    mv "$target" "$bak"
    echo "[AGINT]   备份: $target → $bak"
  fi
}

# ── 1. 安装 presets ─────────────────────────────────────────────────────────
echo "[AGINT] 1/3 安装 presets → $PRESETS_DST"
for src in "$PRESETS_SRC"/*/; do
  name="$(basename "$src")"
  dst="$PRESETS_DST/$name"
  backup "$dst"
  cp -a "$src" "$dst"
  echo "[AGINT]   ✓ $name"
done

# ── 2. 安装 plugins ─────────────────────────────────────────────────────────
echo "[AGINT] 2/3 安装 plugins → $PLUGINS_DST"
for src in "$PLUGINS_SRC"/agint-*/; do
  name="$(basename "$src")"
  dst="$PLUGINS_DST/$name"
  backup "$dst"
  cp -a "$src" "$dst"
  echo "[AGINT]   ✓ $name"
done

# ── 3. 合并 patch ───────────────────────────────────────────────────────────
echo "[AGINT] 3/3 合并 patch → $PATCH_DST"

# 把 AGINT 自己的 agint-* insert 段抽出来，append 到用户 patch 里
# 策略：若用户 patch 已含 agint-memory id，则跳过（不重复注入）
AGINT_INSERTS="$(awk '/^- insert:/{flag=1; next} /^- /{flag=0} flag' "$PATCH_SRC")"

if [ -f "$PATCH_DST" ]; then
  backup "$PATCH_DST"
  touch "$PATCH_DST"

  # 去重：任何已存在 agint-* id 的整段跳过
  to_add=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    id="$(echo "$line" | sed -n 's/^[[:space:]]*- id:[[:space:]]*\(agint-[a-z-]*\).*/\1/p')"
    if [ -n "$id" ] && grep -q "id: $id" "$PATCH_DST"; then
      echo "[AGINT]   ↻ $id 已存在，跳过"
      continue
    fi
    to_add+="$line"$'\n'
  done <<< "$AGINT_INSERTS"

  if [ -n "$to_add" ]; then
    echo "" >> "$PATCH_DST"
    echo "# ── AGINT (auto-merged by install.sh) ────────────────────────────" >> "$PATCH_DST"
    echo "$to_add" >> "$PATCH_DST"
  fi
else
  cp -a "$PATCH_SRC" "$PATCH_DST"
fi

echo ""
echo "[AGINT] ✅ 安装完成"
echo ""
echo "[AGINT] 下一步："
echo "[AGINT]   1. 重启 dsh web（user-patch 层不热更新）："
echo "[AGINT]        dsh web"
echo "[AGINT]   2. 验证：看 dsh 日志中是否出现 8 个 agint-* Service 加载"
echo "[AGINT]   3. 在浏览器里选 agint preset 开新会话，确认工具齐全"