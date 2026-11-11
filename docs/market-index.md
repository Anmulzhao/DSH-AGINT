# AGINT 插件市场索引（market-index.json）

> 2026-11-08 建立。格式 = dsh 官方**插件市场索引格式 1**。
> 校验器：`@deepseek-ai/dsh-plugin-market-index`（随 dsh 宿主 0.2.2-rc.1 分发）。
> 2026-11-08 19:30 订正：主地址由 GitHub raw 换为 `fastly.jsdelivr.net`。原因见「可达性实测」。

## 索引地址

| 用途 | URL | 本机实测 |
| --- | --- | --- |
| **主地址（填这个）** | `https://fastly.jsdelivr.net/gh/Anmulzhao/DSH-AGINT@main/market-index.json` | HTTP 200 |
| 备用地址 | `https://gcore.jsdelivr.net/gh/Anmulzhao/DSH-AGINT@main/market-index.json` | HTTP 200 |
| 仓库原始地址 | `https://raw.githubusercontent.com/Anmulzhao/DSH-AGINT/main/market-index.json` | `ECONNRESET`，本机不可达 |

在 dsh 设置页的「插件市场 → 已添加的索引源 → 添加」，填入**主地址**。
dsh 会读索引、列出 `@agint/host`，再由 `plugin_manager install_bundle` 安装。

> 三个 URL 返回同一份文件。2026-11-08 逐一比对 md5，全部为
> `ac1f148947c5f98b7c6979fe6ee5528f`。区别只在本机能否连上，不在内容。

## 当前条目

| 字段 | 值 | 说明 |
| --- | --- | --- |
| 包名 | `@agint/host` | 合法 npm 包名，也是 dsh bundle 名 |
| 版本 | `0.26.0` | 与 `package.json` / `VERSION` 表 / `AGENTS.md` 四处一致 |
| `publishTimestamp` | `1794136007` | 阶段 A 提交时间，Unix 秒 |
| 源类型 | `git` | 不依赖 npm registry，不需要发布 npm 包 |
| 固定 commit | `2a24b8347e6e16151a460082b0fec09db934051c` | 该提交的 `package.json` 已是 `0.26.0` / `private:false` |
| 生成安装参数 | `git+https://github.com/Anmulzhao/DSH-AGINT.git#2a24b8347e6e16151a460082b0fec09db934051c` | 由 `marketInstallTarget()` 实跑产出 |

**为什么 commit 不指向含索引的那个提交**：索引文件无法把自己的 SHA 写进自己。
所以索引固定到「阶段 A」提交 —— 那次提交已包含全部运行时代码与正确的版本号。
后续只加索引与文档的提交不改变运行时内容。

## 可达性实测（2026-11-08）

宿主添加原始地址时报 `Could not fetch ...: fetch failed: read ECONNRESET`。
用 Node `fetch`（与 dsh 宿主同款 undici 网络栈）复现，报错逐字一致。

| 主机 | curl | Node fetch | 判定 |
| --- | --- | --- | --- |
| `raw.githubusercontent.com` | 000 | `ECONNRESET` | 原始地址，出口被重置 |
| `cdn.jsdelivr.net` | 000 | — | jsDelivr 主域名同样被重置 |
| `fastly.jsdelivr.net` | 200 | 200 | **可用，定为主地址** |
| `gcore.jsdelivr.net` | 200 | 200 | 可用，定为备用 |
| `raw.gitmirror.com` | 000 | — | 镜像不可达 |
| `github.com` 的 raw 路径 | 000 | — | 会跳转到 GitHub raw |
| `anmulzhao.github.io` | 404 | — | Pages 未启用 |

两个可用域名的响应头一致：HTTP 200 无重定向、`Content-Type: application/json; charset=utf-8`、
`Access-Control-Allow-Origin: *`。宿主索引源 fetch 用 `redirect:"manual"` 且只接受同源跳转。
这里直接 200，符合。

**结论**：`ECONNRESET` 是网络出口问题，不是文件格式或字段错误。
换一条可达的静态托管域名即可。索引内容不用改，官方校验器对远端取回的内容同样 PASS。

> ⛔ 别把 URL 改成 `@v0.26.0` 之类的 tag 版本，实测 404。`v0.26.0` tag 指向 `aaec68b`，
> 早于 `market-index.json` 的引入提交 `c25f65e`，那个版本里根本没有这个文件。
> 想规避 CDN 缓存请用下面的 purge 纪律，不要用 tag 换 URL。

## 校验方法

本机留了从 `app.asar` 抽出的官方校验器与可复跑脚本（工作区 `_` 前缀，不进仓库）：

```sh
node D:/DSH/_verify_market_index.mjs
```

实跑输出（两种源都验过）：

```
GIT PARSE OK -> git+https://github.com/Anmulzhao/DSH-AGINT.git#<40hex>
NPM PARSE OK -> @agint/host@0.26.0  registry https://registry.npmjs.org/
```

改索引后必须重跑校验。格式 1 的必填项包括
`format` / `plugins[].name` / `versions[].version` / `versions[].publishTimestamp` / `versions[].source`。
`publishTimestamp` 是 Unix 秒整数，范围 0 到 10^11。

## 发布纪律

1. **`private:false` 不等于已发 npm 包。** 本仓只发布了索引，`npm publish` 尚未执行。
2. 本机 npm 未登录（`npm whoami` 返回 `ENEEDAUTH`）。`npm publish` 必须由人本地执行。
3. 执行 publish 前先跑 `node bin/check-publish-safety.mjs`，退出码必须为 0。
4. **必须从干净 clone 打包。** 本机工作副本的 `plugins/` 与 `presets/` 下有 44 个未跟踪的
   `*.bak-*` 备份文件（`git ls-files` 命中 0），`files` 白名单会递归把它们带进 tarball。
   干净 clone 没有这些文件。
5. `.github/workflows/publish-safety.yml` 只跑只读门禁，**不含 publish 步骤**。本仓不做自动发布。
6. 发布新版本时同步四处：`package.json` · `VERSION` 表首行 · `AGENTS.md` 自动块 · 本索引的
   `version` 与 `source.commit`。改完重跑门禁与索引校验。
7. **主地址走 CDN，有缓存延迟。** jsDelivr 的 `@main` 返回
   `Cache-Control: public, max-age=604800, s-maxage=43200`（边缘缓存 12 小时）。
   改完索引并推送后执行
   `curl https://purge.jsdelivr.net/gh/Anmulzhao/DSH-AGINT@main/market-index.json` 刷新边缘，
   再核对返回内容的 `version` 与仓库一致。不刷新时，已添加索引的用户最长 12 小时后才看到新版。

## ⚠️ 边界（不要对外说成「一键装好」）

本索引只证明**格式合法**与**来源固定**。

我没有验证 `plugin_manager install_bundle` 能替代 `install/install.sh` 完成 AGINT 的全部部署。
`install.sh` 还额外做：铺四处部署位、注册 `dsh.profile.bundles`、写 `dependencies` 的 `link:` 条目、
建软链、preset 工具行锚定、权限声明重写、写 `profile.json`、zod bootstrap、三副本同步。
`install_bundle` 只负责「包安装 + bundle 选择」。

宿主当前未运行，本轮没有做真实安装实验。在隔离 profile 里跑通这条链路之前，
**不要把这份索引宣传为「安装完即可用」**。稳定安装入口仍是 `./install/install.sh`。

本机到 `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 不通是实测事实，宿主已复现
`ECONNRESET`。主地址已切到 `fastly.jsdelivr.net`（Node fetch 实测 200、内容 md5 一致、
官方校验器 PASS）。换网络环境后原始地址可能恢复，届时重跑上面的可达性表再决定，不要凭印象换回去。

## 相关

- 分发机制实测与判断：`D:/DSH/docs/DSH插件分发机制与AGINT接入判断-20261108.md`
- dsh 集成与七步安装：[`dsh-integration.md`](./dsh-integration.md)
- 发布门禁：[`bin/check-publish-safety.mjs`](../bin/check-publish-safety.mjs)
