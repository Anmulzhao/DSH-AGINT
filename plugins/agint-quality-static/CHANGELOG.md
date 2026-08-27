# Changelog — agint-quality-static

## 0.6.3 (2026-08-27) — Sprint 10 #4 收口

### Added

- **新增独立 Cordis 插件**（设计稿 §架构修正声明，停止基座膨胀）
- **4 族静态检查**（设计稿 §二.3）：
  - `dependency-audit`（blocker）：解析 package.json 比对白名单
  - `storage-boundary`（blocker）：扫 fs.write* 直写 storage domain
  - `env-access`（warn）：扫 process.env 访问对照 allowlist
  - `contract-reference`（blocker）：grep L0 契约插件包名 0 命中
- **FROZEN Service 契约**：
  - `checkPlugin({ pluginDir, profile? })` → `{ ok, findings, durationMs, profile }`
  - `checkAll({ pluginsDir })` → `{ results, totalFindings }`
  - `listFamilies()` → `string[]`
  - `addAllowlistEntry({ family, pattern })` → `{ ok, version }`
- **独立存储域**：`agint_static_rules`（与兄弟插件不重叠）
- **白名单机制**：`lib/static-profile.js` 维护 `ALLOWED_DEPS` / `STORAGE_DOMAINS` / `ENV_ALLOWLIST` 三张表

### Security

- 与 SDK 模板级 static-check 形成双轨（设计稿 §二.1）
- 误报阻断缓解：3 族 blocker + 1 族 warn，跑 2 周后收紧（设计稿 §六 §6.5 + §九遗留 TODO）

### Compatibility

- 不挂顶层 `cordis.patch.yml`（Sprint 10 仅仓库发版）
- 不引用 quality-contract FROZEN 接口（实测该包名字符串仅出现于 `lib/checkers/contract-reference.js` 的 pattern 常量）