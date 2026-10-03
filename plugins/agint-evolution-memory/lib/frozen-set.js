/**
 * agint-evolution-memory: Frozen 基准集快照（Phase 0.1 / Sprint 19）
 *
 * ## 这张表回答的问题
 *
 * 三层隔离（Evolution / Validation / Frozen）的全部价值押在一句话上：
 * **Frozen 集自冻结以来没被改过**。这句话以前只是文档里的一句承诺 —— 没有任何
 * artifact 记录过「当时冻结了哪些单元、各自内容是什么」。本模块就是那个 artifact
 * 的写入口：清单重生成 / Frozen 集增长时落一条快照，日后可比对。
 *
 * ## ⛔ 只增不改，与 recordContractLock 同一条纪律
 *
 * 同 setId 二次写入 ⇒ 抛 `frozen-set-already-exists`。
 * 允许覆盖 = 重算一遍新 hash 盖掉旧值 ⇒ 篡改不留痕 ⇒ 这张表名存实亡。
 *
 * ## ⛔ 本模块不自己算 hash
 *
 * 聚合算法在 `bin/lib/scenario-tier.mjs` 的 `frozenAggregateHash()`。
 * 本插件不 import eval 侧的脚本（跨层 import 会让插件依赖仓库目录结构，
 * 部署位没有 `eval/`）。hash 由 caller 算好传进来 —— 见 index.js 的接线注释。
 *
 * ## ⛔ 不直写存储文件
 *
 * 宿主把整个 unit 读进内存、每次 put 用内存态整体重写文件（last-write-wins，
 * 取证见 `lib/ledger.js` 头部）。所以本服务**只能跑在宿主里**，由宿主服务方法
 * / cron 调用；`bin/anchor-frozen-set.mjs` 因此只做只读预览。
 */

import { benchmarkFrozenSetSchema, LIMITS } from './schema.js';

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

/**
 * `frozen-<ISO 去冒号>`。同一毫秒内连落两条 ⇒ setId 相同 ⇒ 被去重逻辑挡下并报错，
 * 这正是想要的（静默生成第二个 id 会让「同一时刻两条基线」这件事看不出来）。
 */
export function deriveSetId(capturedAt) {
  return `frozen-${String(capturedAt).replace(/[:.]/g, '-')}`;
}

/**
 * H5「只增不减」的核对器：next 必须包含 prev 的全部成员。
 *
 * @param {string[]} prevIds 上一版快照的 Frozen 名单
 * @param {string[]} nextIds 这一版
 * @returns {{ok: boolean, removed: string[], added: string[]}}
 */
export function diffFrozenIds(prevIds = [], nextIds = []) {
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  const removed = [...prev].filter((id) => !next.has(id)).sort();
  const added = [...next].filter((id) => !prev.has(id)).sort();
  return { ok: removed.length === 0, removed, added };
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getTable 表句柄获取器（宿主 KvTableImpl 形状）
 * @param {() => string} deps.now               注入时钟（ISO），保证测试可重现
 * @param {(msg: string, extra?: object) => void} [deps.warn]
 * @param {(key: string, n?: number) => void} [deps.bump]
 */
export function createFrozenSetService({ getTable, now, warn = () => {}, bump = () => {} }) {
  if (typeof getTable !== 'function') throw new TypeError('createFrozenSetService: getTable 必须是函数');
  if (typeof now !== 'function') throw new TypeError('createFrozenSetService: now 必须是函数');

  /**
   * 落一条冻结集快照。
   *
   * @param {object} p
   * @param {string} [p.setId]        不给则由 capturedAt 推导
   * @param {string} [p.capturedAt]   不给则用注入时钟 now()
   * @param {string} p.tieringVersion
   * @param {string[]} [p.frozenUnitIds]
   * @param {string} p.frozenAggregateHash `sha256:<64 hex>`（caller 算，见文件头）
   * @param {number} [p.inventoryTotalUnits]
   * @param {number} [p.failCount]
   * @param {number} [p.h1EvolutionMinFail]
   * @param {number} [p.h3FrozenFailProbeCap]
   * @param {string} p.source         谁写的（无 provenance 的留证不可信）
   * @param {string} [p.note]
   * @returns {Promise<object>} 落盘后的 entry
   * @throws 同 setId 已存在 ⇒ Error('frozen-set-already-exists')
   * @throws 缺必填 / 形状非法 ⇒ zod 抛错（⛔ 不静默补默认值）
   */
  async function record(p = {}) {
    const capturedAt = p.capturedAt ?? now();
    const setId = p.setId ?? deriveSetId(capturedAt);
    const t = await getTable();

    // 幂等保护放在**写之前**，且用表里的真实状态判，不用内存缓存 ——
    // 缓存会漏掉「另一个进程刚写了一条」这种情况。
    if (t.get(setId)) {
      bump('frozenSet.duplicate');
      throw new Error('frozen-set-already-exists');
    }

    const entry = benchmarkFrozenSetSchema.parse({
      setId,
      capturedAt,
      tieringVersion: p.tieringVersion,
      frozenCount: Array.isArray(p.frozenUnitIds) ? p.frozenUnitIds.length : 0,
      frozenUnitIds: p.frozenUnitIds ?? [],
      frozenAggregateHash: p.frozenAggregateHash,
      inventoryTotalUnits: Number(p.inventoryTotalUnits ?? 0),
      failCount: Number(p.failCount ?? 0),
      h1EvolutionMinFail: Number(p.h1EvolutionMinFail ?? 0),
      h3FrozenFailProbeCap: Number(p.h3FrozenFailProbeCap ?? 0),
      source: p.source,
      note: p.note ?? '',
    });

    await t.put(entry.setId, entry);
    bump('frozenSet.recorded');

    const count = t.size;
    // ⛔ 只 warn 不 prune：删一条就抹掉一段「当时冻结集是什么」的历史。
    if (count > LIMITS.BENCHMARK_FROZEN_SETS) {
      warn(`frozenSet: benchmark_frozen_set ${count} 行 > 上限 ${LIMITS.BENCHMARK_FROZEN_SETS}`
        + ' —— 只告警不删除（删历史 = 自毁防篡改基线）');
    }
    return { ...entry };
  }

  /**
   * 取一条快照。
   * @param {string} setId
   * @returns {Promise<object|null>} 找不到返回 null
   *
   * ⚠️ 「找不到」≠「没被篡改」。缺失要由 caller 判成 UNKNOWN，不能判成 PASS
   * （继承教训：把「字段不存在」当「检查通过」= 假防线）。
   */
  async function get(setId) {
    if (!setId) return null;
    const t = await getTable();
    const rec = t.get(setId);
    return rec ? { ...rec } : null;
  }

  /**
   * 全部快照，按 capturedAt 升序。
   * H5 的核对走这条序列：相邻两条用 diffFrozenIds 判子集关系。
   * @returns {Promise<Array<object>>}
   */
  async function list() {
    const t = await getTable();
    const out = [];
    for (const [, rec] of t.entries()) out.push({ ...rec });
    out.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    return out;
  }

  /**
   * 拿**当前**算出的聚合 hash 去比一条历史快照。
   *
   * 这是防篡改检查真正被用到的那一次调用：hash 变了 ⇒ 名单或某个单元的内容变了。
   *
   * @param {object} p
   * @param {string} p.setId
   * @param {string} p.frozenAggregateHash caller 现算的值
   * @returns {Promise<{ok: boolean, code: string, detail?: string, expected?: string, actual?: string}>}
   *
   * ⛔ 缺失/异常一律 code='UNKNOWN' 而不是 ok=true —— 没证据时不许放过。
   */
  async function verify(p = {}) {
    const { setId, frozenAggregateHash } = p;
    if (!setId) return { ok: false, code: 'MISSING_SET_ID', detail: '必须给 setId' };
    if (typeof frozenAggregateHash !== 'string' || frozenAggregateHash === '') {
      return { ok: false, code: 'MISSING_HASH', detail: '必须给当前算出的 frozenAggregateHash' };
    }
    try {
      const rec = await get(setId);
      if (!rec) {
        return { ok: false, code: 'UNKNOWN', detail: `快照 ${setId} 不存在 ⇒ 无从比对（不是「通过」）` };
      }
      if (rec.frozenAggregateHash !== frozenAggregateHash) {
        bump('frozenSet.mismatch');
        return {
          ok: false,
          code: 'TAMPERED',
          detail: 'Frozen 集内容与快照不一致：名单增删或某单元内容被改',
          expected: rec.frozenAggregateHash,
          actual: frozenAggregateHash,
        };
      }
      bump('frozenSet.verified');
      return { ok: true, code: 'INTACT' };
    } catch (err) {
      return { ok: false, code: 'UNKNOWN', detail: `比对过程出错：${errMessage(err)}` };
    }
  }

  return { record, get, list, verify };
}
