# Changelog — agint-tool-stats

> 本文件此前缺失（manifest 声明了 `CHANGELOG.md` 但文件不存在），2026-10-02 补建。
> 条目来源：`git log -- plugins/agint-tool-stats`，只记录有提交可查的变更。

## 0.1.0

### Fixed

- **数组字段去掉 `required`**（2026-09-20 `062b1b5`）：tool output schema 里
  数组字段带 `required` 不合法，导致校验失败。

### Changed

- **会话解析改走中立提取器**（2026-09-17 `3bdd453`，随 skill-autocreate Phase 0/1/2 落地）：
  双格式（v3 / jsonl）+ 去重。**修了 backfill 只认 `session.jsonl.zstd`、
  漏读全部 v3 会话的历史 bug** —— 该 bug 会让工具画像持续偏小而不报错。

### Added

- **补 manifest.json**（2026-09-07 `6101540`）：此前该插件无 manifest，
  `install.sh` 的 manifest 同步校验与 `plugin-check` 对它失明。

## 初始

- 2026-08-18 `319e87f` — `feat(v0.1.1)`: D-QAF evaluation contract + integration patches。
- 2026-08-17 `bc28ee8` — `feat(v0.1)`: AGINT 自演化框架首发。
