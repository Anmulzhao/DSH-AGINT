/**
 * agint-cron host-schedule bridge —— 行动 #2a：接入宿主原生调度 dsh-schedule（0.1.7-rc.2）。
 *
 * ## 落地目标（对报告 §6.1-1 的实现）
 *
 * 1. **cron 语义宿主化**：agint-cron 的全部 job 表达式交给宿主的
 *    `canonicalizeCronExpression` 校验/归一化 —— "分钟级重复 / 运行记录 / 重启保留"
 *    的语义与宿主 schedule domain（MIN_EVERY_INTERVAL_SECONDS / tasks 表）对齐，
 *    消除自研解析与宿主方言的漂移风险。
 * 2. **宿主调度可见性**：提供宿主 `ctx.schedule.catalog()` 的只读镜像（过滤
 *    `agint-cron:` 前缀），让"宿主原生调度已接入"成为可观测事实而非推断。
 * 3. **全软依赖**：宿主未挂 dsh-schedule / 动态 import 失败 → 返回
 *    `hostAvailable:false`，agint-cron 既有 tick 执行零影响（向后兼容）。
 *
 * ## 边界（先读再改）
 *
 * - 本桥**不**调用 `schedule.create()`：dsh-schedule 的投递语义是"提醒注入
 *   agent session"，而 agint-cron 的 job 是 host 平面无人值守的 action 直调。
 *   用 create() 投递会把无人值守 job 变成 agent 消息 —— 行为变更，留待拍板。
 * - 桥内所有宿主交互都是只读（catalog）或纯校验（canonicalize），无持久写。
 * - cron 方言沿用 agint-cron 的 5 段标准（m h dom mon dow，dow 0=周日）；
 *   dsh 的 canonicalizeCronExpression 兼容该方言。
 */

// 宿主模块懒加载缓存（同一进程只解析一次；解析失败保持 null 不重试）。
let _hostModule = null;
let _hostLoaded = false;

/**
 * 动态加载宿主 @deepseek-ai/dsh-schedule。
 * 测试可注入 { __loader } 覆盖实际 import（避免测试环境包解析依赖）。
 * @returns {{ ok: true, module: object } | { ok: false, reason: string }}
 */
export async function loadHostSchedule({ __loader } = {}) {
  if (_hostLoaded) {
    return _hostModule ? { ok: true, module: _hostModule } : { ok: false, reason: 'host-unavailable' };
  }
  _hostLoaded = true;
  try {
    const mod = __loader ? await __loader() : await import('@deepseek-ai/dsh-schedule');
    if (mod && typeof mod.canonicalizeCronExpression === 'function') {
      _hostModule = mod;
      return { ok: true, module: mod };
    }
    _hostModule = null;
    return { ok: false, reason: 'host-module-incomplete' };
  } catch (error) {
    _hostModule = null;
    return { ok: false, reason: `import-failed:${error?.message ?? String(error)}` };
  }
}

/**
 * 用宿主 canonicalizeCronExpression 校验并归一化一个 cron 表达式。
 * @param {string} cron 5 段 cron 表达式
 * @param {object|null} host 宿主模块（loadHostSchedule 结果），null = 未接入
 * @returns {{ ok: true, expression: string } | { ok: false, reason: string }}
 */
export function canonicalizeWithHost(cron, host) {
  if (!host || typeof host.canonicalizeCronExpression !== 'function') {
    return { ok: false, reason: 'host-unavailable' };
  }
  try {
    const expression = host.canonicalizeCronExpression(String(cron ?? ''));
    return { ok: true, expression };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/**
 * 批量校验全部 job 的 cron 表达式（行动 #2a 核心判据）。
 * @param {Array<{id: string, schedule: string}>} jobs
 * @param {object|null} host 宿主模块；null → 全部标 host-unavailable
 * @returns {{ hostAvailable: boolean, valid: number, invalid: Array<{id: string, schedule: string, error: string}> }}
 */
export function validateJobSchedules(jobs = [], host = null) {
  const invalid = [];
  let valid = 0;
  for (const job of jobs) {
    if (!job?.id || !job?.schedule) {
      invalid.push({ id: job?.id ?? '<missing>', schedule: job?.schedule ?? '', error: 'job spec incomplete' });
      continue;
    }
    const r = canonicalizeWithHost(job.schedule, host);
    if (r.ok) valid += 1;
    else invalid.push({ id: job.id, schedule: job.schedule, error: r.reason });
  }
  return { hostAvailable: Boolean(host), valid, invalid };
}

/** 宿主 schedule catalog 条目的 title 前缀（agint 镜像标记）。 */
export const MIRROR_TITLE_PREFIX = 'agint-cron:';

/**
 * 只读镜像宿主 schedule.catalog()：过滤 title 带 agint-cron: 前缀的记录。
 * @param {object|null} service 宿主 ctx.schedule 服务实例；null/无 catalog → 降级
 * @returns {Promise<{ ok: true, entries: Array, catalogSize: number } | { ok: false, reason: string }>}
 */
export async function mirrorCatalog(service = null) {
  if (!service || typeof service.catalog !== 'function') {
    return { ok: false, reason: 'schedule service unavailable' };
  }
  try {
    const all = await service.catalog();
    const entries = Array.isArray(all)
      ? all.filter((e) => String(e?.title ?? '').startsWith(MIRROR_TITLE_PREFIX))
      : [];
    return { ok: true, entries, catalogSize: Array.isArray(all) ? all.length : 0 };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/**
 * 组装 host-plane 调度桥（供 agint-cron 的 apply 使用）。
 * @param {object} deps
 * @param {Function} deps.getService 调用时 ctx.get（软依赖，不缓存）
 * @param {Array<{id: string, schedule: string}>} deps.jobs 当前 job 表（静态快照）
 * @param {Function} [deps.__loader] 测试注入的宿主模块加载器
 * @returns {{ status(): object, validateSchedules(): Promise<object>, mirrorCatalog(): Promise<object> }}
 */
export function createHostBridge({ getService, jobs, __loader } = {}) {
  const hostCache = { value: null, state: 'idle' }; // 'idle' | 'loading' | 'ready' | 'failed'
  const ensureHost = async () => {
    if (hostCache.state === 'ready') return hostCache.value;
    if (hostCache.state === 'loading') {
      // 并发调用共享同一次加载：轮询等待
      while (hostCache.state === 'loading') await new Promise((r) => setTimeout(r, 10));
      return hostCache.value;
    }
    hostCache.state = 'loading';
    const r = await loadHostSchedule({ __loader });
    hostCache.value = r.ok ? r.module : null;
    hostCache.state = r.ok ? 'ready' : 'failed';
    return hostCache.value;
  };

  return {
    /** 宿主调度接入状态（同步可读，不触发加载）。 */
    status() {
      return {
        hostAvailable: hostCache.state === 'ready',
        hostModule: hostCache.state === 'ready',
        hostState: hostCache.state,
        jobs: (jobs ?? []).length,
      };
    },

    /** 校验全部 job 的 cron（懒加载宿主模块，失败降级为 host-unavailable）。 */
    async validateSchedules() {
      const host = await ensureHost();
      return validateJobSchedules(jobs ?? [], host);
    },

    /** 只读镜像宿主 schedule.catalog（agint-cron: 前缀）。 */
    async mirrorCatalog() {
      const service = typeof getService === 'function' ? getService('schedule') : null;
      return mirrorCatalog(service);
    },
  };
}

// 测试用：允许重置模块级缓存（避免跨测试文件污染）。
export function _resetHostCache() {
  _hostModule = null;
  _hostLoaded = false;
}
