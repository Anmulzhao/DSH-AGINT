/**
 * agint-restart: BROWSER half —— composer dock 上的两个手动控制按钮。
 *
 * 形态与 dsh-kill-switch 的按钮同构：注册为 lazy module factory（id 等于包名），
 * 挂 `conversation.composer.dock` 席位，点击变成一条 slash 命令的 draft，
 * 经 composer 自己的 adjudication 管道提交。**不新开 HTTP 口。**
 *
 * 为什么走命令通道而不是 fetch 一个 loopback 路由
 * ────────────────────────────────────────────────
 * 第三方插件的做法是：host 半起一个本机 HTTP 网关，按钮 POST 过去，GET 读方案。
 * 那是把门开在自家院墙上。本插件同宿主进程内已有 commands 服务，走它有三重好处：
 *   1. 零新增网络暴露面（本插件的 network 权限只用于读就绪 lease 的回环探测）；
 *   2. 护栏结论有回执 —— 冷却期 / 熔断 / 单在途这些拒绝理由会回到会话里，
 *      而 fetch 拿到 202 只知道「请求被受理」，不知道最后成没成；
 *   3. 老板手打 `/restart-dsh` 与点按钮是同一条路径，一个操作一份实现。
 *
 * 代价（如实记下）：`inputActions.submit()` 无返回值，按钮拿不到命令回执。
 * 所以按钮**不谎称成功** —— 它只显示「已提交」，真实结论看会话里的命令回执。
 *
 * 席位契约（cordis_inspect_list / Slots.listSubTree，client 平台，2026-10-05 实查）：
 *   name=conversation.composer.dock · kind=list · scope=session
 *   registration: { id: string(required), order?: number, label?: string | (() => string) }
 *   standardProps 含 inputActions: InputActions
 */
window.__ModuleLoader__.load({
  id: 'agint-restart',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const NS = 'agint-restart';
    const SLOT = 'conversation.composer.dock';
    const ENTRY_ID = 'agint-restart';
    const ORDER = 20; // 原「终止 DSH」按钮的位置
    const COMMAND_RESTART = '/restart-dsh';
    const COMMAND_STOP = '/stop-dsh';
    /** 第二次点击的有效期。 */
    const ARM_MS = 4000;

    const EN = {
      title: 'DSH control',
      restartIdle: 'Restart DSH',
      restartArmed: 'Click again to restart',
      stopIdle: 'Stop DSH',
      stopArmed: 'Click again to stop',
      sending: 'Submitting…',
      sent: 'Submitted. Restart: the page disconnects and comes back on its own. Stop: the page disconnects and stays gone. If the page stays, the command was refused — run the same line in the composer to see why.',
      noComposer: 'This composer has no input actions — run the command here instead.',
      warnRestart: 'Restarting interrupts every running session.',
      warnStop: 'Stopping kills the process tree and does not bring DSH back. Open the page again to start it.',
    };

    const ZH = {
      title: 'DSH 控制',
      restartIdle: '重启 DSH',
      restartArmed: '再次点击以重启',
      stopIdle: '终止 DSH',
      stopArmed: '再次点击以终止',
      sending: '正在提交…',
      sent: '已提交。重启：页面断开后自己回来。终止：页面断开且不再回来。若页面没断，说明命令被拒，可在本输入框手动敲同一条命令看原因。',
      noComposer: '该输入框没有可用的输入动作 —— 请在此手动敲命令。',
      warnRestart: '重启会中断所有进行中的会话。',
      warnStop: '终止会杀掉整棵进程树且不会拉起新实例。要再用请重新打开页面。',
    };

    /** Two-phase button: a single mis-click must never end the host. */
    function ArmButton({ inputActions, idle, armed, sending, title, danger, onSubmit }) {
      const [phase, setPhase] = useState('idle');
      const [left, setLeft] = useState(0);

      useEffect(() => {
        if (phase !== 'armed') return undefined;
        const started = Date.now();
        const timer = setInterval(() => {
          const rest = ARM_MS - (Date.now() - started);
          if (rest <= 0) { setPhase('idle'); setLeft(0); } else { setLeft(rest); }
        }, 100);
        return () => clearInterval(timer);
      }, [phase]);

      const click = useCallback(() => {
        if (phase === 'armed') {
          setPhase('sending');
          onSubmit();
          return;
        }
        setPhase('armed');
        setLeft(ARM_MS);
      }, [phase, onSubmit]);

      const label = phase === 'armed'
        ? `${armed} (${Math.ceil(left / 1000)})`
        : (phase === 'sending' ? sending : idle);

      return h('button', {
        type: 'button',
        onClick: click,
        disabled: !inputActions || phase === 'sending',
        title: inputActions ? title : EN.noComposer,
        'data-dsh-plugin': 'agint-restart',
        'data-dsh-part': danger ? 'stop' : 'restart',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          marginRight: '6px',
          padding: '2px 8px',
          fontSize: '12px',
          lineHeight: '18px',
          cursor: inputActions && phase !== 'sending' ? 'pointer' : 'default',
          borderRadius: '6px',
          border: `1px solid ${phase === 'armed' && danger
            ? 'var(--dsw-alias-state-error-primary, #d64545)'
            : 'var(--dsw-alias-border-default, var(--dsw-alias-label-tertiary, #8a8a8a))'}`,
          background: 'transparent',
          color: phase === 'armed' && danger
            ? 'var(--dsw-alias-state-error-primary, #d64545)'
            : 'var(--dsw-alias-label-secondary, inherit)',
        },
      },
        phase === 'armed'
          ? h('span', {
            style: {
              display: 'inline-block',
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: 'currentColor',
            },
          })
          : null,
        label,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        const stopEn = ctx.locale.register(NS, 'en', EN);
        const stopZh = ctx.locale.register(NS, 'zh', ZH);

        function DockControls({ inputActions }) {
          const [note, setNote] = useState('');

          // setDraft + submit is the composer's own InputActions contract. No RPC
          // is involved, so this half needs no host bridge and cannot drift from
          // the host's command registry.
          const submit = useCallback((command) => {
            if (!inputActions) return;
            try {
              inputActions.setDraft(command);
              inputActions.submit();
              setNote(t('sent'));
            } catch (err) {
              console.error('[agint-restart] dock button submit failed:', command, err);
              setNote(String(err?.message ?? err));
            }
          }, [inputActions, t]);

          return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
            h(ArmButton, {
              key: 'restart',
              inputActions,
              idle: t('restartIdle'),
              armed: t('restartArmed'),
              sending: t('sending'),
              title: t('warnRestart'),
              danger: false,
              onSubmit: () => submit(COMMAND_RESTART),
            }),
            h(ArmButton, {
              key: 'stop',
              inputActions,
              idle: t('stopIdle'),
              armed: t('stopArmed'),
              sending: t('sending'),
              title: t('warnStop'),
              danger: true,
              onSubmit: () => submit(COMMAND_STOP),
            }),
            note
              ? h('span', {
                key: 'note',
                role: 'status',
                style: {
                  fontSize: '11px',
                  lineHeight: '16px',
                  color: 'var(--dsw-alias-label-secondary)',
                },
              }, note)
              : null,
          );
        }

        const stopSlots = ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, order: ORDER, label: () => t('title') },
          DockControls,
        ));

        return () => {
          stopSlots();
          stopZh();
          stopEn();
        };
      },
    };
  },
});
