# Changelog — agint-memory

> 本文件此前缺失（manifest 声明了 `CHANGELOG.md` 但文件不存在），2026-10-02 补建。
> 条目来源：`git log -- plugins/agint-memory`，只记录有提交可查的变更。

## Unreleased

- **补 `input.signal.self-observation.session-integrity` 订阅**（2026-10-06）：
  网关 `lib/schema.js` 枚举 5 个 self-observation 主题，memory 此前只订 4 个 ⇒
  C2 sessionIntegrity 检测器（0.1.1 实装）一旦产出信号无人消费（待做清单 H3）。
  沉淀分支写 `pattern` / confidence 0.7，与其余 self-observation 主题同构。
  ⚠️ 运行态证据要等部署位同步 + 宿主重启后真实触发一次完整性异常才有。
- `memory_write` 参数表补 `replacedBy`（2026-10-04）：service 层早已实现
  （`lib/index.js:142` `input.replacedBy ?? existing?.replacedBy`），
  但 `lib/tools.js` 的参数表一直没暴露 ⇒ 「本条已被 X 取代」这类关系
  写不进去，只能改 `content`—— 而改 content 不是合法路径。
  纯增量字段，**不破坏既有调用方**。新增 `test/tools-contract.test.mjs` 锁住
  「参数表必须暴露 `replacedBy` + output schema 必须声明它」这条契约。
  ⚠️ 该断言属「改常量后必然自证通过」类型：真正的运行时证据是宿主重启后
  真实调一次 `memory_write` 再 `memory_read` 核对落库。
- C5：订阅 `input.signal.external.repo-diff`，自动把外部信号沉淀为记忆
  （2026-09-29 `b50a01c`）。
- C2 信号扩展：metrics 退化检测器接入后，memory 订阅面扩大（2026-09-29 `306bde6`）。
- C4 对抗挑战 Channel：订阅已有事件，只转发失败/边界（2026-09-29 `fa5d5d1`）。

## 0.1.0

### Fixed

- **回退错误的 tool output schema 改法**（2026-09-21 `7a81f71`）：2026-09-20 `b03d919`
  把 10 个插件的 tool output schema 改成标准 JSON Schema 形式，但 `output.schema`
  必须用**值 schema DSL**，改法是错的，本次回退。

### Added

- **补 manifest.json**（2026-09-07 `6101540`）：此前该插件无 manifest，
  `install.sh` 的 manifest 同步校验与 `plugin-check` 对它失明。
- **P0 validation gate + JSONL recall store**（2026-09-05 `16ad629`，随 agint-dream 落地）。

### Changed

- **tool output schema 改为标准 JSON Schema 形式**（2026-09-20 `b03d919`，后于 09-21 回退）。

## 初始

- 2026-08-17 `bc28ee8` — `feat(v0.1)`: AGINT 自演化框架首发（8 plugins / 3 presets / 1 patch）。
