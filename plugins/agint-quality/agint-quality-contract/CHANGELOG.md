# Changelog — agint-quality-contract

## 0.2.0 (2026-11-18) — 行 config 持久化通道（A/B 打分机制配套）

### Fixed
- **apply 读行 config**：此前 `apply(ctx)` 硬编码 `QualityConfigSchema.parse({})`，cordis.patch.yml 行 config 被无视；`setConfig` 只改内存，重启回默认 ⇒ `abtest.enabled` 无法持久开启。现 `apply(ctx, rowConfig)` 解析行 config（缺省 `{}` 行为不变）。
- 配套：cordis.patch.yml contract 行写入 `abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 }`（老板授权③出厂开）。

### Tests
- 新增 test/row-config.test.mjs 4 条：行 config enabled 持久 / 缺省兼容 / strict 拒未知键 / setConfig 运行期覆盖。全套 15/15（含 smoke 5）。

### Compatibility
- QualityConfigSchema 未改（abtest 块 0.6.4 起已在 contract，ADJUSTABLE）。
- L0-frozen 服务签名未触动；无行 config 的部署行为与 0.1.0 逐位一致。