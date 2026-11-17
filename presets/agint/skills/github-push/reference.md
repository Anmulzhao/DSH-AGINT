# github-push 参考材料

完整命令、输出样例、记录勘误、代理切换历史。与 SKILL.md 同目录；用 read 工具打开（本会话 skill 加载返回的 Base directory 即技能基目录）。

## 1. ❌ 旧现象（保留供对照）：默认配置下必崩

**默认配置下（git 用自带的 MSYS `ssh.exe`），沙箱 PowerShell 里 `git push` 必崩**：

```
0 [main] sh.exe/ssh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5
fatal: Could not read from remote repository.
exit: 128
```

**根因**：git 的网络 transport 要 spawn MSYS 的 `sh.exe`/`ssh.exe`，而 MSYS 程序创建 signal pipe 时**要求父进程也是 MSYS 程序**；PowerShell（原生 Win32）不是，Windows 拒绝给权限（Win32 error 5 = Access denied）。跟网络、SSH key、认证、代理**全部无关**——**只跟"spawn 的是哪个 ssh"有关**。

> **2026-09-11 重新解释旧结论**：早先记的"`fetch` 不崩、`push` 才崩"其实是**transport 差异**，不是 fetch/push 差异——当时那条 `fetch` 走的是 **HTTPS transport**（`git -c http.proxy=…` + schannel，压根不 spawn ssh）；一旦 `fetch` 走 SSH transport，它同样会 spawn ssh、同样受支配。**判据请记成：transport 是否 spawn 了 MSYS ssh**（参见末尾"记录勘误"）。

## 2. 沙箱强制推送流程（5 步完整命令）

只在 `-c core.sshCommand=C:/Windows/System32/OpenSSH/ssh.exe` 失败时才走这套。

### Step 1：本地 commit（纯对象操作，不崩）

```powershell
git add <files>
git commit -m "..."
$new = git rev-parse HEAD
```

### Step 2：先 fetch 校准 origin 缓存（read-only，不崩）

```powershell
git -c "http.proxy=http://127.0.0.1:7890" fetch origin <branch>
$remoteSha = git rev-parse origin/<branch>
```

**为什么必须 fetch 而不是 `ssh -T git@github.com git-receive-pack` 探 OLD_SHA**：

- ssh + git-receive-pack **会一直等 stdin**，不喂东西就 hang
- GitHub 在 push 成功后**主动关连接**，ref 通告里 SHA 是握手期远端状态，不是 push 后结果
- `git fetch` 一次把"远端 SHA" + "本地缓存" + "ahead/behind 计数"全拿到，**3 件事 1 次走完**

### Step 3：列领先对象 + 打 pack（纯对象操作）

```powershell
git rev-list --objects 'origin/<branch>..HEAD' |
    ForEach-Object { ($_ -split ' ')[0] } |
    Set-Content objects.txt -Encoding ASCII
Get-Content objects.txt | git pack-objects --stdout > pack.pack
# ⚠️ 落地路径必须在 workspace-write 范围内（本会话的 workspace-write 根，例 `<工作区根>\...`），不能用 $env:TEMP——
#    沙箱里 Set-Content 到 $env:TEMP 后下次命令读不到，被清掉
```

### Step 4：组 v1 协议字节流 + `.NET Process` 直喂 ssh.exe stdin

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

### Step 5：再次 fetch 验证（强制，不可省）

```powershell
git fetch origin <branch>
$counts = git rev-list --left-right --count 'origin/<branch>...HEAD'
# $counts = "0	0" → 推送成功
# $counts = "0	N" → 还有 N 个 commit 没推
```

## 2. 备用：git push schannel 报错时改用 curl bundle 推

git 走 HTTP 代理在 Windows 仍偶发 `schannel: missing close_notify`，且不易救活。**最稳的 push 方式是 `git bundle` + `curl` 走 7890**：

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

## 3. 验证

push 成功后用 API 确认线上状态（走同一代理）：

```sh
curl -sS -x "$PX" -H "Authorization: token $PAT" \
  "https://api.github.com/repos/Anmulzhao/DSH-AGINT/commits?per_page=5" | \
  python3 -c "import json,sys; [print(c['sha'][:8], c['commit']['message'].split(chr(10))[0]) for c in json.load(sys.stdin)]"
```

## 4. clone / 下载大文件

```sh
# 优先 curl 走 7890，比 git clone 稳得多
curl -sSL -x "$PX" -o <工作盘>\openclaw.tar.gz \
  https://codeload.github.com/openclaw/openclaw/tar.gz/refs/heads/main

# 解压注意 Windows MAX_PATH：先解到短路径，再 robocopy 移动
tar -xzf <工作盘>\openclaw.tar.gz -C <工作盘>:\
mv <工作盘>\openclaw-main <工作盘>\oc
robocopy <工作盘>\oc <工作盘>\openclaw /E /MOVE
```

## 5. 记录勘误

- **2026-09-11：沙箱里 push 不需要绕路** —— "默认 ssh 会崩"是真的，但根因只是 **spawn 了 MSYS ssh**；把 `core.sshCommand` 指向原生 `C:/Windows/System32/OpenSSH/ssh.exe` 后，`push`/`fetch`/`ls-remote` 直连成功（实测 `846569b..0d29e2e`，fetch 计数 `0  0`）。**5 步强制流程降级为兜底**，不再作为"必走流程"。
- 2026-09-08 旧记录说"`fetch` 不崩、`push` 才崩"——真正变量是 **transport**（HTTPS 不 spawn ssh，SSH 会）。见 SKILL.md "重新解释"。
- 2026-09-05 旧记录说"沙箱里 `git push / git fetch / git pull` 必崩"——`fetch/pull` 部分**实测不崩**（2026-09-08 验证），**只有 `push` 崩**。原描述已修正。
- 2026-09-05 旧记录说"ghelper kuaishou CDN 代理是默认通道"——**该节点 2026-09-05 同日已死**，改走 clash 7890；旧描述保留供历史参考，**新脚本不要用**。另：**origin 是 SSH URL 时根本不用代理**（2026-09-11 实测 7890 未运行也能 push）。

## 6. 代理切换历史

- 2025 ~ 2026-08：ghelper PAC HTTPS 代理 `90759cff-…sj7.cdnkuaishou.com:443` 是唯一通道
- **2026-09-05**：该节点死亡，返回 SOCKS5 残留字节。**clash for Windows 本地 `7890` 成为新默认**
