---
name: github-push
description: "把 AGINT 仓库（或本机任何 git 仓库）推送到 GitHub 的专用流程。本机 GitHub 被墙（直连 RST），必须走 ghelper PAC 真实代理。触发场景：任何 git push / git clone / 访问 GitHub API / 建仓 / 发 Release 时网络不通或失败，或用户提到 push、上传到 GitHub、同步远程仓库。"
---

# GitHub 推送（ghelper 代理通道）

本机网络约束：直连 `api.github.com` / `github.com` 被 TCP RST 阻断；
clash 订阅节点对第三方客户端返回 403；**唯一可用路径是 ghelper 扩展 PAC 脚本里的
真实 HTTPS 代理**（华为系 CDN 域名，国内可直连）。

## 目标仓库

- 远程：`https://github.com/Anmulzhao/DSH-AGINT.git`（公开）
- 本地：`~/projects/AGINT/`，remote `origin` 已配置（URL 内嵌 Basic auth）
- 全局 git config 有 `url.https://ghfast.top/https://github.com/.insteadof`
  rewrite —— **push 时必须用 `GIT_CONFIG_GLOBAL=/dev/null` 绕过**，
  否则请求被导到被封的镜像，报 `Recv failure: 连接被对方重置`。

## 标准推送流程

```sh
cd ~/projects/AGINT
PX="https://90759cff-tjx8g0-tjzkss-9l4u.sj7.cdnkuaishou.com:443"   # ghelper 真实代理
PAT=$(git config --global --get github.token)

# push 主分支
GIT_CONFIG_GLOBAL=/dev/null GIT_SSL_NO_VERIFY=1 git -c http.proxy="$PX" push origin main

# 有 tag 变更时
GIT_CONFIG_GLOBAL=/dev/null GIT_SSL_NO_VERIFY=1 git -c http.proxy="$PX" push origin <tag名>

# 需要 force push（重写历史）时加 --force：
GIT_CONFIG_GLOBAL=/dev/null GIT_SSL_NO_VERIFY=1 git -c http.proxy="$PX" push --force origin main
```

## 验证

push 成功后用 API 确认线上状态（走同一代理）：

```sh
curl -s -x "$PX" --proxy-insecure -H "Authorization: token $PAT" \
  "https://api.github.com/repos/Anmulzhao/DSH-AGINT/commits?per_page=5" | \
  python3 -c "import json,sys; [print(c['sha'][:8], c['commit']['message'].split(chr(10))[0]) for c in json.load(sys.stdin)]"
```

## 代理节点失效时自救

PAC 脚本存在 ghelper 扩展的 LevelDB 存储里，双重 base64 编码：

```sh
DB="$HOME/.config/google-chrome-debug/Default/Local Extension Settings/<ghelper扩展id>/"
# 从 000024.log / 000026.ldb 里提取 "data":"<base64>"，双重 base64 解码得 PAC
# PAC 中 var proxy="HTTPS <uuid>.cdnkuaishou.com:443;..." 即代理列表，取第一个可用
```

节点是否可用：`curl -s -x "https://<节点>:443" --proxy-insecure -o /dev/null -w "%{http_code}" https://api.github.com/`，200/401/404 都说明链路通。

## API 注意事项（偶尔踩到）

- `POST /user/repos`（建仓）偶尔返回 503 `No server is currently available` —— 重试即可，读操作（GET）稳定
- git 协议（push/ls-remote）比 REST API 稳定，优先用 git
- 认证方式：git 用 URL 内嵌 Basic auth（`https://x:${PAT}@...`）；API 用 `Authorization: token $PAT`

## 仓库纪律

- **排障/过程文档（PUSH.md、网络记录、订阅 URL）不进 GitHub** —— 沉淀到本地 wiki（`AGINT/GitHub-发布与网络路径.md`）和 memory
- 公开仓库只放框架本体：docs/install/plugins/presets/profile-patches + 顶层说明文件
- `*.bundle` 已 gitignore，不进版本控制
