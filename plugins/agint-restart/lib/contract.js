/**
 * agint-restart: 工具输出契约（单一事实源）
 *
 * ── 为什么需要这个文件（v0.4.4 教训，2026-09-10 实测）──
 * 工具 output schema 走 dsh-tools 的严格校验：`additionalProperties: false` +
 * 逐字段 `required: true`。schema 声明与运行时返回值一旦漂移，工具链**在副作用
 * 已经发生之后**才报错：
 *
 *   Error: tool "restart_request" returned invalid output:
 *     missing required property "value.code"; missing required property "value.plan"
 *
 * 而那次调用其实已经写了请求文件、拉起守护脚本、旧进程 3 秒后退出（restart.log
 * 有完整记录）。调用方只看到 Error → 极易重试 → **重复重启**（本次靠 cooldown
 * 60s + burst 3/600s 兜住）。根因：accepted=true 分支的手写返回字面量漏了
 * `code`（schema 里是 required）。
 *
 * ── 结构 ──
 *   字段表（key + DSL + fallback）
 *     ├─ → *_OutputSchema()   给 tools.js 用（不再手写字段）
 *     ├─ → normalize*Output() 兜底：缺 required 补默认值、未声明字段丢弃并写进 message
 *     └─ → *Result()          各分支构造函数，给 index.js 用（不再手写返回字面量）
 *
 * 由此"声明的字段"与"返回的字段"绑在同一张表上；test/smoke.mjs 对每个 *Result()
 * 产物做一次全量 schema 校验（缺字段 / 多字段 / 类型错）——v0.4.3 那套"正则抠
 * 源码字面量"的脆弱断言已删除（它正是漏检 code 的原因）。
 *
 * ── 关于 sideEffect ──
 * v0.4.4 新增字段：本次调用**是否已经推进了重启链路**（写请求文件 + 拉起守护脚本，
 * 即进程确定会在 shutdownInMs 后退出）。
 *   - 护栏拒绝 / dryRun / manual → false
 *   - accepted                    → true
 *   - 内部异常                     → 按实际已完成的步骤判定（可能 true）
 * 它是给"看到异常时"用的：Error 本身不携带这个信息，返回值里有。
 * 该字段**不设默认值**（漏了就漏了，不能让兜底把 true 悄悄写成 false）。
 */

/** 可空类型 DSL（必填）。 */
function nullable(type) {
  return { oneOf: [{ type }, { type: 'null' }], required: true };
}

/** 可空类型 DSL（可选：不声明 required）。 */
function optionalNullable(type) {
  return { oneOf: [{ type }, { type: 'null' }] };
}

/** launch 快照（拉起命令三元组）。 */
const LAUNCH_DSL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true },
    cwd: { type: 'string', required: true },
    args: { type: 'array', required: true, items: { type: 'string' } },
  },
};

// ── restart_request ────────────────────────────────────────────────────────

const REQUEST_FIELDS = [
  { key: 'accepted', dsl: { type: 'boolean', required: true }, fallback: false },
  { key: 'code', dsl: { type: 'string', required: true }, fallback: 'unknown' },
  { key: 'message', dsl: { type: 'string', required: true }, fallback: '' },
  { key: 'requestId', dsl: nullable('string'), fallback: null },
  { key: 'shutdownInMs', dsl: nullable('number'), fallback: null },
  // plan 只有 dryRun 有内容，但 schema 标了 required：所有其它分支必须显式给 null
  { key: 'plan', dsl: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true }, fallback: null },
  { key: 'targetPid', dsl: nullable('number'), fallback: null },
  // 可选：不设默认值（见文件头说明）
  { key: 'sideEffect', dsl: { type: 'boolean' } },
  { key: 'launch', dsl: { oneOf: [LAUNCH_DSL, { type: 'null' }] } },
  { key: 'resultFile', dsl: optionalNullable('string') },
  { key: 'command', dsl: optionalNullable('string') },
  { key: 'cooldownRemainingMs', dsl: optionalNullable('number') },
  { key: 'count', dsl: optionalNullable('number') },
];

/**
 * 被护栏拒绝的统一返回。
 * @param {string} code 机器可读原因（needs-confirm / cooldown / tripped / ...）
 * @param {string} message 给人看的一句话
 * @param {object} [extra] 附加字段（cooldownRemainingMs / count / command / launch ...）
 */
export function requestDeny(code, message, extra = {}) {
  return {
    accepted: false,
    code,
    message,
    requestId: null,
    shutdownInMs: null,
    plan: null,
    targetPid: null,
    sideEffect: false,
    ...extra,
  };
}

/** dryRun：只返回将要发生的动作，零副作用。 */
export function requestDryRun({ requestId, targetPid, shutdownInMs, plan }) {
  return {
    accepted: false,
    code: 'dry-run',
    message: 'dryRun：未执行，以下是将要发生的动作',
    requestId,
    targetPid,
    shutdownInMs,
    plan,
    sideEffect: false,
  };
}

/** 真重启已排程（请求文件已写 + 守护脚本已拉起 + 本进程即将退出）。 */
export function requestAccepted({ requestId, targetPid, shutdownInMs, launch, resultFile }) {
  return {
    accepted: true,
    // ⚠️ v0.4.4：这一行就是 2026-09-10 事故的根因（漏了它，schema required 校验
    // 在副作用发生后失败）。别再手写这个对象——用本构造函数。
    code: 'scheduled',
    message: `已安排重启：${shutdownInMs}ms 后当前进程退出，由守护脚本拉起新实例`,
    requestId,
    targetPid,
    shutdownInMs,
    plan: null,
    sideEffect: true,
    launch,
    resultFile,
  };
}

/** manual 模式：只给可复制命令，零动作。 */
export function requestManual({ command, launch }) {
  return requestDeny('manual-mode', '当前为 manual 模式，未自动重启', { command, launch });
}

/**
 * 内部异常的统一返回（v0.4.4 核心）。
 * 绝不抛异常给调用方——异常信息里没有"副作用是否已发生"，返回对象里有。
 * @param {{error?: any, requestId?: string|null, fileWritten?: boolean, guardianStarted?: boolean, requestFile?: string}} p
 */
export function requestInternalError({ error, requestId = null, fileWritten = false, guardianStarted = false, requestFile = '' } = {}) {
  const detail = String(error?.message ?? error ?? 'unknown').split('\n')[0];
  let hint;
  if (guardianStarted) {
    hint = '守护脚本已拉起，本进程随后会退出、新实例随后上线——不要重复调用，用 restart_status 看 pending / lastRestart 确认';
  } else if (fileWritten) {
    hint = `请求文件已写入 ${requestFile}，但守护脚本未启动，本次不会重启；可安全重试`;
  } else {
    hint = '未产生任何副作用，可安全重试';
  }
  return {
    accepted: false,
    code: 'internal-error',
    message: `内部错误：${detail}。${hint}`,
    requestId: fileWritten ? requestId : null,
    shutdownInMs: null,
    plan: null,
    targetPid: null,
    sideEffect: guardianStarted === true,
  };
}

// ── restart_cancel ─────────────────────────────────────────────────────────

const CANCEL_FIELDS = [
  { key: 'cancelled', dsl: { type: 'boolean', required: true }, fallback: false },
  { key: 'code', dsl: { type: 'string', required: true }, fallback: 'unknown' },
  { key: 'message', dsl: { type: 'string', required: true }, fallback: '' },
  { key: 'requestId', dsl: nullable('string'), fallback: null },
  { key: 'sideEffect', dsl: { type: 'boolean' } },
];

/**
 * 取消结果。
 * ⚠️ no-pending 分支此前漏了 requestId（schema required）——同一类漂移，v0.4.4 一并修。
 * @param {{cancelled: boolean, code?: string, message: string, requestId?: string|null, sideEffect?: boolean}} p
 */
export function cancelResult({ cancelled, code, message, requestId = null, sideEffect = false }) {
  return { cancelled, code, message, requestId, sideEffect };
}

/** cancel 自身异常（服务不可用 / 内部抛错）。 */
export function cancelInternalError(error) {
  const detail = String(error?.message ?? error ?? 'unknown').split('\n')[0];
  return cancelResult({
    cancelled: false,
    code: 'internal-error',
    message: `内部错误：${detail}。未确认在途标记状态，若刚发起过重启请用 restart_status 看 pending`,
  });
}

// ── restart_status ─────────────────────────────────────────────────────────

const STATUS_FIELDS = [
  { key: 'enabled', dsl: { type: 'boolean', required: true }, fallback: false },
  { key: 'mode', dsl: { type: 'string', required: true }, fallback: 'unknown' },
  { key: 'pid', dsl: { type: 'number', required: true }, fallback: 0 },
  { key: 'bootAt', dsl: { type: 'string', required: true }, fallback: '' },
  { key: 'wasRestart', dsl: { type: 'boolean', required: true }, fallback: false },
  // v0.5.0：本次启动是否由插件自己的重启请求导致（true 时默认不发恢复通知，用于切断重启环）
  { key: 'selfRestart', dsl: { type: 'boolean', required: true }, fallback: false },
  { key: 'selfRestartRequestId', dsl: optionalNullable('string') },
  { key: 'cooldownRemainingMs', dsl: { type: 'number', required: true }, fallback: 0 },
  {
    key: 'burst',
    dsl: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        windowMs: { type: 'number', required: true },
        max: { type: 'number', required: true },
        count: { type: 'number', required: true },
        tripped: { type: 'boolean', required: true },
      },
    },
    fallback: () => ({ windowMs: 0, max: 0, count: 0, tripped: false }),
  },
  { key: 'pending', dsl: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true }, fallback: null },
  { key: 'lastRestart', dsl: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true }, fallback: null },
  { key: 'historyCount', dsl: { type: 'number', required: true }, fallback: 0 },
  { key: 'lastResult', dsl: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true }, fallback: null },
  { key: 'launch', dsl: { ...LAUNCH_DSL, required: true }, fallback: () => ({ command: '', cwd: '', args: [] }) },
  // v0.4.4：status() 自身异常时用来带说明（正常路径为 null）
  { key: 'error', dsl: optionalNullable('string') },
];

/** status 自身异常：返回 schema 合法的降级快照，而不是抛异常。 */
export function statusUnavailable(error) {
  const detail = String(error?.message ?? error ?? 'unknown').split('\n')[0];
  return { mode: 'unavailable', error: `status 自身异常：${detail}` };
}

// ── 通用机械 ───────────────────────────────────────────────────────────────

/** 字段表 → dsh-tools 值 schema DSL（properties 对象）。 */
function compileOutputSchema(fields) {
  const properties = {};
  for (const f of fields) properties[f.key] = f.dsl;
  return { type: 'object', additionalProperties: false, properties };
}

export const requestOutputSchema = () => compileOutputSchema(REQUEST_FIELDS);
export const cancelOutputSchema = () => compileOutputSchema(CANCEL_FIELDS);
export const statusOutputSchema = () => compileOutputSchema(STATUS_FIELDS);

// 导出字段表本身，供测试做"schema ⊇ 分支返回"的结构化交叉校验（不再正则抠源码）
export { REQUEST_FIELDS, CANCEL_FIELDS, STATUS_FIELDS };

/**
 * 兜底：把任意对象裁剪/补齐成 schema 合法形状。
 * 只在分支代码漂移时才会真的动到值——一旦动了，就把"补了什么、丢了什么"写进 message，
 * 让模型看得见（否则静默修补会掩盖 bug）。
 * @returns {{value: object, repaired: string[], dropped: string[]}}
 */
function normalize(fields, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const value = {};
  const repaired = [];
  const dropped = [];
  for (const f of fields) {
    const has = Object.prototype.hasOwnProperty.call(src, f.key) && src[f.key] !== undefined;
    if (has) {
      value[f.key] = src[f.key];
    } else if (f.dsl.required === true) {
      value[f.key] = typeof f.fallback === 'function' ? f.fallback() : f.fallback;
      repaired.push(f.key);
    }
  }
  for (const k of Object.keys(src)) {
    if (!fields.some((f) => f.key === k)) dropped.push(k);
  }
  if (repaired.length || dropped.length) {
    const note = `[契约兜底 v0.4.4] 缺少 schema 必填字段，已补默认值：${repaired.join(', ') || '无'}；`
      + `未声明字段已丢弃：${dropped.join(', ') || '无'}。`
      + '请把该分支改回 lib/contract.js 的 *Result() 构造函数（否则调用方会拿到错误语义）。';
    // 说明只能写进 schema 已声明的字段，否则补丁本身会把对象再弄脏：
    //   request / cancel 有 message；status 用 error
    const noteKey = fields.some((f) => f.key === 'message') ? 'message'
      : (fields.some((f) => f.key === 'error') ? 'error' : null);
    if (noteKey) value[noteKey] = value[noteKey] ? `${value[noteKey]} ${note}` : note;
    // 同时在 host 日志留痕，便于事后排查
    console.warn(`[agint-restart] output contract repaired: ${note}`);
  }
  return { value, repaired, dropped };
}

export const normalizeRequestOutput = (raw) => normalize(REQUEST_FIELDS, raw);
export const normalizeCancelOutput = (raw) => normalize(CANCEL_FIELDS, raw);
export const normalizeStatusOutput = (raw) => normalize(STATUS_FIELDS, raw);
