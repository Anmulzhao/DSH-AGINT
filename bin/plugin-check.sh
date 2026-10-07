#!/usr/bin/env bash
# AGINT 插件准入校验（lint 模式，不阻断只警告）
# 规范：docs/plugins/PLUGIN-SPEC.md
# 用法：bin/plugin-check.sh <plugin-dir> [<plugin-dir> ...]
#       bin/plugin-check.sh --all     # 扫所有 ~/.dsh/profiles/web/plugins/agint-*

set -uo pipefail

PLUGINS_ROOT="${DSH_PLUGINS_ROOT:-$HOME/.dsh/profiles/web/plugins}"
# 仓内兜底：如果运行时副本不存在，从 bin/.. 找 plugins/（CI / 本地 lint 友好）
if [ ! -d "$PLUGINS_ROOT" ]; then
  _repo_root="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
  if [ -d "$_repo_root/plugins" ]; then
    PLUGINS_ROOT="$_repo_root/plugins"
  fi
fi
SPEC_URL="docs/plugins/PLUGIN-SPEC.md"

# 颜色（终端支持时）
if [ -t 1 ]; then RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; RST=$'\033[0m'
else RED=''; YEL=''; GRN=''; RST=''
fi

log_warn() { printf '%s[WARN]%s %s\n' "$YEL" "$RST" "$*"; }
log_err()  { printf '%s[FAIL]%s %s\n' "$RED" "$RST" "$*"; }
log_ok()   { printf '%s[ OK]%s %s\n' "$GRN" "$RST" "$*"; }

# 检查单个插件目录
check_one() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  [[ "$name" == *.bak-* ]] && { log_ok "$name (backup, skipped)"; return 0; }

  local fails=0 warns=0
  echo
  echo "─── $name ───"

  local mf="$dir/manifest.json"
  if [ -f "$mf" ]; then
    log_ok "manifest.json 存在"
  else
    log_err "manifest.json 缺失"
    fails=$((fails + 1))
  fi

  local pkg="$dir/package.json"
  if [ -f "$pkg" ]; then
    log_ok "package.json 存在"
  else
    log_err "package.json 缺失"
    fails=$((fails + 1))
  fi

  local rdm="$dir/README.md"
  if [ -f "$rdm" ]; then
    log_ok "README.md 存在"
  else
    log_warn "README.md 缺失（维度 7 docs）"
    warns=$((warns + 1))
  fi

  local cl="$dir/CHANGELOG.md"
  if [ -f "$cl" ]; then
    log_ok "CHANGELOG.md 存在"
  else
    log_warn "CHANGELOG.md 缺失（维度 8 changelog）"
    warns=$((warns + 1))
  fi

  local test_entry
  test_entry="$(jq -r '.tests.entry // empty' "$mf" 2>/dev/null || true)"
  if [ -z "$test_entry" ]; then
    test_entry="test/smoke.mjs"  # 兜底：旧 manifest 缺 tests.entry
  fi
  local test="$dir/$test_entry"
  if [ -f "$test" ]; then
    log_ok "tests.entry=$test_entry 存在"
  else
    log_warn "tests.entry=$test_entry 缺失（维度 6 tests）"
    warns=$((warns + 1))
  fi

  # ── 维度 9: runtime-contract ──
  # Cordis waterfall 监听契约扫描 —— 防止坏监听器静默吞掉瀑布结果
  # （2026-09 智进 + DSH web 全栈工具崩盘事故根因）
  #
  # waterfall 事件：监听器必须调 next() 把链传下去，否则 dsh-tools 读
  # decision.kind 时 undefined。坏写法 `ctx.on('tools/post-execute', () => {})`
  # 在挂载阶段不报错（loader 不知道该事件是不是 waterfall），但运行时把所有
  # 工具调用炸成 `Cannot read properties of undefined (reading 'kind')`。
  local lib="$dir/lib/index.js"
  if [ -f "$lib" ]; then
    # 已知 waterfall 事件名（DSH 文档声明）。新增 waterfall 事件时同步更新。
    # 用 perl 一次性扫两类违例（不需要 ripgrep，perl 在 Win/Mac/Linux 都有）
    #   1. 体为空 / 不调 next 的监听器（=> {...} / => async (...) => {...}）
    #   2. 体非空但完全没 next( 调用
    local perl_out
    perl_out="$(perl -0777 -ne '
      my $file = $ARGV;
      my @hits;
      while (m{
        ctx\.on\(\s*['"'"'\"](
          tools/(?:pre-execute|post-execute|ptc-dispatch-log)
          | agent/pre-step
        )['"'"'\"]
        \s*,\s*(async\s+)?
        (?:\(([^)]*)\)|(\w+))
        \s*=>\s*\{((?:[^{}]|\{[^{}]*\})*)\}
      }gxs) {
        my ($evt, $async, $args1, $argname, $body) = ($1, $2, $3, $4, $5);
        my $args = defined($args1) ? $args1 : $argname;
        # next 必须以独立 token 出现，避免误中 nextStep / nextTick 等
        my $has_next = ($body =~ /\bnext\s*\(/);
        my $trim = $body; $trim =~ s/^\s+|\s+$//g;
        my $empty = ($trim eq "");
        if ($empty) {
          push @hits, sprintf("EMPTY: %s (args: %s)\n", $evt, $args);
        } elsif (!$has_next) {
          push @hits, sprintf("NO_NEXT: %s (args: %s)\n  body: %s\n", $evt, $args, $body);
        }
      }
      if (@hits) { print "RUNTIME_CONTRACT_FAIL\n", @hits; }
      else { print "RUNTIME_CONTRACT_OK\n"; }
    ' "$lib" 2>/dev/null)"
    local first_line
    first_line="$(echo "$perl_out" | head -n1)"
    if [ "$first_line" = "RUNTIME_CONTRACT_OK" ]; then
      log_ok "runtime-contract: 所有 waterfall 监听器符合契约"
    elif [ "$first_line" = "RUNTIME_CONTRACT_FAIL" ]; then
      log_err "维度 9 runtime-contract 违例："
      echo "$perl_out" | tail -n +2 | sed 's/^/    /'
      fails=$((fails + 1))
    else
      log_warn "未装 perl，跳过维度 9 runtime-contract 深度扫描"
    fi
  fi

  # ── 深度校验（manifest 存在时跑）──
  # Sprint 10 #6 收口：双兼容 .spec.* 和顶层（仓内不一致，老插件用 spec 包裹，Sprint 10 新插件用顶层）
  # 见 reviews/2026-08-30-周复盘.md 与 Sprint 10 #4 收口报告
  if [ -f "$mf" ] && command -v jq >/dev/null 2>&1; then
    # 1. contract — 兼容 .spec.cordis.* 与顶层 cordis.*
    # 注：jq `or` 在第一个为 false 时不返第二个，需用 if-then-else。
    if ! jq -e 'if (.spec.cordis.inject != null and .spec.cordis.provides != null) then true elif (.cordis.inject != null and .cordis.provides != null) then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 cordis.inject + cordis.provides（维度 1 contract）"
      warns=$((warns + 1))
    fi
    # 2. storage — 兼容 .spec.storage.domains 与顶层 storage.domains
    # 空数组 = 0 域合法（无状态 plugin 如 sandbox / cron helper），不报 WARN。
    if ! jq -e 'if (.spec.storage.domains | type == "array") then true elif (.storage.domains | type == "array") then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 storage.domains 数组（维度 2 storage）"
      warns=$((warns + 1))
    fi
    # 3. deps — 兼容 .spec.dependencies 与顶层 dependencies
    if ! jq -e 'if (.spec.dependencies != null) then true elif (.dependencies != null) then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 dependencies（维度 3 deps）"
      warns=$((warns + 1))
    fi
    # 4. permissions — 兼容 .spec.permissions 与顶层 permissions
    if ! jq -e 'if (.spec.permissions != null) then true elif (.permissions != null) then true else false end' "$mf" >/dev/null 2>&1; then
      log_warn "manifest 缺 permissions（维度 4 permissions）"
      warns=$((warns + 1))
    fi
    # 5. lifecycle — 静态扫 setInterval / setTimeout 看有没有注册 disposer
    if [ -f "$lib" ]; then
      local has_interval=false has_disposer=false
      grep -qE 'setInterval|setTimeout' "$lib" 2>/dev/null && has_interval=true
      grep -qE 'ctx\.effect|\.dispose' "$lib" 2>/dev/null && has_disposer=true
      if $has_interval && ! $has_disposer; then
        log_warn "lib/index.js 用了 setInterval/setTimeout 但没看到 ctx.effect dispose（维度 5 lifecycle）"
        warns=$((warns + 1))
      else
        log_ok "lifecycle: disposer 已注册或未发现裸 timer"
      fi
    fi

    # ── 维度 5.5 (soft warning, v0.4 新增): 跨平台 fixture ──
    # plugin 的 permissions.fs 非空时，建议 smoke 含 forward-slash + native-sep
    # 路径 case。避免「Linux 写 Windows 跑」的跨平台路径 bug 漏到 prod
    # （参考 agint-wiki v0.4 教训 docs/lessons/v0.4-wiki-windows-path-escape.md）。
    local fs_perm
    fs_perm="$(jq -r 'if (.spec.permissions.fs != null) then (.spec.permissions.fs | join(",")) elif (.permissions.fs != null) then (.permissions.fs | join(",")) else "" end' "$mf" 2>/dev/null || true)"
    if [ -n "$fs_perm" ]; then
      local test="$dir/$test_entry"
      if [ -f "$test" ]; then
        local has_fwd has_evil
        has_fwd="$(grep -cE "['\"][a-zA-Z0-9_./-]*[a-zA-Z0-9_.-]+\.md['\"]" "$test" 2>/dev/null || true)"
        has_evil="$(grep -cE '\.\./' "$test" 2>/dev/null || true)"
        if [ "${has_fwd:-0}" -lt 1 ] || [ "${has_evil:-0}" -lt 1 ]; then
          log_warn "permissions.fs 非空但 smoke 缺跨平台 fixture（建议加 forward-slash 路径 + ../escape 负向 case，详见 plugin-preflight 第 2 步补强）"
          warns=$((warns + 1))
        fi
      fi
    fi
  elif [ -f "$mf" ] && ! command -v jq >/dev/null 2>&1; then
    log_warn "未装 jq，跳过 manifest 深度校验"
  fi

  # ── 维度 10 (soft warning, 2026-09-09 提案 57541772): 文档-代码公式一致性 ──
  # plugin 的 README.md / CHANGELOG.md 写了加权合成公式，但 plugins/ 全仓
  # 无对应实现代码——属"schema only"型脱节。读者照公式找代码会落空。
  # 触发背景：HARM 加权公式 0.2·H + 0.3·A + 0.3·R + 0.2·M 在 4 处文档命中，
  # plugins/ 0 实现（policy 决策走 quality-eval 5 维加权）。
  # 检测委托给 node bin/_verify-dim10.mjs（自实现 JS 正则遍历，advisory）。
  # 独立于 jq 块（dim10 不需要 jq，node 即可）。
  # 路径：用 BASH_SOURCE 拿 plugin-check.sh 自身位置，避免 $0 被外部传入相对路径
  if command -v node >/dev/null 2>&1; then
    local dim10_script_self="${BASH_SOURCE[0]:-$0}"
    local dim10_script_dir
    dim10_script_dir="$(cd "$(dirname "$dim10_script_self")" 2>/dev/null && pwd)"
    local dim10_script="${dim10_script_dir}/_verify-dim10.mjs"
    if [ -f "$dim10_script" ]; then
      # MSYS 路径 → Windows 路径（避免 node 报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
      # 注意：node 不能用带反斜杠的路径配 forward-slash cwd，bash 反斜杠吃转义
      # → 一律用 cygpath -w 转 Windows 反斜杠路径，但 node 在 Windows 原生下可直接吃
      # → 实测：传 forward-slash 路径 + 用 //D:/... 形式最稳
      local dim10_msys=""
      if command -v cygpath >/dev/null 2>&1; then
        dim10_msys="$(cygpath -w "$dim10_script" 2>/dev/null || printf '%s' "$dim10_script")"
      else
        dim10_msys="$dim10_script"
      fi
      # 不 cd 到 pluginDir（避免 cwd 改变后 node 路径被 bash 反斜杠转义吃错）
      # node 脚本内部自己用 resolve(pluginDir) 即可
      local dim10_out
      dim10_out="$(node "$dim10_msys" "$dir" 2>&1)" || true
      if [ -n "$dim10_out" ]; then
        local dim10_warn_count
        dim10_warn_count="$(printf '%s\n' "$dim10_out" | grep -c '^\s*\[WARN\]' || true)"
        if [ "${dim10_warn_count:-0}" -gt 0 ]; then
          log_warn "维度 10 文档-代码脱节：${dim10_warn_count} 处公式在 README/CHANGELOG 但 plugins/ 无对应实现（详见下方 + bin/_verify-dim10.mjs）"
          printf '%s\n' "$dim10_out" | sed 's/^/    /'
          warns=$((warns + dim10_warn_count))
        fi
      fi
    fi
  fi

  # ── 维度 11 (soft warning, 2026-09-29 提案): observability-reachability ──
  # 第 3 层「观测侧假绿」：service 可以在返回值上挂诊断字段，工具的 render 却
  # 不必消费它——这个差集没有任何检查覆盖，于是「算出来了但看不见」。
  # 实例（2026-09-29 实测，6e2992f 修复前）：lib/gateway.js 把 channel 自报的
  # status / initError / queuedSignals / detectors 挂到 result.health，而
  # input_gateway_channel_status 的 render 只拼 channelId / type / enabled /
  # quota / lastFetch / counters / lastError，不读 v.health —— health.initError
  # 在工具输出里不可见，「订阅失败」与「订阅成功」的输出完全一致。
  #
  # 先只查高危字段：挂上返回值的目的就是被人或被模型看见，没人消费几乎总是
  # bug。全字段差集 + 忽略名单（`_` 前缀 / 调试透传 / 内部字段）留到下一步；
  # 本维度定位是「抓明显的漏」而非完备证明——跨文件 service 方法、运行时拼装
  # 的返回对象会漏检，结论表述不能夸大。warn 不设 fail。
  # 参考：wiki/AGINT/观测侧假绿-识别与排查.md
  if command -v node >/dev/null 2>&1 && [ -d "$dir/lib" ]; then
    local dim11_out
    dim11_out="$(
      PLUGIN_DIR="$dir" node 2>/dev/null <<'DIM11_JS' || true
        const fs = require("fs"), path = require("path");
        const dir = process.env.PLUGIN_DIR || "";
        const lib = path.join(dir, "lib");
        if (!fs.existsSync(lib)) process.exit(0);

        // 高危字段：这些字段挂上返回值的目的就是被看见，没被 render 消费几乎总是 bug
        const HIGH_RISK = new Set([
          "health", "diagnostics", "diagnostic", "initError", "lastError",
          "counters", "quota", "usage", "errors", "warnings", "metrics", "alerts"
        ]);

        const files = [];
        (function walk(d) {
          let entries = [];
          try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
          for (const e of entries) {
            if (e.name === "node_modules" || e.name.charAt(0) === ".") continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
          }
        })(lib);

        const lineOf = (t, i) => t.slice(0, i).split("\n").length;
        const blockAt = (t, from) => {
          const i = t.indexOf("{", from);
          if (i < 0) return null;
          let depth = 0;
          for (let j = i; j < t.length; j++) {
            if (t[j] === "{") depth++;
            else if (t[j] === "}" && --depth === 0) return t.slice(i, j + 1);
          }
          return null;
        };

        // (1) service 侧产出：execute 返回对象上挂的字面量字段
        //     a) result.<field> = ...   b) return { field, ... }
        const produced = new Map();
        const sources = [];
        const note = (site, field) => {
          if (!produced.has(field)) produced.set(field, []);
          produced.get(field).push(site);
        };
        for (const f of files) {
          const t = fs.readFileSync(f, "utf8");
          sources.push({ f: f, t: t });
          let m;
          const reAssign = /\bresult\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g;
          while ((m = reAssign.exec(t)) !== null) {
            note(path.relative(dir, f) + ":" + lineOf(t, m.index), m[1]);
          }
          const reReturn = /\breturn\s*\{([^{}]*)\}/g;
          while ((m = reReturn.exec(t)) !== null) {
            for (const raw of m[1].split(",")) {
              const piece = raw.trim();
              if (!piece || piece.slice(0, 3) === "...") continue;
              const key = piece.split(":")[0].trim();
              if (/^[A-Za-z_$][\w$]*$/.test(key)) {
                note(path.relative(dir, f) + ":" + lineOf(t, m.index), key);
              }
            }
          }
        }
        if (produced.size === 0) process.exit(0);

        // (2) render 侧消费：任何 defineTool 的 render 体里读到的字段
        const rendered = new Set();
        for (const src of sources) {
          const t = src.t;
          const reTool = /\bdefineTool\s*\(/g;
          let tm;
          while ((tm = reTool.exec(t)) !== null) {
            const body = blockAt(t, tm.index + tm[0].length);
            if (!body) continue;
            const reRender = /(?:^|[\s,{])render\s*[:(]/g;
            let rm;
            while ((rm = reRender.exec(body)) !== null) {
              const rbody = blockAt(body, rm.index + rm[0].length);
              if (rbody) {
                const reRead = /[A-Za-z_$][\w$]*\s*\.\s*([A-Za-z_$][\w$]*)/g;
                let pm;
                while ((pm = reRead.exec(rbody)) !== null) rendered.add(pm[1]);
              }
              // render({ a, b }) 形状的解构参数也算消费
              const sig = body.slice(rm.index, rm.index + 240);
              const dm = /\(\s*\{([^{}]*)\}/.exec(sig) || /[:(]\s*\{([^{}]*)\}/.exec(sig);
              if (dm) {
                for (const raw of dm[1].split(",")) {
                  const key = raw.split(":")[0].replace(/=.*$/, "").trim();
                  if (/^[A-Za-z_$][\w$]*$/.test(key)) rendered.add(key);
                }
              }
            }
          }
        }

        // (3) 差集：service 产出了、但全插件没有任何 render 读过的字段
        const out = [];
        for (const [field, sites] of produced) {
          if (!HIGH_RISK.has(field) || rendered.has(field)) continue;
          const shown = sites.slice(0, 3).join(", ");
          out.push(field + " <- " + shown + (sites.length > 3 ? " (+" + (sites.length - 3) + " more)" : ""));
        }
        out.sort();
        if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
DIM11_JS
    )"
    if [ -n "$dim11_out" ]; then
      local dim11_n
      dim11_n="$(printf '%s\n' "$dim11_out" | grep -c '[^[:space:]]' || true)"
      log_warn "维度 11 observability-reachability：${dim11_n} 个高危字段 service 返回里有、但没有任何 tool render 消费（详见下方 + wiki/AGINT/观测侧假绿-识别与排查.md）"
      printf '%s\n' "$dim11_out" | sed 's/^/    /'
      warns=$((warns + dim11_n))
    fi
  fi

  # 汇总
  if [ "$fails" -gt 0 ]; then
    printf '  → %s%d fail%s, %d warn\n' "$RED" "$fails" "$RST" "$warns"
    return 1
  elif [ "$warns" -gt 0 ]; then
    printf '  → 0 fail, %s%d warn%s\n' "$YEL" "$warns" "$RST"
    return 0
  else
    log_ok "11 维度全过（含维度 11 observability-reachability）"
    return 0
  fi
}

# ── K19 schema 护栏（2026-09-09 加入）──
# 背景：工具参数里每个 `type: "object"` 都必须显式声明 additionalProperties，
# 否则 dsh 的 ajv 严格模式会拒绝挂载**整条 preset**，UI 只冒泡成一句
# "Failed to fetch"，排查成本极高（2026-09-09 实测，dsh 直接起不来）。
#
# 为什么挂在这里：护栏「写了但没人跑」等于没写——这正是 K19 当初翻车的根因
# （约定早已写在文件头注释里，但没有自动校验，照样漏）。接入 plugin-check
# 让它每次准入检查都自动跑一遍。默认扫 $PLUGINS_ROOT（宿主运行副本，真正被
# dsh 加载的那份）；可用 K19_SCAN_ROOT 覆盖。
k19_guard() {
  local repo_root out
  repo_root="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"

  # MSYS 的 /c/... /d/... 这类路径 Windows 原生 node 解析不了（会当相对路径，
  # 报 "Cannot find module"），传给 node 前一律 cygpath 转成 C:\... D:\...
  local to_win='printf %s'
  command -v cygpath >/dev/null 2>&1 && to_win='cygpath -w'

  local guard_msys="$repo_root/test/schema-guard.test.mjs"
  if [ ! -f "$guard_msys" ]; then
    log_warn "未找到 test/schema-guard.test.mjs，跳过 K19 护栏"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    log_warn "未装 node，跳过 K19 护栏"
    return 0
  fi
  local guard
  guard="$($to_win "$guard_msys" 2>/dev/null)" || guard="$guard_msys"

  local scan_root="$PLUGINS_ROOT"
  if command -v cygpath >/dev/null 2>&1; then
    scan_root="$(cygpath -w "$PLUGINS_ROOT" 2>/dev/null || printf '%s' "$PLUGINS_ROOT")"
  fi

  echo
  echo "─── K19 schema 护栏（扫描 $scan_root）───"
  if out="$(K19_SCAN_ROOT="$scan_root" node --test "$guard" 2>&1)"; then
    log_ok "所有 object schema 均已显式声明 additionalProperties"
  else
    log_err "K19 违例：存在未声明 additionalProperties 的 object schema（会导致 preset 挂载失败）"
    printf '%s\n' "$out" | grep -E ':[0-9]+[[:space:]]*$' | sed 's/^/    /' | head -20
    printf '%s\n' "$out" | sed -n '/未声明 additionalProperties 的 object schema/,/^$/p' | sed 's/^/    /' | head -30
  fi
  return 0
}

# 主逻辑
case "${1:-}" in
  --help|-h)
    cat <<EOF
Usage: plugin-check.sh [--all | <plugin-dir>...]

ENV:
  DSH_PLUGINS_ROOT   default \$HOME/.dsh/profiles/web/plugins
  K19_SCAN_ROOT      K19 schema 护栏的扫描根（默认随 DSH_PLUGINS_ROOT）

Lint 模式：失败/警告都不阻断，只列缺失项。
详见 $SPEC_URL
EOF
    ;;
  --all|"")
    shift || true
    k19_guard
    if [ -d "$PLUGINS_ROOT" ]; then
      for d in "$PLUGINS_ROOT"/agint-*/; do
        [ -d "$d" ] || continue
        check_one "$d" || true
      done
    fi
    ;;
  *)
    for d in "$@"; do
      check_one "$d" || true
    done
    ;;
esac

echo
echo "─── plugin-check 完成（lint 模式，不阻断） ───"

# ── L0 FROZEN 契约门禁 ──────────────────────────────────────────────────────
# 这条**阻断**（上面的 lint 不阻断，是两回事）。
# AGENTS.md 与 docs/evolution-framework.md §8.2 都写「CI 任务检测到 L0 字段修改
# 自动失败」，但该检测此前从未实现 —— bin/ 下无任何脚本 grep FROZEN、
# .github/workflows 目录不存在，即这条护栏是纸面约定。
# 现在补上：FROZEN 契约被改动 ⇒ exit 1。
# 放行只能显式 `node bin/check-l0-frozen.mjs --update`，且那仍需人类多签 +
# 7 天影子 + major 版本 —— 本检查替代不了多签，只替代「没人发现」。
L0_SCRIPT="$(dirname "$0")/check-l0-frozen.mjs"
if [ -f "$L0_SCRIPT" ]; then
  echo
  echo "─── L0 FROZEN 契约检查 ───"
  if command -v node >/dev/null 2>&1; then
    if node "$L0_SCRIPT"; then
      echo "  [PASS] L0 FROZEN 契约未变更"
    else
      echo "  [FAIL] L0 FROZEN 契约被改动（见上方明细）—— 这是 L0 变更，需人类多签 + 7 天影子 + major 版本"
      exit 1
    fi
  else
    # 2026-10-07 改 fail-closed：这是真阻断位，无 node 的机器上跳过 = 门禁形同虚设
    # （L0 契约被改了照样全绿 exit 0）。宁可拒跑逼环境修好，不放行假绿。
    echo "  [FAIL] node 不可用，L0 检查无法执行 —— 拒绝放行（fail-closed）"
    exit 1
  fi
fi

# ── addFailure 值域门禁（阻断） ─────────────────────────────────────────────
# 2026-10-06 老板拍板 §6-3 接入。背景（docs/立项-失败供料通道修复-20261006.md）：
# 全仓曾有多少个越界字面量就丢多少条静默供料（14 调用点 7 死）。evolution-memory
# 0.6.14 已在入口归一化兜底，这条门禁防**复发**：新调用点传映射表外的值 ⇒ 阻断，
# 逼作者把它加进 FAILURE_CATEGORY_MAP（语义决策）而不是靠兜底静默吞进 other 桶。
AF_SCRIPT="$(dirname "$0")/check-addfailure-callers.mjs"
if [ -f "$AF_SCRIPT" ]; then
  echo
  echo "─── addFailure 值域检查 ───"
  if command -v node >/dev/null 2>&1; then
    if node "$AF_SCRIPT"; then
      echo "  [PASS] addFailure 调用点值域全部在 枚举∪映射表 内"
    else
      echo "  [FAIL] 存在越界 category/severity 字面量（见上方明细）—— 新增语义请进 FAILURE_CATEGORY_MAP 并经老板认可，或改用既有枚举值"
      exit 1
    fi
  else
    # 2026-10-07 改 fail-closed（同上 L0 段理由）：无 node = 检查跑不了 = 拒绝放行
    echo "  [FAIL] node 不可用，addFailure 值域检查无法执行 —— 拒绝放行（fail-closed）"
    exit 1
  fi
fi
