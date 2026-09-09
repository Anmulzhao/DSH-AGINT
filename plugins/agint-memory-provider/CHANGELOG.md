# Changelog — agint-memory-provider

## 0.2.0 (2026-09-09)

P1-1 Sprint 16「降级与检查点」落地（设计稿 §12.2 范围，88/88 测试 PASS）。

### 新增

- **运行时降级**（§3.1 [6]）：外部 provider 单次失败 → 本轮降级不中断对话；
  连续失败达 `max_consecutive_failures`（`failure_window_minutes` 窗口内）→
  自动切 builtin（shutdown 旧 provider + 卸载其工具 + 写 activation_log）；
  `auto_recover_after_minutes` 后 beginTurn 自动恢复到用户原配置的 provider
  （不改配置，§9.3）。失败明细写 `fallback_events` 表（错误归类 network /
  timeout / rate_limit / auth / unknown；`log_sensitive_data=false` 时不落
  原始错误文本）。
- **召回超时保护**（§9.1 L1）：外部 provider prefetch 套 `prefetch_timeout_ms`
  超时（builtin 进程内检索不套），超时跳过本轮召回，绝不阻塞对话。
- **pre_compress 检查点**（§3.2 / §9.1 L5）：apiVersion>=2 且
  `pre_compress_fail_closed` → onPreCompress 失败即 abortCompress=true
  （fail-closed，调用方保留原始消息）；apiVersion=1 → best-effort 放行。
  防死锁（§13.2）：连续失败达 3 次回退 best-effort，避免反复中止压缩导致
  token 溢出。检查点全量落 `pre_compress_checkpoints` 表。
  ⚠️ 诚实边界：宿主 dsh v0.1.3 无 pre-compact 钩子，本编排器可被上层显式
  调用，等宿主暴露扩展点后自动接线。
- **provider 工具动态注册**（§3.3）：activate 成功后自动调
  `getToolSchemas()` → 加前缀（`external_tool_prefix` 或 `<provider>_`）
  → 冲突/保留名检查（跳过并记录，不覆盖）→ 注册到 ctx.tools；
  切回 builtin / 连续失败切换时自动卸载；自动恢复时重注册。
  `routeToolCall` 路由回 `provider.handleToolCall`（传原始名），结果 JSON
  round-trip；工具失败记 fallback_events 且抛回调用方（不伪装成功）。
- **4 个 preset 工具**：memory_provider_test（配置/凭证级校验，无网络探活）、
  memory_provider_config_get / config_set（write，secrets 只收 env var 名）、
  memory_provider_fallback_stats（7 天窗口聚合 + 当前降级态）。
- **4 个新事件**：memory.provider-fallback / provider-recovered /
  pre-compress-checkpoint / tool-called（软依赖 event-bus）。
- Service 新增：`getFallbackStats`（真实聚合）、`listProviderTools`、
  `getDegradationState`（stats 内暴露）；inject 增加 `tools`。
- 测试 67 → 88：降级/恢复/超时/错误归类、pre_compress 五分支、
  工具注册/冲突/路由/失败传播、testConnection 三分支。

### 修复

- registerProviderTools 的 `this.defineTool` 从未赋值（恒返回
  tools_unavailable）：改为 deps 注入 + lazy dynamic import 兜底。
- `maybeRecover()` 定义后从未接线：beginTurn 开头调用（取 activeProvider 前）。
- index.js PACKERS 缺 fallback_events / pre_compress_checkpoints 两表
  （写入会抛「未知表」被吞）。
- deactivate 切回 builtin 未卸载外部 provider 工具。

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
