/**
 * agint-memory-provider: ProviderRegistry（设计稿 §2.2 / §3.1 [2]-[3]）。
 *
 * 职责：注册已发现的 provider、校验实现完整性、按名字查询、列出状态。
 *
 * L0 护栏（§9.1）落地在这里：
 *   - **builtin 保留名**：外部 provider 不得占用 'builtin'（否则 fallback 目标
 *     可被顶替，L0「内置 provider 始终可用」失效）。
 *   - **实现完整性校验**：注册即校验，不合格直接拒绝注册（不放进表里），
 *     避免运行时才炸。
 *   - **单外部 provider 限制**由 MemoryManager 的激活逻辑保证（一次只激活一个）；
 *     registry 只负责「注册多个、激活一个」，注册本身不限制数量。
 *
 * Sprint 15 的「发现」是显式 register 调用（builtin + 测试用 mock）。真正扫描
 * 外部 provider 插件属 Sprint 17/18（示例 provider + 开发指南）范围。
 */

import { validateProvider, safeName } from './provider.js';
import { BUILTIN_PROVIDER } from './schema.js';

class ProviderRegistry {
  /**
   * @param {object} [opts]
   * @param {(msg: string) => void} [opts.debug]
   */
  constructor({ debug } = {}) {
    /** @type {Map<string, object>} */
    this.providers = new Map();
    /** @type {Map<string, object>} 校验报告（含被拒绝的，供排障） */
    this.reports = new Map();
    this.debug = typeof debug === 'function' ? debug : () => {};
  }

  /**
   * 注册一个 provider 实例。
   * @param {object} provider
   * @returns {{registered: boolean, name: string|null, reason?: string, report: object}}
   */
  register(provider) {
    const report = validateProvider(provider);
    const name = report.name ?? safeName(provider);
    this.reports.set(name, report);

    if (!report.valid) {
      const reason = report.errors.length
        ? report.errors.join('; ')
        : `缺少必须实现的方法: ${report.missing.join(', ')}`;
      this.debug(`[registry] 拒绝注册 '${name}': ${reason}`);
      return { registered: false, name, reason, report };
    }

    // L0：builtin 是保留名，只允许 BuiltinProvider 占用。这里用「已注册者是否
    // 始终可用」区分：builtin 由 index.js 第一个注册，后来者不得覆盖。
    if (name === BUILTIN_PROVIDER && this.providers.has(BUILTIN_PROVIDER)) {
      const reason = "'builtin' 已被内置 provider 占用，外部 provider 不得使用该名（§9.1 L0）";
      this.debug(`[registry] 拒绝注册: ${reason}`);
      return { registered: false, name, reason, report };
    }

    const duplicate = this.providers.has(name);
    this.providers.set(name, provider);
    this.debug(`[registry] 注册 '${name}'${duplicate ? '（覆盖同名）' : ''}` +
      (report.recommended.length ? ` · 建议 override: ${report.recommended.join(', ')}` : ''));

    return { registered: true, name, report };
  }

  /** @returns {object|undefined} */
  get(name) {
    return this.providers.get(name);
  }

  has(name) {
    return this.providers.has(name);
  }

  /** 已注册的 provider 名列表（builtin 排首位，其余按注册顺序） */
  list() {
    const names = [...this.providers.keys()];
    const i = names.indexOf(BUILTIN_PROVIDER);
    if (i > 0) names.unshift(...names.splice(i, 1));
    return names;
  }

  /** 除 builtin 外的外部 provider 名 */
  listExternal() {
    return this.list().filter((n) => n !== BUILTIN_PROVIDER);
  }

  /**
   * 列出全部 provider 及其可用性快照（供 memory_provider_list / stats）。
   * isAvailable() 按 §9.2 约束 6 不发起网络请求，可安全同步调用；仍包 try 防
   * 劣质实现抛错污染整个列表。
   */
  describe() {
    return this.list().map((name) => {
      const p = this.providers.get(name);
      let available = false;
      let unavailableReason = '';
      let error = null;
      try {
        available = p.isAvailable() === true;
        if (!available && typeof p.unavailableReason === 'function') {
          unavailableReason = String(p.unavailableReason() ?? '');
        }
      } catch (e) {
        error = e?.message ?? String(e);
      }
      const report = this.reports.get(name);
      return {
        name,
        isBuiltin: name === BUILTIN_PROVIDER,
        available,
        unavailableReason: unavailableReason || null,
        error,
        // 只暴露版本号，不暴露 provider 内部状态
        preCompressCheckpointApiVersion: p.preCompressCheckpointApiVersion ?? 1,
        toolCount: this.safeToolCount(p),
        registered: report?.valid ?? false,
        recommendedOverrides: report?.recommended ?? [],
      };
    });
  }

  safeToolCount(p) {
    try {
      const s = p.getToolSchemas();
      return Array.isArray(s) ? s.length : 0;
    } catch {
      return 0;
    }
  }

  /** 校验报告（含被拒绝者），供排障 */
  report(name) {
    return this.reports.get(name) ?? null;
  }

  /** 清空（测试 / reload 用） */
  clear() {
    this.providers.clear();
    this.reports.clear();
  }
}

export { ProviderRegistry };
