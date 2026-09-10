/**
 * agint-restart: preset-scoped tools (restart_status / restart_request / restart_cancel).
 * Consumes the host agint.restart service (v0.2.0).
 *
 * Preset row (agent.cordis.yml):
 *   - id: agint-restart-tools
 *     name: ../../profiles/web/plugins/agint-restart/lib/tools.js
 *
 * 安全约定：
 *   - restart_request 必须显式 confirm:true（防止模型/脚本误触导致会话中断）
 *   - 服务侧还有三重护栏：cooldown / 熔断（窗口内次数上限）/ 单在途请求
 *   - dryRun:true 只返回将要执行的计划，不做任何动作
 *
 * NOTE on schemas: 值 schema DSL 从对象 properties 里的 `required: true` 收集必填；
 * 根节点与嵌套值节点（oneOf 分支 / array items）不要再声明 required。
 * 且**任何 type:'object' 必须显式 additionalProperties**（K19，否则整条 preset 拒绝挂载）。
 *
 * ── v0.4.4：schema 与返回值的单一事实源搬到 lib/contract.js ──
 * 本文件不再手写任何输出字段。原因见 contract.js 文件头：schema / 返回值漂移时，
 * 工具链会在**副作用已经发生之后**才报 `returned invalid output`（2026-09-10 实测，
 * accepted=true 分支漏了 required 的 code），调用方只看到 Error，容易重复重启。
 * 现在每个 execute 都：① 不抛异常 ② 结果过一遍 normalize*Output 兜底。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  requestOutputSchema, statusOutputSchema, cancelOutputSchema,
  normalizeRequestOutput, normalizeStatusOutput, normalizeCancelOutput,
  requestInternalError, cancelInternalError, statusUnavailable,
} from './contract.js';

const name = 'agint-restart-tools';
const inject = ['tools', 'agint.restart'];

/**
 * execute 兜底：服务调用抛异常时，也要给调用方一个 schema 合法、且说明状态的返回。
 * @param {object} service agint.restart 服务
 * @param {string} method 方法名
 * @param {(raw: object) => {value: object}} normalize 对应契约的归一化函数
 * @param {(err: any) => object} onError 该工具失败时的返回构造器（形状必须匹配自己的契约）
 */
function safe(service, method, normalize, onError) {
  try {
    if (!service || typeof service[method] !== 'function') {
      return normalize(onError(new Error(`agint.restart.${method} 不可用`))).value;
    }
    return normalize(service[method]()).value;
  } catch (err) {
    return normalize(onError(err)).value;
  }
}

function apply(ctx) {
  const restart = ctx['agint.restart'];

  ctx.tools.register(defineTool({
    name: 'restart_status',
    description: '查看 DSH 重启插件状态：当前 pid、本次是否检测到重启、冷却剩余、熔断计数、上次重启结果与拉起命令快照。只读，无副作用。',
    parameters: {},
    output: {
      // schema 由 lib/contract.js 生成（单一事实源，防 v0.4.4 那类漂移）
      schema: statusOutputSchema(),
      render: (_a, v) => {
        const lines = [
          `restart_status: mode=${v.mode} pid=${v.pid} wasRestart=${v.wasRestart}`,
          `  boot=${v.bootAt}`,
          `  cooldown=${Math.round(v.cooldownRemainingMs / 1000)}s  burst=${v.burst.count}/${v.burst.max} (${v.burst.windowMs / 1000}s) tripped=${v.burst.tripped}`,
          `  pending=${v.pending ? v.pending.requestId : 'none'}  history=${v.historyCount}`,
          `  launch= ${v.launch.command} ${v.launch.args.join(' ')}`,
          `  cwd= ${v.launch.cwd}`,
        ];
        if (v.lastRestart) lines.push(`  lastRestart=${v.lastRestart.at} (${v.lastRestart.requestId}) ${v.lastRestart.reason || ''}`);
        if (v.lastResult) lines.push(`  lastResult=ok=${v.lastResult.ok} newPid=${v.lastResult.newPid ?? '-'} ready=${v.lastResult.ready ?? '-'}`);
        if (v.error) lines.push(`  ⚠️ status 自身异常：${v.error}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      return Promise.resolve(safe(restart, 'status', normalizeStatusOutput, statusUnavailable));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'restart_request',
    description: '请求重启 DSH 服务。会中断所有进行中的会话，必须显式 confirm:true。流程：写请求文件 → detached 拉起守护脚本 → 当前进程延迟退出 → 守护脚本等旧进程退出并释放 3080 端口后拉起新 dsh → 等就绪。受冷却期与熔断保护。返回值里的 sideEffect 说明本次是否已经真的推进了重启链路（看到任何异常先看它，别盲目重试）。',
    // 注意：值 schema DSL 里 `required` 只要出现就必须是 true（dsh-tools
    // lib/index.js:602 会 authorError），所以可选参数**不要写** required:false。
    parameters: {
      confirm: { type: 'boolean', required: true, description: '必须为 true，确认你确实要重启（会中断会话）。' },
      reason: { type: 'string', description: '重启原因，写入历史与日志，便于事后追溯。' },
      delayMs: { type: 'number', description: '发出请求后延迟多少毫秒再退出当前进程（默认 3000，用于让调用方拿到返回值）。' },
      dryRun: { type: 'boolean', description: 'true = 只返回将要执行的计划，不实际重启。' },
      force: { type: 'boolean', description: 'true = 跳过 confirm 与冷却期（不跳过熔断）。' },
    },
    output: {
      schema: requestOutputSchema(),
      render: (_a, v) => {
        const lines = [`restart_request: accepted=${v.accepted} code=${v.code} sideEffect=${v.sideEffect === true}`, `  ${v.message}`];
        if (v.requestId) lines.push(`  requestId=${v.requestId}`);
        if (v.shutdownInMs != null) lines.push(`  当前进程将在 ${v.shutdownInMs}ms 后退出`);
        if (v.plan) {
          lines.push(`  plan: targetPid=${v.plan.targetPid} waitExit=${v.plan.waitExitMs}ms forceKill=${v.plan.forceKillAfterMs}ms`);
          lines.push(`        launch=${v.plan.launch.command} ${v.plan.launch.args.join(' ')}`);
        }
        if (v.code === 'internal-error') lines.push('  → 先看上面 message 里的副作用判定，再决定是否重试（或先跑 restart_status）');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(args) {
      // 服务侧 request() 自身也不抛（见 lib/index.js 的 request 包装），这里是第二道网
      try {
        const raw = typeof restart?.request === 'function'
          ? restart.request(args ?? {})
          : requestInternalError({ error: new Error('agint.restart.request 不可用') });
        return Promise.resolve(normalizeRequestOutput(raw).value);
      } catch (err) {
        return Promise.resolve(normalizeRequestOutput(requestInternalError({ error: err })).value);
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'restart_cancel',
    description: '清除在途的重启请求标记。注意：若守护脚本已经 detached 启动，取消只能阻止后续请求，已排程的拉起仍需人工确认。',
    parameters: {},
    output: {
      schema: cancelOutputSchema(),
      render: (_a, v) => [{ type: 'text', text: `restart_cancel: cancelled=${v.cancelled} (${v.code}) ${v.message}` }],
    },
    execute() {
      return Promise.resolve(safe(restart, 'cancel', normalizeCancelOutput, cancelInternalError));
    },
  }));
}

export { apply, inject, name };
