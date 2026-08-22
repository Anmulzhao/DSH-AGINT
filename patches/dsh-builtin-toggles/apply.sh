#!/usr/bin/env bash
# 重打 dsh-builtin-toggles 的「忽略无关漂移」补丁。
# 任何 pnpm/npm install 或 dsh plugin update 之后都要重跑一次。
set -euo pipefail

TARGET="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-builtin-toggles/lib/index.js"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OLD='		addReason(reasons, "global_structural_drift");'
NEW='		if (!limitations.includes("global_structural_drift_ignored")) limitations.push("global_structural_drift_ignored");'

[ -f "$TARGET" ] || { echo "FAIL: 找不到 $TARGET"; exit 1; }

if grep -qF "$NEW" "$TARGET"; then
  echo "OK: 补丁已在位，无需重打"
  exit 0
fi

if ! grep -qF "$OLD" "$TARGET"; then
  echo "FAIL: 目标行不存在——上游可能改了实现，请人工复核后再打"
  exit 1
fi

cp "$TARGET" "$HERE/index.js.orig.$(date +%Y%m%d-%H%M%S)"
python3 - "$TARGET" "$OLD" "$NEW" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
assert s.count(old) == 1, f"期望命中 1 处，实际 {s.count(old)} 处"
open(path, 'w', encoding='utf-8').write(s.replace(old, new))
PY

node --input-type=module -e "await import('file://$TARGET')" >/dev/null
echo "OK: 补丁已重打并通过加载验证。重启 dsh web 生效。"
