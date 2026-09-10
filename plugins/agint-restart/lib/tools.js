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
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-restart-tools';
const inject = ['tools', 'agint.restart'];

function apply(ctx) {
  const restart = ctx['agint.restart'];

  ctx.tools.register(defineTool({
    name: 'restart_status',
    description: '查看 DSH 重启插件状态：当前 pid、本次是否检测到重启、冷却剩余、熔断计数、上次重启结果与拉起命令快照。只读，无副作用。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          pid: { type: 'number', required: true },
          bootAt: { type: 'string', required: true },
          wasRestart: { type: 'boolean', required: true },
          cooldownRemainingMs: { type: 'number', required: true },
          burst: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              windowMs: { type: 'number', required: true },
              max: { type: 'number', required: true },
              count: { type: 'number', required: true },
              tripped: { type: 'boolean', required: true },
            },
          },
          pending: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true },
          lastRestart: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true },
          historyCount: { type: 'number', required: true },
          lastResult: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true },
          launch: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              command: { type: 'string', required: true },
              cwd: { type: 'string', required: true },
              args: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
      },
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
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      return Promise.resolve(restart.status());
    },
  }));

  ctx.tools.register(defineTool({
    name: 'restart_request',
    description: '请求重启 DSH 服务。会中断所有进行中的会话，必须显式 confirm:true。流程：写请求文件 → detached 拉起守护脚本 → 当前进程延迟退出 → 守护脚本等旧进程退出并释放 3080 端口后拉起新 dsh → 等就绪。受冷却期与熔断保护。',
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
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
          requestId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          shutdownInMs: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          plan: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true },
          targetPid: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
        },
      },
      render: (_a, v) => {
        const lines = [`restart_request: accepted=${v.accepted} code=${v.code}`, `  ${v.message}`];
        if (v.requestId) lines.push(`  requestId=${v.requestId}`);
        if (v.shutdownInMs != null) lines.push(`  当前进程将在 ${v.shutdownInMs}ms 后退出`);
        if (v.plan) {
          lines.push(`  plan: targetPid=${v.plan.targetPid} waitExit=${v.plan.waitExitMs}ms forceKill=${v.plan.forceKillAfterMs}ms`);
          lines.push(`        launch=${v.plan.launch.command} ${v.plan.launch.args.join(' ')}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(args) {
      return Promise.resolve(restart.request(args ?? {}));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'restart_cancel',
    description: '清除在途的重启请求标记。注意：若守护脚本已经 detached 启动，取消只能阻止后续请求，已排程的拉起仍需人工确认。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          cancelled: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
          requestId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `restart_cancel: cancelled=${v.cancelled} (${v.code}) ${v.message}` }],
    },
    execute() {
      return Promise.resolve(restart.cancel());
    },
  }));
}

export { apply, inject, name };
