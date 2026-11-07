# Changelog — agint-wiki

## 0.3.1 (2026-11-07)

**Feat — `agint.wiki` 服务暴露 `root`（正斜杠归一化）**。

起因：cron 的 `wiki-build` 门禁需要知道真实 wiki 根。可选做法是在 `cordis.patch.yml`
里再写一遍那串 `!!js` 回退链（`AGINT_WIKI_ROOT || AGINT_DATA_HOME || AGINT_HOME || HOME + '/projects/AGINT'`），
但那样就是第二种口径 —— 改了 wiki 根之后，门禁会静默核到另一个目录，还报「通过」。

所以由服务自己暴露：`ctx.provide('agint.wiki', { root: normRoot, ... })`。
消费方（`plugins/agint-cron/lib/jobs.js`）取 `services['agint.wiki'].root`，
取不到就记 `skipped` 并写明理由，不静默降级成通过（K134）。

测试：`test/representation.test.mjs` 加 1 条，断言 `wiki.root` 存在且已归一化成正斜杠。

## 0.3.0 (2026-11-07)

**Feat — 表示层构建器（阶段 3）**。此前 `agint.wiki` 只是「一个目录 + 一堆互不认识的 .md」：
`lint()` 能算孤儿，但没有任何东西生产链接，所以孤儿只能靠人手工补。
本版补的是**链接与聚合**，不是再写一遍内容。

新增：

- `lib/marker.js`：生成页标记的唯一判据。`isGenerated` / `stripVolatile`（抹时间戳后比对）。
- `lib/representation.js`（纯函数，不写盘）：`parseDoc` 按**小节别名表**切分，`extractItems`
  抽缺口/待确认条目，`collectCitations` 做制度名反查，`buildPlan` 生成计划，
  `verifyVerbatim` / `checkLinks` 做两道硬校验，`planWrites` 决定写哪些并拒绝覆盖人工页。
- `bin/wiki-build.mjs`：CLI。默认 dry-run；`--write` 落盘；`--check` 判漂移；`--prune` 清过期生成页。
- 产出三页：`README.md`（总索引，人工维护的入口页单列且标注权威）、`_口径缺口总览.md`
  （跨文档聚合，逐字引用 + 小节起始行）、`_依据反查.md`（只收 ≥2 篇引用的制度名称）。

**三条门槛全部来自 Anthropic《The components of agent memory》的实验数字，不是自拟**：

1. `minSources = 2` —— 单文档可检索时 wiki 相对搜索「no clear gain」，只由 1 篇支撑的主题不单独成页。
2. `maxRatio = 1.0` —— 该文实测 wiki 长到语料 1.77 倍时评语是「effectively abstracted nothing」。
   生成量超过语料量 = 没有抽象，硬拒。
3. **逐字引用** —— 该文实测：摘要进共享表只活下来 41/57 条事实（72%），逐字引用后 57/57（100%）。
   本版把这条钉成 `verifyVerbatim`：聚合页每一条、索引页每句摘要都必须是源文件的子串，
   否则 CLI 直接退 2，不出页。

**改 linter（一处行为变化）**：`lint()` 对生成页豁免 `⚠️` 判定，仍照常解析链接。
理由：聚合页里的 `⚠️` 行是**源文件的逐字引用**，不是本页的主张；照常判会让聚合页一生成就把
`healthy` 打成 false。判据在 `lib/marker.js`，只有一份。

**实测（`D:/DSH/AGINT-date/wiki`，11 篇人工文档 87,492 B）**：

| 口径 | 修前 | 修后 |
|---|---|---|
| `lint()` 孤儿 | 5 | **0** |
| 断链（人工页既有） | 2 | 2（未新增，未擅自改） |
| 矛盾 | 0 | 0 |
| 生成量 / 语料 | — | 14,838 B / 87,492 B = **0.170** |

**能力边界（写清楚，别当成缺陷）**：

- 缺口写成**表格**的小节抽不出条目（`extractItems` 只认列表/编号项）。覆盖统计会把这类文档
  列进 `coverage.tableOnlyDocs`，不会静默当成「那篇没缺口」。
- 制度反查只认 `《》` 包住的名称。条款号（`手册 2.18.9.4`）与文号（`27号细则`）不在其中 ——
  它们不带书名号，混进来会把同一份制度的不同写法当成不同制度。
- 语料过小时占比门槛会自动拦掉聚合页（2 篇几十字节的语料确实不需要总览）。这是设计，不是 bug。

**测试**：`test/representation.test.mjs` 21 条。每条门槛都配 negative control ——
把门槛调松，同样的输入必须能出结果，否则「拦住了」可能只是「根本没实现」。

## 0.2.0 (2026-09-04)

**Fix — Windows path-escape 误报**。原 `clean()` 用 `abs.startsWith(root + '/')` 检查越界，Windows 上 `resolve()` 返回 `D:\foo\hello.md`，而 `root + '/'` 变 `D:\foo\`，永远不匹配 → 所有 forward-slash 路径写入全炸 `path escapes root`。新实现：把 `root` 和 `abs` 都规范化为正斜杠后比较，不削弱安全（仍拒 `../`），同时跨平台一致。

变更：

- `lib/index.js`：`apply()` 顶端加 `normRoot = root.replace(/\\/g, '/')`；`clean()` 比对用 `normAbs` vs `normRoot`。
- `test/smoke.mjs`：新增覆盖 forward-slash basename / nested / leading-slash 三类正向 + `../` / `../../` 两类负向。
- `manifest.json`：新增（维度 1-4）；version bump 0.1.0 → 0.2.0；tests.entry 指向 test/smoke.mjs。
- `README.md`：新增（维度 7）；含路径安全表 + 测试说明。
- `CHANGELOG.md`：本文件（维度 8）。

兼容性：跨平台行为对齐；API 不变；配置文件无需变更。

## 0.1.0 (2026-08 前)

初版。`read / write / remove / list / search / lint`。仅在 Linux/macOS 上实测，Windows 路径 bug 未暴露（因未在该平台测过）。