#!/usr/bin/env bash
# AGINT 卸载脚本
# 移除 install.sh 装入的内容。备份过的 .bak-* 文件**不**自动删，可手动清理。

set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

PRESETS_DST="$DSH_HOME/.agent-presets"
PLUGINS_DST="$DSH_HOME/profiles/web/plugins"
PATCH_DST="$DSH_HOME/profiles/web/cordis.patch.yml"

echo "[AGINT] DSH_HOME = $DSH_HOME"
echo ""

# ── 1. 移除 presets ─────────────────────────────────────────────────────────
echo "[AGINT] 1/3 移除 presets"
for name in agint agint-coder agint-investor; do
  dst="$PRESETS_DST/$name"
  if [ -d "$dst" ]; then
    rm -rf "$dst"
    echo "[AGINT]   ✓ 删除 $dst"
  else
    echo "[AGINT]   ↻ $dst 不存在，跳过"
  fi
done

# ── 2. 移除 plugins ─────────────────────────────────────────────────────────
echo "[AGINT] 2/3 移除 plugins"
for name in agint-memory agint-wiki agint-cron agint-dream agint-rules agint-metrics agint-evolve agint-tool-stats; do
  dst="$PLUGINS_DST/$name"
  if [ -d "$dst" ]; then
    rm -rf "$dst"
    echo "[AGINT]   ✓ 删除 $dst"
  else
    echo "[AGINT]   ↻ $dst 不存在，跳过"
  fi
done

# ── 3. 从 patch 中摘除 agint-* 段 ──────────────────────────────────────────
echo "[AGINT] 3/3 摘除 patch 中的 agint-* 段"
if [ -f "$PATCH_DST" ]; then
  # 用 python 删干净（awk 处理 YAML 块易翻车）
  python3 - "$PATCH_DST" <<'PY' || true
import sys, re
path = sys.argv[1]
with open(path) as f:
    text = f.read()

# 删除以 "  - id: agint-" 开头、属于同一 insert 段的所有行
# 简化策略：把 agint-* insert 段整段注释掉
pattern = re.compile(r'(?ms)^(- insert:\s*\n(?:    - id: agint-[^\n]*\n(?:      [^\n]*\n)*)+)\n')
new_text = pattern.sub(lambda m: '# [AGINT-removed] ' + m.group(1).replace('\n', '\n# [AGINT-removed] '), text)

with open(path, 'w') as f:
    f.write(new_text)
print("[AGINT]   ✓ 已注释 agint-* insert 段（不删备份）")
PY
fi

echo ""
echo "[AGINT] ✅ 卸载完成"
echo "[AGINT] 下一步：重启 dsh web"