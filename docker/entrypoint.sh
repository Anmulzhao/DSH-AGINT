#!/usr/bin/env bash
# 容器入口：把数据盘 /persist 当成 dsh 的「家」。
#
# 持久化分区（一图总结）：
#
#   /persist                          ← NAS 数据盘挂载点（一个 bind mount）
#     ├─ dsh-install/                 ← npm 全局安装目录（dsh 装在这）
#     │    └─ bin/dsh, lib/node_modules/@deepseek-ai/dsh/...
#     ├─ dsh-home/                    ← $DSH_HOME
#     │    ├─ profiles/web/
#     │    │    ├─ plugins/agint-*  (23 个)
#     │    │    └─ cordis.patch.yml
#     │    ├─ .credentials.yaml
#     │    └─ sentinel.lease
#     └─ agint-data/                  ← $AGINT_HOME
#          ├─ wiki/
#          ├─ dreams/
#          └─ reviews/
#
# 设计上的关键原则：即使老板要"自己安装 dsh"，这里自动装和手动装的结果是一样的 —
# 都装到 /persist/dsh-install。所以其实"自己装"已经隐式包含了：换 dsh 版本只需要
# 删一次这个目录、再次启动容器或手动跑一次 npm install，位置不变、效果一样。
set -euo pipefail
log() { echo "[entrypoint] $*"; }

# ── 路径：所有东西都指向 /persist ───────────────────────────────────────
export PERSIST="${PERSIST:-/persist}"
export DSH_HOME="${DSH_HOME:-${PERSIST}/dsh-home}"
export AGINT_HOME="${AGINT_HOME:-${PERSIST}/agint-data}"
AGINT_SRC="${AGINT_SRC:-/opt/agint}"

# dsh 装到数据盘，不是镜像可写层
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-${PERSIST}/dsh-install}"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

export DSH_VERSION="${DSH_VERSION:-0.1.2-alpha.5}"

HOST="${DSH_HOST:-0.0.0.0}"
PORT="${DSH_PORT:-3080}"
TRUSTED_HOSTS="${DSH_TRUSTED_HOSTS:-localhost:${PORT},127.0.0.1:${PORT}}"

mkdir -p "$NPM_CONFIG_PREFIX" "$DSH_HOME" "$AGINT_HOME"

# ── 1. 装 dsh（幂等）────────────────────────────────────────────────
# 装到 $NPM_CONFIG_PREFIX 而不是镜像默认的 /usr/local/lib/node_modules。
# 容器删了/重建镜像/换台机器，只要 /persist 在，dsh 就还在。
DSH_BIN="$NPM_CONFIG_PREFIX/bin/dsh"
need_install=0
if [ ! -x "$DSH_BIN" ]; then
  need_install=1
else
  if ! "$DSH_BIN" --version 2>/dev/null | grep -q "$DSH_VERSION"; then
    log "dsh 已存在但版本对不上（want=$DSH_VERSION），重装"
    need_install=1
  fi
fi
if [ "$need_install" = 1 ]; then
  log "安装 dsh@${DSH_VERSION} → ${NPM_CONFIG_PREFIX}/"
  npm install -g --prefix "$NPM_CONFIG_PREFIX" --no-fund --no-audit "@deepseek-ai/dsh@${DSH_VERSION}"
fi
log "dsh: $("$DSH_BIN" --version 2>/dev/null | head -1)"

# ── 2. 首次：让 dsh 生成 web profile ────────────────────────────────
if [ ! -d "$DSH_HOME/profiles/web" ]; then
  log "首次启动：初始化 web profile ..."
  dsh --profile web --dump-config >/dev/null 2>&1 || true
fi

# ── 3. 同步 AGINT（preset + 23 个插件 + cordis.patch.yml）───────────
# AGINT_HOME 双语义：install.sh 期望它指"源码"，dsh 期望它指"数据"。
# 容器里拆成两个：源码在 $AGINT_SRC（/opt/agint），数据在 $AGINT_HOME（/persist/agint-data）。
if [ -f "$AGINT_SRC/install/install.sh" ]; then
  log "同步 AGINT 插件 → $DSH_HOME"
  AGINT_HOME="$AGINT_SRC" bash "$AGINT_SRC/install/install.sh" --force || \
    log "install.sh 返回非零（继续，可能是 zod bootstrap 跳过 — 见下一步）"
fi

# ── 4. 补 zod 到 $DSH_HOME（数据盘）──────────────────────────────
# 镜像里不预置 zod —— 让它在 entrypoint 阶段按需装、同样装到数据盘。
ZOD_VERSION=4.5.4
ZOD_DST_WEB="$DSH_HOME/profiles/web/node_modules/zod"
ZOD_DST_Q="$DSH_HOME/profiles/web/plugins/agint-quality/node_modules/zod"
for dst in "$ZOD_DST_WEB" "$ZOD_DST_Q"; do
  if [ ! -f "$dst/package.json" ] || [ ! -f "$dst/index.js" ]; then
    log "补 zod@$ZOD_VERSION 到 $dst"
    mkdir -p "$(dirname "$dst")"
    # 用 --prefix 在目标位置直接装，避免拷贝不全
    npm install --prefix "$(dirname "$dst")" --no-fund --no-audit --no-save "zod@$ZOD_VERSION"
  fi
done

# ── 5. 拉起 web 服务 ───────────────────────────────────────────────
args=(web --host "$HOST" --port "$PORT" --no-open)
if [ -n "$TRUSTED_HOSTS" ]; then
  IFS=',' read -ra hosts <<< "$TRUSTED_HOSTS"
  for h in "${hosts[@]}"; do
    h="$(echo "$h" | tr -d '[:space:]')"
    [ -n "$h" ] && args+=(--trusted-host "$h")
  done
fi
log "启动 dsh web: 监听 $HOST:$PORT，浏览器进 ${TRUSTED_HOSTS}"
exec dsh "${args[@]}"
