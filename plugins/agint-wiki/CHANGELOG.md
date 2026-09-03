# Changelog — agint-wiki

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