# Evolution Ledger 外部锚点

由 `agint-cron` 的 `ledger-anchor` 任务追加，一行 = 一次锚定。
⛔ 只追加，不改写历史行；每行的 Prev Anchor Commit 指向**上一行**的引入 commit。
校验：`node bin/verify-ledger-chain.mjs --anchors`

| 锚定时间(UTC) | Ledger Seq | Head Entry Hash | Rollup Root | Entry Count | Prev Anchor Commit |
|---|---|---|---|---|---|
| 2026-10-03T17:09:58.736Z | 7 | sha256:2ddbdd2a666eacd0816825de2ebdf6004c3f8f7d12213f5135cc60096b3cbf22 | sha256:d2787f8f0c0efd3e6cb58c462dbe12942aac2d2c6eacc99943f9777f91622314 | 7 | GENESIS |
| 2026-10-05T02:15:00.818Z | 7 | sha256:2ddbdd2a666eacd0816825de2ebdf6004c3f8f7d12213f5135cc60096b3cbf22 | sha256:d2787f8f0c0efd3e6cb58c462dbe12942aac2d2c6eacc99943f9777f91622314 | 7 | 0e0fe650b2508a243f66b0713d713f89cbf6a4f1 |
