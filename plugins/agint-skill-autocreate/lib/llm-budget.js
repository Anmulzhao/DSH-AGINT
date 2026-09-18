/**
 * agint-skill-autocreate: llm-budget — LLM 调用的每日硬预算（2026-09-18）。
 *
 * 来源：LLM 接入 autocreate 方案 §9。三条约束：
 *   ① 口径按**本地日切**（与 `agint-cron` 一致——cron 用的是本地时间，
 *      见 `agint-cron/lib/cron.js`）。用 UTC 日切会让「今天还剩多少」在
 *      东八区的晚上算错一天。
 *   ② **shadow 期同样计费**——shadow 也是真调用、真花钱。
 *   ③ 预算耗尽**不报错**，静默跳回轨道 B，但要留痕（`llm_budget_exhausted`），
 *      否则又变成「分不清是没有还是被拦了」（K59 教训）。
 *
 * 计数来源：复用 `audit_log` 里的 `llm_judge_called` 条数（由调用方注入
 * `loadUsed`）。**刻意不加新表**——autocreate 的 storage domain 是有
 * schemaVersion 的冻结域，加表要动 `storage.js` 的 spec 并面对存量记录兼容
 * 问题（09-18 刚因 Sprint 14 老记录 schema 错配踩过一次，见 `invalidRecords`
 * 注释）。审计表本来就有 1000 条滚动上限，日均 ≤20 条的调用量远在其内。
 *
 * 纯逻辑 + 注入式持久化，可直接单测（不碰 storage）。
 */

/** 本地日键（YYYY-MM-DD）。与 cron 的本地时间口径一致。 */
export function localDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return 'invalid';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 每日预算计数器。
 *
 * @param {object} args
 * @param {number|(() => number)} args.limit 每日上限（0 = 全禁，等于一个额外的
 *        kill-switch）。传函数则每次求值——运行时改配置立即生效。
 * @param {(day: string) => Promise<number>} [args.loadUsed] 恢复当日已用次数
 *        （进程重启不丢预算的依据）
 * @param {(d: Date) => string} [args.dayKey] 注入便于单测
 * @returns {{
 *   take: () => Promise<{ok: boolean, firstRejection: boolean}>,
 *   refund: () => Promise<void>,
 *   snapshot: () => Promise<{day: string, used: number, limit: number, remaining: number}>,
 * }}
 */
export function createDailyBudget({ limit, loadUsed = async () => 0, dayKey = localDayKey } = {}) {
  const limitOf = typeof limit === 'function'
    ? () => Math.max(0, Math.floor(Number(limit()) || 0))
    : () => Math.max(0, Math.floor(Number(limit) || 0));
  let day = null;
  let used = 0;
  let exhaustedLogged = false;   // 「当天首次耗尽」只记一次，防刷日志

  async function sync() {
    const today = dayKey(new Date());
    if (day === today) return;
    day = today;
    exhaustedLogged = false;
    let restored = 0;
    try {
      restored = Number(await loadUsed(today)) || 0;
    } catch {
      restored = 0;   // 恢复失败按 0 算：宁可多花几次，也不因读不到审计就把 LLM 全关
    }
    used = Math.max(0, restored);
  }

  return {
    /** 取一个配额。ok=false 表示当天已耗尽（调用方应回落轨道 B）。 */
    async take() {
      await sync();
      if (used >= limitOf()) {
        const first = !exhaustedLogged;
        exhaustedLogged = true;
        return { ok: false, firstRejection: first };
      }
      used += 1;
      return { ok: true, firstRejection: false };
    },
    /** 退还配额：调用其实没发生（服务不可用 / schema 自检失败等零成本早退）。 */
    async refund() {
      await sync();
      if (used > 0) used -= 1;
    },
    async snapshot() {
      await sync();
      const lim = limitOf();
      return { day, used, limit: lim, remaining: Math.max(0, lim - used) };
    },
  };
}
