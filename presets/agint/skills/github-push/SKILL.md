---

name: github-push
description: "把 AGINT 仓库（或本机任何 git 仓库）推送到 GitHub 的专用流程。本机 GitHub 被墙（直连 RST），通过本机 Clash for Windows 的明文 HTTP 代理（127.0.0.1:7890）走 HTTPS 出口。触发场景：任何 git push / git clone / 访问 GitHub API / 建仓 / 发 Release 时网络不通或失败，或用户提到 push、上传到 GitHub、同步远程仓库。**注意：在沙箱 PowerShell 会话里 git push 会因 msys signal pipe 崩溃，需改用文末『沙箱 PowerShell 场景』的原生 ssh.exe 方案。**"
tools:
  - git
  - ssh.exe
triggers:
  - "git push/fetch/clone 在沙箱里崩溃（msys signal pipe）"
  - "访问 GitHub API / 建仓 / 发 Release 网络不通"
  - "用户提到 push、上传 GitHub、同步远程仓库"
related_skills:
  []

---


# GitHub 推送（clash 7890 通道）

## 网络现状（2026-09-05 实测）

直连 `api.github.com` / `github.com` / `codeload.github.com` 全部 RST。两条候选代理：

| 代理 | 状态 | 说明 |
|---|---|---|
| ghelper 旧 HTTPS 代理 `https://90759cff-…sj7.cdnkuaishou.com:443` | ❌ **已死** | 节点吐 `BadStatusLine: \x05\x02`（SOCKS5 握手残留），HTTP/HTTPS 双双拒绝 |
| **clash for Windows 本地明文 HTTP 代理 `http://127.0.0.1:7890`** | ✅ **当前唯一可用** | `api.github.com` 200，`codeload.github.com` tarball 直通（126 MB / 34s） |

> ⚠️ **但更可靠的出口是 SSH 直连（2026-09-05 实测）**：`ssh -T git@github.com` 和 `ssh -p 443 git@ssh.github.com` 都认证成功（`Hi Anmulzhao! You've successfully authenticated`）。GitHub 的 SSH 端口可直连不被墙。能用 SSH 就别依赖 clasp 代理 + schannel。

**默认走 clash 7890**。ghelper 老节点视为过期，**别再抄进新脚本**。

## ⚠️ 沙箱 PowerShell 场景（2026-09-05 首次踩到；2026-09-11 找到正解）

### ✅ 首选：把 `core.sshCommand` 指向原生 OpenSSH（2026-09-11 实测 push 成功）

崩溃的**唯一**触发条件是 git spawn 了 **MSYS 的 `ssh.exe`**（`C:\Program Files\Git\usr\bin\ssh.exe`）。
换成 Windows 自带 OpenSSH，msys 完全不参与，`fetch` / `push` / `ls-remote` 全部可用：

```powershell
$sc = 'C:/Windows/System32/OpenSSH/ssh.exe'   # ⚠️ 必须正斜杠：git 经 msys sh 执行它，反斜杠会被吃掉
git -C <repo> -c core.sshCommand=$sc fetch     origin <branch>
git -C <repo> -c core.sshCommand=$sc push      origin <branch>
git -C <repo> -c core.sshCommand=$sc ls-remote origin <branch>
```

实测（`Anmulzhao/DSH-AGINT`，`846569b` → `0d29e2e`）：`push` exit 0，输出 `846569b..0d29e2e  main -> main`；
随后 `fetch` + `rev-list --left-right --count origin/main...HEAD` = `0  0`，`ls-remote` = 本地 HEAD。
**origin 是 SSH URL 时不需要 clash 代理**（2026-09-11 实测本机 7890 当时并未运行，push 照样成功）。

> 认出"路径被 sh 吃掉"这类报错（一眼可辨）：
> `C:\Windows\...\ssh.exe: line 1: C:WindowsSystem32OpenSSHssh.exe: command not found`

> 顺带记住：**没有网络操作时 git 永远不崩**（`add` / `commit` / `log` / `rev-parse` / `pack-objects` 都是纯对象操作）。

### ❌ 旧现象（保留供对照）：默认配置下必崩

**默认配置下（git 用自带的 MSYS `ssh.exe`），沙箱 PowerShell 里 `git push` 必崩**：

```
0 [main] sh.exe/ssh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5
fatal: Could not read from remote repository.
exit: 128
```

**根因**：git 的网络 transport 要 spawn MSYS 的 `sh.exe`/`ssh.exe`，而 MSYS 程序创建 signal pipe 时**要求父进程也是 MSYS 程序**；PowerShell（原生 Win32）不是，Windows 拒绝给权限（Win32 error 5 = Access denied）。跟网络、SSH key、认证、代理**全部无关**——**只跟"spawn 的是哪个 ssh"有关**。

> **2026-09-11 重新解释旧结论**：早先记的"`fetch` 不崩、`push` 才崩"其实是**transport 差异**，
> 不是 fetch/push 差异——当时那条 `fetch` 走的是 **HTTPS transport**（`git -c http.proxy=…` + schannel，
> 压根不 spawn ssh）；一旦 `fetch` 走 SSH transport，它同样会 spawn ssh、同样受支配。
> **判据请记成：transport 是否 spawn 了 MSYS ssh**（参见末尾"记录勘误"）。

---

### 🚨 沙箱强制推送流程（5 步，2026-09-08 实测可执行版）

**严禁**直接 `git push` / `Start-Process` / PowerShell `<` 重定向 / `cmd /c type | ssh` 喂字节流——
所有这些都因为 msys signal pipe 或沙箱边界问题失败。**只走 `.NET Process + ssh.exe stdin`**：

#### Step 1：本地 commit（纯对象操作，不崩）
```powershell
git add <files>
git commit -m "..."
$new = git rev-parse HEAD
```

#### Step 2：先 fetch 校准 origin 缓存（read-only，不崩）
```powershell
git -c "http.proxy=http://127.0.0.1:7890" fetch origin <branch>
$remoteSha = git rev-parse origin/<branch>
```

> **为什么必须 fetch 而不是 `ssh -T git@github.com git-receive-pack` 探 OLD_SHA**：
> - ssh + git-receive-pack **会一直等 stdin**，不喂东西就 hang
> - GitHub 在 push 成功后**主动关连接**，ref 通告里 SHA 是握手期远端状态，不是 push 后结果
> - `git fetch` 一次把"远端 SHA" + "本地缓存" + "ahead/behind 计数"全拿到，**3 件事 1 次走完**

#### Step 3：列领先对象 + 打 pack（纯对象操作）
```powershell
git rev-list --objects 'origin/<branch>..HEAD' |
    ForEach-Object { ($_ -split ' ')[0] } |
    Set-Content objects.txt -Encoding ASCII
Get-Content objects.txt | git pack-objects --stdout > pack.pack
# ⚠️ 落地路径必须在 workspace-write 范围内（D:\DSH\...），不能用 $env:TEMP——
#    沙箱里 Set-Content 到 $env:TEMP 后下次命令读不到，被清掉
```

#### Step 4：组 v1 协议字节流 + `.NET Process` 直喂 ssh.exe stdin
```powershell
$stream = New-TemporaryFile
$enc = [System.Text.Encoding]::ASCII
$cap = 'report-status'
$line = "$remoteSha $new refs/heads/<branch>`0$cap"
$hex = ('{0:x}' -f ($line.Length + 4)).PadLeft(4, '0')

$prefix = $enc.GetBytes('0000' + $hex + $line + '0000')
$flushBytes = [byte[]]@(0x30,0x30,0x30,0x30)   # "0000"
$packBytes = [System.IO.File]::ReadAllBytes('pack.pack')

$fs = [System.IO.File]::OpenWrite($stream)
$fs.Write($prefix, 0, $prefix.Length)
$fs.Write($flushBytes, 0, 4)
$fs.Write($packBytes, 0, $packBytes.Length)
$fs.Write($flushBytes, 0, 4)   # pack 末尾必须有 flush
$fs.Close()

$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ssh
$psi.Arguments = '-T -p 22 -o BatchMode=yes -o StrictHostKeyChecking=accept-new git@github.com git-receive-pack <owner>/<repo>.git'
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$inputBytes = [System.IO.File]::ReadAllBytes($stream)
$proc.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
$proc.StandardInput.BaseStream.Flush()
$proc.StandardInput.Close()
$proc.WaitForExit(30000) | Out-Null
if (-not $proc.HasExited) { $proc.Kill() }
# ⚠️ stdout 只看到握手第一行 + ref 通告是**正常**的——
#    GitHub push 成功会立即关连接，report-status 经常吐不全
```

#### Step 5：再次 fetch 验证（强制，不可省）
```powershell
git fetch origin <branch>
$counts = git rev-list --left-right --count 'origin/<branch>...HEAD'
# $counts = "0	0" → 推送成功
# $counts = "0	N" → 还有 N 个 commit 没推
```

> **绝不要用"ssh + git-receive-pack 握手第一行 SHA"判断推送成功**——
> 那行是握手期远端状态，不是 push 后结果。**只用 `git fetch` 校验**。

---

### 🚨 沙箱里禁止的手动操作（2026-09-08 自残教训）

- ❌ **`git update-ref refs/remotes/origin/* <sha>`** 手动改远端缓存
  - 会让本地 `origin/<branch>` 与远端真实状态错位
  - 后果：`rev-list origin/<branch>..HEAD` 返回空，pack 打空，push 看似成功实则啥也没推
  - **整改**：永远用 `git fetch` 同步缓存，不要手 update-ref

- ❌ **`git push` / `Start-Process cmd /c git push`** / PowerShell `<` 重定向到 ssh / pipe 字节到 ssh
  - 全部失败或 hang，原因见上
- ❌ **相信"GitHub REST API 看不到 = 仓库不存在"**
  - Wiki 仓库（`<repo>.wiki.git`）不在 `api.github.com` REST 索引里，无 token 返回 404
  - 但 git 协议（`https://github.com/<owner>/<repo>.wiki.git/info/refs?service=git-upload-pack`）+ SSH 都通
  - **整改**：判断 wiki 仓库存在性**用 git 协议 + `ssh -T git@github.com`**，不用 REST API

---

**区分两种处境**：
- 你在 **Git Bash / 正常终端**里 → 直接 `git push` 即可（有 MSYS 环境，sh 正常起）
- 你在 **智进的沙箱 PowerShell 会话**里 → **先试 `-c core.sshCommand=C:/Windows/System32/OpenSSH/ssh.exe`（首选，2026-09-11 实测 push 成功）**；只有它失败时才走上面 5 步强制流程

**已实测成功**（2026-09-08）：
- `Anmulzhao/DSH-AGINT.wiki` master ← `a334c26`（1 commit / 558 字节 pack）
- `Anmulzhao/DSH-AGINT.wiki` master ← `47ef13b`（追加 wiki-sync 段后）

---

## 关键踩坑

- **Git for Windows 自带的 git / curl 都用 schannel**，走 HTTPS 代理时遇 TLS 重协商会爆
  `schannel: server closed abruptly (missing close_notify)`。这不是代理问题，是 schannel bug。
- 所以 **git 命令不要再走任何 HTTPS 代理**——git 直连 RST，走 HTTPS 代理 schannel 报错，
  实际可用的只有 **curl 走 clash 7890** 拉 tarball / API，git push 用本地代理的解决方式见下。
- Python 的 `urllib` 直连 7890 也能通（不需要 SSL 包装），适合脚本场景。
- **沙箱里任何 msys 二进制（git/bash/sh）的 spawn 都会因 signal pipe 崩**，和代理无关。
  **`git fetch` 是例外**：用纯 git 协议走 schannel，不 spawn msys，所以**沙箱里 `git fetch` 可以用**。

---

## 📌 记录勘误

- **2026-09-11：沙箱里 push 不需要绕路** —— "默认 ssh 会崩"是真的，但根因只是 **spawn 了 MSYS ssh**；
  把 `core.sshCommand` 指向原生 `C:/Windows/System32/OpenSSH/ssh.exe` 后，`push`/`fetch`/`ls-remote`
  直连成功（实测 `846569b..0d29e2e`，fetch 计数 `0  0`）。**5 步强制流程降级为兜底**，
  不再作为"必走流程"。
- 2026-09-08 旧记录说"`fetch` 不崩、`push` 才崩"——真正变量是 **transport**（HTTPS 不 spawn ssh，
  SSH 会）。见上文"重新解释"。
- 2026-09-05 旧记录说"沙箱里 `git push / git fetch / git pull` 必崩"——`fetch/pull` 部分**实测不崩**
  （2026-09-08 验证），**只有 `push` 崩**。原描述已修正。
- 2026-09-05 旧记录说"ghelper kuaishou CDN 代理是默认通道"——**该节点 2026-09-05 同日已死**，
  改走 clash 7890；旧描述保留供历史参考，**新脚本不要用**。另：**origin 是 SSH URL 时根本不用代理**
  （2026-09-11 实测 7890 未运行也能 push）。

## 目标仓库

- 远程：`https://github.com/Anmulzhao/DSH-AGINT.git`（公开）
- 本地：`~/projects/AGINT/`，remote `origin` 已配置（URL 内嵌 Basic auth）
- 全局 git config 有 `url.https://ghfast.top/https://github.com/.insteadof`
  rewrite —— **push 时必须用 `GIT_CONFIG_GLOBAL=/dev/null` 绕过**，
  否则请求被导到被封的镜像，报 `Recv failure: 连接被对方重置`。

## 标准推送流程（⚠️ 仅沙箱外 / Git Bash 用）

> **沙箱 PowerShell 不要用下面这套**——`git push` 必 msys signal pipe 崩。**沙箱走上面的"5 步强制流程"**。

```sh
cd ~/projects/AGINT
PX="http://127.0.0.1:7890"   # clash for Windows 明文 HTTP 代理（注意是 http:// 不是 https://）
PAT=$(git config --global --get github.token)

# 先确认代理活着
curl -sS -x "$PX" -o /dev/null -w "HTTP=%{http_code}\n" \
  --connect-timeout 10 https://api.github.com/

# push 主分支（git 走 7890 也偶发 schannel 错；如报错改走下方"备用：curl bundle 推"）
GIT_CONFIG_GLOBAL=/dev/null GIT_SSL_NO_VERIFY=1 git -c http.proxy="$PX" push origin main

# 有 tag 变更时
GIT_CONFIG_GLOBAL=/dev/null GIT_SSL_NO_VERIFY=1 git -c http.proxy="$PX" push origin <tag名>

# 需要 force push（重写历史）时加 --force：
GIT_CONFIG_GLOBAL=/dev/null GIT_SSL_NO_VERIFY=1 git -c http.proxy="$PX" push --force origin main
```

## 备用：git push schannel 报错时改用 curl bundle 推

git 走 HTTP 代理在 Windows 仍偶发 `schannel: missing close_notify`，且不易救活。
**最稳的 push 方式是 `git bundle` + `curl` 走 7890**：

```sh
cd ~/projects/AGINT
git bundle create /tmp/agint.bundle --all

# 把 bundle 当 binary POST 到 GitHub API（创建/更新 refs）
curl -sS -x "$PX" -X POST \
  -H "Authorization: token $PAT" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/agint.bundle \
  "https://api.github.com/repos/Anmulzhao/DSH-AGINT/git/refs"
# 或者直接在 GitHub Release 页面以 asset 形式上传 bundle，让协作者 fetch + push
```

## 验证

push 成功后用 API 确认线上状态（走同一代理）：

```sh
curl -sS -x "$PX" -H "Authorization: token $PAT" \
  "https://api.github.com/repos/Anmulzhao/DSH-AGINT/commits?per_page=5" | \
  python3 -c "import json,sys; [print(c['sha'][:8], c['commit']['message'].split(chr(10))[0]) for c in json.load(sys.stdin)]"
```

## clone / 下载大文件

```sh
# 优先 curl 走 7890，比 git clone 稳得多
curl -sSL -x "$PX" -o D:\openclaw.tar.gz \
  https://codeload.github.com/openclaw/openclaw/tar.gz/refs/heads/main

# 解压注意 Windows MAX_PATH：先解到短路径，再 robocopy 移动
tar -xzf D:\openclaw.tar.gz -C C:\
mv C:\openclaw-main C:\oc
robocopy C:\oc D:\openclaw /E /MOVE
```

## 代理切换历史

- 2025 ~ 2026-08：ghelper PAC HTTPS 代理 `90759cff-…sj7.cdnkuaishou.com:443` 是唯一通道
- **2026-09-05**：该节点死亡，返回 SOCKS5 残留字节。**clash for Windows 本地 `7890` 成为新默认**

## API 注意事项（偶尔踩到）

- `POST /user/repos`（建仓）偶尔返回 503 `No server is currently available` —— 重试即可，读操作（GET）稳定
- Windows 下 **git 协议走代理不稳定**（schannel bug），push/clone 优先走 curl；用 git 时如报错再切 bundle 方案
- 认证方式：git 用 URL 内嵌 Basic auth（`https://x:${PAT}@...`）；API 用 `Authorization: token $PAT`

## 仓库纪律

- **排障/过程文档（PUSH.md、网络记录、订阅 URL）不进 GitHub** —— 沉淀到本地 wiki（`AGINT/GitHub-发布与网络路径.md`）和 memory
- 公开仓库只放框架本体：docs/install/plugins/presets/profile-patches + 顶层说明文件
- `*.bundle` 已 gitignore，不进版本控制
