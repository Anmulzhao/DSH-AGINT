# fork 许可标注模板

用途：dsh-pet fork 里区分「上游代码」和「AGINT 新增代码」的许可声明。

## 目录

- [规则](#规则)
- [根 LICENSE](#根-license)
- [LICENSE-AGINT.md](#license-agintmd)
- [NOTICE](#notice)
- [新建文件的头](#新建文件的头)
- [改过的上游文件](#改过的上游文件)
- [不要做的事](#不要做的事)
- [验证](#验证)

## 规则

1. 只对你**从零新建**的文件用 MIT。
2. 对上游文件的**一切修改**留在 Apache-2.0。
3. 判据：这个文件如果上游没有它，你能不能独立写出来？能 → MIT。不能 → Apache-2.0。
4. 改了上游文件必须按 §4(b) 加显著变更声明。这条和第 2 条一起做。

## 根 LICENSE

不动。保持 Apache-2.0 原文 202 行。

## LICENSE-AGINT.md

```markdown
# AGINT 新增代码授权

本文件覆盖本仓中由 AGINT（anmul）从零编写的文件。

- 许可：MIT
- 版权：Copyright (c) 2026 anmul
- 完整条款见仓库根 `LICENSE-MIT-AGINT.md`（MIT 全文）

本文件**不**覆盖以下内容：

1. 上游 `zhu1090093659/dsh-pet` 的代码，许可为 Apache-2.0，见仓库根 `LICENSE`。
2. 对上游 Apache-2.0 文件的修改，同样保留 Apache-2.0。
3. `assets/` 下的内置宠物资产，各资产条款见其 `pet.json` 的 `license` 字段与 `THIRD_PARTY_NOTICES.md`。

## 如何判断一个文件属于哪一类

| 情况 | 许可 |
|---|---|
| 全新文件，仓库里没有对应上游文件 | MIT |
| 上游文件，你只做了改动 | Apache-2.0 |
| 上游文件，未改动 | Apache-2.0 |
| `assets/` 下的资产 | 看各自的 `pet.json` |
| `THIRD_PARTY_NOTICES.md` | 原样保留 |
```

## LICENSE-MIT-AGINT.md

放 MIT 全文（21 行），从 `DSH-AGINT/LICENSE` 抄一份。

## NOTICE

```markdown
# NOTICE

本产品包含来自以下项目的软件：

## zhu1090093659/dsh-pet（fork）

- 许可：Apache License, Version 2.0
- 上游：https://github.com/zhu1090093659/dsh-pet
- 本 fork 的基线 commit：36f605619bdf5445e84493b7faaf2bbb51077b14
- 说明：仓库根 `LICENSE` 为 Apache-2.0 全文。本文件不替代它。

其第三方资产声明见同目录 `THIRD_PARTY_NOTICES.md`。

## AGINT 新增部分

- 许可：MIT
- 版权：Copyright (c) 2026 anmul
- 说明：详见 `LICENSE-AGINT.md` 与 `LICENSE-MIT-AGINT.md`。
```

⚠️ 加了 NOTICE 之后，Apache-2.0 §4(d) 对下游生效。你转发时要把这个 NOTICE 一起带走。

## 新建文件的头

TypeScript / JavaScript：

```ts
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
// AGINT 新增文件。许可见 LICENSE-AGINT.md。
```

JSON / YAML（不支持注释的格式）：用旁边的 `.license` 文件或加 `license` 字段。

Markdown：

```markdown
<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 anmul -->
```

## 改过的上游文件

Apache-2.0 §4(b) 要求「prominent notices stating that You changed the files」。加在文件头：

```ts
// SPDX-License-Identifier: Apache-2.0
// 本文件来自 dsh-pet 上游，许可 Apache-2.0。
// AGINT 修改记录：
//   2026-10-04  增加 announce 接入口，函数 addAgintAnnouncer()。
// 上游基线：https://github.com/zhu1090093659/dsh-pet @ 36f6056
```

⚠️ **2026-10-05 更正**：本 fork 的 `src/` `contracts/` `scripts/` **零改动**
（`git diff upstream/main..HEAD -- src/ contracts/ scripts/` 为空）。
所以**不需要**加这段变更声明——没有改过上游文件。
`src/service.ts` 与上游的差异是**上游自己**的 #1762 修复（`bddc3b8`，2026-09-30），
不是我们的改动。将来真改了上游文件再用上面的格式。

「prominent」的意思是明显到任何人翻到文件就能看到。放在文件头第一屏，不要埋在第 200 行。

## 不要做的事

1. ❌ 不要把根 `LICENSE` 换成 MIT。
2. ❌ 不要在 README 写「本项目采用 MIT 许可」这种整体性表述。会被理解成含 Apache-2.0 部分也适用 MIT。
3. ❌ 不要把改了几行的上游文件标成 MIT。
4. ❌ 不要以为标了 MIT 就能用 doro 或 miku。资产条款和代码许可是两回事。doro 仍限非商业，CC-BY-NC-SA-4.0 的两个仍非商业 + 相同方式共享。
5. ❌ 不要删 `THIRD_PARTY_NOTICES.md`。删了就丢了 attribution。
6. ❌ **不要靠「记得删」来防受限资产外流。** `package.json#files` 白名单才是那道闸
   （2026-10-05 实测：4 个受限资产均不在白名单内，`npm publish` 不会带它们）。
   反过来也**必须维护白名单**：2026-10-05 帧入库时忘了加 `assets/agint`，
   57 帧在仓库里但 `npm pack` 会全漏掉。同一个白名单既是安全网也是必维护清单。

## 验证

```sh
# 1. 每个文件都应有 SPDX 标注
git grep -L "SPDX-License-Identifier" -- "*.ts" "*.tsx" "*.js"

# 2. 没有文件被错标成 MIT 但其实来自上游
git grep -l "SPDX-License-Identifier: MIT" -- src/ | while read f; do
  git log --oneline --diff-filter=A -- "$f" | tail -1
done

# 3. 上游文件都带变更声明
git grep -l "AGINT 修改记录" -- src/
```

第 2 条最关键：确认每个标 MIT 的文件在 git 历史里确实是**新增**（`A`）而不是**修改**（`M`）。
