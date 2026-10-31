# agint-upstream-watch

上游判读器。**把「dsh 又发版了」变成「这对 AGINT 意味着什么」。**

## 它补的是哪个洞

AGINT 有五类信息通道，其中 `external`（C3）这一类一直是空的 —— 只挂了一个读本地 git 的源，
而且从未启用。也就是说它能感知自己（C2）、能接受挑战（C4）、能跨 agent 取经（C5），
**却感知不到养它的那一层在变**。

dsh 的出片节奏是 1–2 天一个版本。2026-10-28 那天同时发了 `0.2.1-rc.4` 和 `0.2.2-alpha.2`，
后者一次带 11 条破坏性变更（`engines.node >= 24.9`、工具执行流水线重构、
`agent/request` 不再允许改路由 ……）。任何一条踩中，AGINT 就是「装不上」或
「起来了但功能静默缺失」。而过去这件事靠人读到 changelog 再转告。

## 两段式：事实与结论分离

| 段 | 做什么 | 会不会失败 |
|---|---|---|
| 段 1（`lib/facts.js`） | 版本语义、release 条目统计、**依赖面实测** | 基本不会 |
| 段 2（`lib/judge.js`） | 读事实下结论、写提案 | 会（模型/超时/schema） |

段 2 失败时：`digests.llmStatus='failed'`，**事实照落、结论留空、不产提案**。
这不是降级（不拿启发式冒充模型结论），而是「事实必须留下」。

## 段 1 的核心：实测，不是读 changelog

关键词判据会骗人。现成的反例就在 2026-10-28：

- changelog 写「插件需迁移 `tools.resolve/executable` 与提示词组装接口」→ 读文字像是要大改
- 实测：把 npm 上真正发布的包拉下来比对 `.d.ts`，`ctx.tools.register(def)` 只是变成
  `register(def, options?)`（新增**可选**第二参），`defineTool` 的选项一字未变
- 结论：140 处调用零改动

所以本插件的判据链是：

1. 扫 AGINT 的 `plugins/**`，得出真实依赖面（`@deepseek-ai/dsh-tools` / `-storage-domain` / `-schedule`）
   **以及每个包用了哪些导出**（`defineTool` / `defineDomain` / `domainTable` …）
2. 对每个包：拉目标版本 tarball（`node:zlib` 解 gz + 自写 tar 头解析，零依赖），
   提取 `lib/types/*.d.ts` 与 `lib/index.js`，与本机已装版本比对
3. 得出 `verdict`（API 层面）与 `usedImpact`（**对 AGINT 的影响**）两个独立字段

`usedImpact` 的取值是关键设计：

| 值 | 含义 |
|---|---|
| `breaking` | AGINT 真用到的符号被删或被收窄 —— 必须处理 |
| `elsewhere` | 这个包 API 有删除，但都不在 AGINT 使用面上 —— **与 AGINT 无关** |
| `additive` | 只有新增/变宽 |
| `unknown` | 拿不到 tarball 或定位不到本机安装 —— 不猜 |

不给这个区分的话，`dsh-tools` 删 60 个导出（其中 0 个是 AGINT 用的）会被报成
「重度风险」—— 喊三次狼来了，这功能就没人看了。

## 三条硬边界

1. **不装、不升 dsh。** 那是宿主环境动作，AGENTS.md 红线。终局形态是
   「它发现、它判读、它备好依据，人按一下」。
2. **所有提案 `autoExecutable: false`。** 依赖升级永不自动执行，且不受 `force` 影响
   （v0.17.0 的语义闸本就不可强穿）。
3. **拿不到就说拿不到。** 定位不到本机安装、拉不到 tarball ⇒ 记 `unknown`，
   绝不退化成 `compatible`。基准版本与 dsh 主包不一致时标 `baselineSuspect: true` ——
   本机就有这个坑：`$DSH_HOME/profiles/node_modules/` 里躺着被 App 升级甩下的
   0.1.1-rc.2 遗留副本，拿它当基准会得出「45 个导出被移除」的全假结论。

## 数据流

```
upstream-release（C3 新子源，每日 06:00）
  └─ input.signal.external.release-published
       └─ agint-upstream-watch.digest(tag)
            ├─ 段 1 → facts  ──────────────→ storages/agint_upstream_watch.digests
            │                                  （无论段 2 成不成，都落）
            └─ 段 2 → verdict ──（autoPropose）→ agint.evolve.propose(autoExecutable:false)
                                                 └─ 家族面板提案台 → 人拍板
```

## Service

| 方法 | 用途 |
|---|---|
| `agint.upstreamWatch.status()` | 配置 + 计数器 + 最近 5 次判读（含 LLM 成功/失败分别计数） |
| `agint.upstreamWatch.digest(tag, opts)` | 判读一个版本；同 tag 已判过则返回缓存，`force:true` 重判 |
| `agint.upstreamWatch.runNow(tag)` | `digest` 的强制别名 |
| `agint.upstreamWatch.listDigests({limit})` | 按更新时间倒序 |

## 工具

| 工具 | 性质 |
|---|---|
| `upstream_status` | 只读，零副作用 |
| `upstream_digest` | 写：落判读记录，可能写提案（提案不可自动执行） |

## 安全开关

```
AGINT_UPSTREAM_WATCH=off          # 整体停摆（订阅保留，不处理）
config.autoPropose = false        # 只落事实，不碰提案台账
config.maxProposalsPerRelease     # 单版本提案上限，默认 2
```

## 已知限制

1. **只比类型定义与导出名，不覆盖运行时语义。** 签名没变但行为变了的情况抓不到 ——
   实例：`dsh-storage-domain` 把版本校验从「丢弃旧记录」改成「接受已落盘的旧版本」，
   函数签名一个没动。这类只能靠 changelog 判读兜。
2. **首次运行必然静默。** 频道首次只建基线，要看效果得等第二个版本。
3. **面板未接。** 家族面板的 v2 页面有冻结基线（`v2-scan`，已重冻五次），
   加分区要再冻一次。v0.1 先用 service + 工具把数据做出来，确认判据真的有用再动面板。
4. **只追 release，不追 master commit。** commit 粒度太细，日更场景下信噪比极差。

设计全文见 `docs/upstream-watch.md`。
