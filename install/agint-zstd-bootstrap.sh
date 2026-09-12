#!/usr/bin/env bash
# install/agint-zstd-bootstrap.sh — 兜底 zstd CLI，给 agint-dream sweep 用
#
# ## 背景（2026-09-12 教训，详见 evolve 提案 2fe4cf32）
#   agint-dream sweep.js 第 111 行用 `execFile('zstd', ['-dc', logPath])`
#   读 session.jsonl.zstd。DSH 沙箱镜像（Debian 12 / Ubuntu）按最小化
#   原则装了 libzstd1（writer 运行时库）但跳过 zstd CLI（Priority: optional），
#   结果 dream sweep 每晚 ENOENT 但 validation=OK 静默失败 ~2 周才被发现。
#
#   注释 "uses the `zstd` CLI (present on this host)" 是错的——host 没装。
#   修复契约：镜像层不主动装应用包（保持 ~50MB 精简）→ entrypoint 阶段
#   按需补 → 本脚本就是这一层。
#
# ## 行为
#   幂等：`zstd --version` 可执行就退出 0。
#   Linux：尝试 `apt-get install -y zstd`（需 sudo / root；非 root 仅 warn）。
#   Windows：探测 scoop / choco / winget，**不自动装**，仅打印一行命令提示。
#   macOS：探测 brew，**不自动装**，仅打印一行命令提示。
#   都不通 → warn + 给一份"手动装"清单，exit 1（不阻塞 install.sh）。
#
# ## 用法
#   install/agint-zstd-bootstrap.sh                 # 检查并尽量装
#   install/agint-zstd-bootstrap.sh --dry-run       # 只检测，不装
#   install/agint-zstd-bootstrap.sh --check         # 仅检查（CI 友好，exit 0/1）
#
# ## 退出码
#   0 = zstd 已就绪；1 = 缺 zstd 且没自动装上；2 = 参数错。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGINT_HOME="${AGINT_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

DRY_RUN=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --check)   CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "[zstd-bootstrap] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log()  { echo "[zstd-bootstrap] $*"; }
warn() { echo "[zstd-bootstrap] ⚠ $*" >&2; }
die()  { echo "[zstd-bootstrap] ✗ $*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY: $*"
  else
    eval "$@"
  fi
}

# ── 1. 已就绪检查（跨平台，兼容 Git Bash MSYS） ─────────────────────────────
detect_zstd() {
  # 优先 command -v（认 PATH，包括 scoop / choco 装的）
  if command -v zstd >/dev/null 2>&1; then
    echo "$(command -v zstd)"
    return 0
  fi
  # 兜底：Git Bash MSYS 路径有时 command -v 找不到 PATH 里的 .exe
  for p in /usr/bin/zstd /usr/local/bin/zstd \
           "/c/ProgramData/scoop/apps/zstd/current/zstd.exe" \
           "/c/Program Files/zstd/zstd.exe"; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}

ZSTD_PATH="$(detect_zstd || true)"
if [ -n "$ZSTD_PATH" ]; then
  if [ "$CHECK_ONLY" = "1" ]; then
    log "OK: $ZSTD_PATH"
    exit 0
  fi
  ver="$(zstd --version 2>&1 | head -1)"
  log "✓ zstd 已就绪: $ZSTD_PATH ($ver)"
  exit 0
fi

# ── 2. 没装 → 按平台尝试自动装 / 给指引 ───────────────────────────────────
OS="$(uname -s 2>/dev/null || echo "Windows")"
case "$OS" in
  Linux|Darwin)
    if [ "$CHECK_ONLY" = "1" ]; then
      warn "zstd 未安装（$OS）"
      exit 1
    fi

    # Linux: 优先 apt-get
    if command -v apt-get >/dev/null 2>&1; then
      if [ "$(id -u)" = "0" ]; then
        log "未找到 zstd，尝试 apt-get install -y zstd（root）"
        run apt-get update
        run apt-get install -y --no-install-recommends zstd
        run rm -rf /var/lib/apt/lists/*
      else
        warn "未找到 zstd 且当前非 root，无法自动 apt-get install。"
        warn "请用 root / sudo 跑：apt-get install -y zstd"
      fi
    # macOS: brew
    elif [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      warn "未找到 zstd。请跑：brew install zstd"
    else
      warn "未找到 zstd（$OS，无 apt/brew）。请用系统包管理器装 zstd。"
    fi
    ;;

  MINGW*|MSYS*|CYGWIN*|Windows*)
    if [ "$CHECK_ONLY" = "1" ]; then
      warn "zstd 未安装（Windows）"
      exit 1
    fi
    warn "未找到 zstd。请在 PowerShell 里选一种装："
    warn "  scoop install zstd"
    warn "  choco install zstd"
    warn "  winget install --id Facebook.Zstd"
    warn "装完重开 PowerShell 让 PATH 生效。"
    ;;
  *)
    warn "未识别 OS: $OS，请手动装 zstd。"
    ;;
esac

# ── 3. 再查一次 ────────────────────────────────────────────────────────────
ZSTD_PATH="$(detect_zstd || true)"
if [ -n "$ZSTD_PATH" ]; then
  log "✓ zstd 装好: $ZSTD_PATH"
  exit 0
fi

die "zstd 仍未就绪。agint-dream sweep 会 ENOENT。手动装后重跑本脚本。"
