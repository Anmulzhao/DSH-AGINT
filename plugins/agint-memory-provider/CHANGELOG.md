# Changelog — agint-memory-provider

## 0.1.0 (2026-09-08)

P1-1 可插拔记忆 Provider 架构 Sprint 15 基础抽象层落地（设计稿 §12.1 范围）。

### 新增

- `lib/provider.js`：ExternalProvider 抽象基类（完整生命周期 + 可选 hooks +
  pre_compress 检查点 API 版本声明）+ `validateProvider` 实现完整性校验
  （同一性比较，拦「继承 stub 却声称已实现」）。
- `lib/builtin-provider.js`：BuiltinProvider 封装 `agint.memory` 服务。
  对设计稿 §5.2 的三处纠正：不开 `agint` 域（进程内独占）、不关别人的域、
  prefetch 默认只读（`builtin_recall_touch=false`，避免改变 decay.js 衰减输入）。
- `lib/manager.js`：MemoryManager（激活/降级/生命周期调度/琐碎输入过滤/
  召回指示器/pause-resume）；Sprint 16 交付物（运行时降级/pre_compress/
  工具动态注册/testConnection）显式抛「未实现」，绝不静默。
- `lib/registry.js`：ProviderRegistry（注册即校验、builtin 保留名、describe 快照）。
- `lib/trivial.js`：琐碎输入过滤（设计稿 §7 英文词表 + 中文词表补齐，
  锚定正则 + 长度短路防误判）。
- `lib/schema.js`：FROZEN schema + LIMITS（§4 上限一一对应）+ 配置默认值（§8.1）
  + RUNTIME_CONFIG_KEYS（§8.2）。
- `lib/storage.js`：存储域 `agint_memory_provider`（5 表，fallback_events /
  pre_compress_checkpoints 预置待 Sprint 16 写入）+ pack 函数 + 上限滚动清理。
- `lib/tools.js`：preset 工具 4 个（list / status 裸调，activate / deactivate ask）。
- `lib/mock-provider.js`：MockProvider（故障注入 / 延迟 / 调用记录 / apiVersion 可配）。
- `lib/index.js`：Service `agint.memoryProvider` 出口（§5.3 全部方法）+
  事件发布（软依赖 event-bus）+ 启动自动激活。
- `manifest.json` / `package.json`：PLUGIN-SPEC 8 维度（独占存储域、
  mountOrder 55、注入 `agint.memory`、软依赖 event-bus）。
- `test/smoke.mjs`：67 个测试（导出契约 / schema / storage / provider 校验 /
  registry / trivial 中英文正反例 / builtin 三处纠正 / manager 生命周期与降级 /
  mock / §9.3 自我评估禁止）。

### 设计取舍

- **§14.1 决策 B**：内置记忆工具（memory_write 等）继续由 agint-memory 提供，
  不经 provider 接口 → BuiltinProvider.getToolSchemas() 返回 `[]` 显式声明。
- **§9.3**：管理器不自动切换 provider、不自动改配置；唯一自动降级是
  「激活失败 → builtin」护栏兜底。
- **敏感配置**（§9.1 L2）：secrets 只接受 env var 名，疑似凭证字面量拒绝落库。
