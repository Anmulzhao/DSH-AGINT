# Evolution Ledger 外部锚点

由 `agint-cron` 的 `ledger-anchor` 任务追加，一行 = 一次锚定。
⛔ 只追加，不改写历史行；每行的 Prev Anchor Commit 指向**上一行**的引入 commit。
校验：`node bin/verify-ledger-chain.mjs --anchors`

| 锚定时间(UTC) | Ledger Seq | Head Entry Hash | Rollup Root | Entry Count | Prev Anchor Commit |
|---|---|---|---|---|---|
