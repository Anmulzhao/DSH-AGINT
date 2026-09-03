# Changelog — agint-quality-static

## 0.7.1 (2026-09-03) — Sprint 13 self-model-isolation + 存量测试收口

### Added

- **新增 `self-model-isolation` 规则组**（设计稿 §4.7）：仅对 `agint-self-model` 生效，防止「只读自我认知」插件退化成自我修改（D2 哲学：自我认知 ≠ 自我修改）
  - `writeServiceReferences`（blocker）：扫源码，禁止引用 `agint.qualityPolicy` / `agint.mutator` / `agint.population` 等写侧 Service
  - `storageDomainBoundary`（blocker）：`storage.domains[]` 只允许 `agint_self_model`，越域写一律拒绝
  - 对非 `agint-self-model` 插件直接跳过（0 findings），不误伤既有产物
- **注入测试** `test/self-model-isolation.test.mjs`：6 case（happy path + 4 个故意破坏夹具 + 非目标插件跳过）
- `FAMILY_SEVERITY['self-model-isolation'] = 'blocker'`、`FAMILY_ENABLED['self-model-isolation'] = true`

### Fixed

- **Windows 上 4 个存量测试文件完全无法运行**（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）：`checkers` / `static-smoke` / `l0-isolation.unit` / `l0-isolation.smoke` 在动态 `import()` 里直接传裸绝对路径，`D:\...` 被 ESM 解析器当成 URL scheme。统一改走 `pathToFileURL(...).href`
- **`checkers.test.mjs` 3 处路径断言硬编码 `/` 分隔符**：改为分隔符字符类 `[\/\\]`，跨平台可用
- **`static-smoke.test.mjs` 3 个 Sprint 10 遗留断言失效**（被上述 import 崩溃掩盖）：
  - `listFamilies()` 仍断言 4 族（Sprint 11 加 l0-isolation 后已是 5 族）→ 改为断言全部 6 族存在 + 总数校验
  - clean plugin / `checkAll()` / 自检 3 个用例未传 `l0IsolationOnly: true`，导致 l0-isolation 的 synth-only 域策略误伤非 synth 夹具 → 统一走文档化的 mount 编排默认档
- **`lib/static-profile.js` 自身触发 `contract-reference` blocker**：第 115 行注释含 FROZEN 契约包名字面串，违反本文件自己声明的「不得出现被 contract-reference 检查的字面串」约定 → 改写注释措辞，零行为变更

### Notes

- 本次收口后 `plugins/agint-quality-static/test/` 5 个文件共 **62 pass / 0 fail**（此前 4/5 个文件无法启动）
- `node --test <dir>` 在本仓库 Node 22.22.2 + Windows 下会把目录当 CJS 入口模块解析而报 `MODULE_NOT_FOUND`；请逐文件传参或用 glob

## 0.6.5 (2026-08-27) — Sprint 11 #B l0-isolation 收口

### Added

- **新增 `l0-isolation` 规则组**（设计稿 §4.4 ADR-11-4）：动态挂载流水线第一步对合成产物做三项 L0 隔离检查
  - `signatureCompatibility`（blocker）：产物 manifest `cordis.provides[]` 与 `static-profile.FROZEN_SIGNATURES`（7 个 schema 名 + 4 个 interface 名 + 1 个 service namespace + 17 个 schema 字段）做语义 diff；命中 schema/interface/namespace → blocker，命中 schemaField → warn
  - `domainIsolation`（blocker）：产物 `storage.domains[]` 必须匹配 `^agint_synth_[a-z0-9_]+$`；命中既有 `agint_*` 域（尤其 `agint_meta`）→ blocker（老板 2026-08-27 拍板）
  - `dependencyWhitelist`（blocker）：扫产物源码的 import / require / dynamic import 形式的 host service 引用；仅 `@deepseek-ai/agint-memory / agint-metrics / agint-cron` 放行（老板 2026-08-27 拍板），其他 `agint-*` 一律拒绝
- **`profileOverrides` 参数**（Sprint 11 向后兼容新增）：`checkPlugin` / `checkAll` 新增第三参，可注入 `{ l0IsolationOnly, frozenSignatures, allowedSynthDomains, allowedHostServices }`；Service 签名（FROZEN）不变，mount 编排默认传 `l0IsolationOnly: true` 防误伤既有插件
- **`FROZEN_SIGNATURES` / `ALLOWED_SYNTH_DOMAINS` / `ALLOWED_HOST_SERVICES` / `L0_ISOLATION_CHECKS`** 4 套配置常量（`lib/static-profile.js`），与 `loadProfile()` 第二参 `overrides` 联动
- **故意破坏注入测试** `test/l0-isolation.smoke.test.mjs`：4 case 覆盖三项子检查 + happy path
- **单元测试** `test/l0-isolation.unit.test.mjs`：≥20 用例覆盖每项子检查的 happy / 单 fail / 多 fail 边界 + `l0IsolationOnly` 防误伤逻辑 + FROZEN_SIGNATURES 完整性断言
- **README.md 章节**：详细说明 l0-isolation 适用范围、3 项子检查语义、注入测试设计、mount 编排调用契约

### Security

- 老板 2026-08-27 拍板 3 条边界已落地：
  1. FROZEN 签名集合**内联精简版**（`static-profile.js` 硬编码），不引入运行时 FROZEN 契约 import
  2. 域隔离**禁全部既有 agint_* 域，仅放行 agint_synth_***（与「签名空间独占」对称）
  3. 依赖白名单**memory / metrics / cron 三个全允许**（与设计稿原文对齐）
- L0-frozen 保护维持：`lib/checkers/l0-isolation.js` 不引用 `agint-quality-contract` FROZEN 接口，仅做字面量名字匹配；测试文件用 `CONTRACT_TOKEN` 拼接避免 grep 自检误报

### Compatibility

- 不挂顶层 `cordis.patch.yml`（Sprint 11 仍以仓库发版）
- Service 签名（FROZEN）不变；新参 `profileOverrides` 是向后兼容的可选项
- 与既有 4 族检查（dependency-audit / storage-boundary / env-access / contract-reference）共存，**不抢活、不放宽既有规则强度**

---

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