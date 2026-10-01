/**
 * Browser half of the kill-switch bundle.
 *
 * Renders one button in the composer dock. It holds no process logic: the click
 * becomes a `/kill-dsh` draft that the composer submits through its own
 * adjudication pipeline, which is exactly the path a human gets by typing the
 * command — one operation, one implementation, two human-facing callers.
 *
 * ── v2.0.1 修正：v1 用的 `ctx.remote.commands.execute(...)` 从未存在 ──────
 * v1.0.0 写的是 `ctx.remote.commands.execute(sessionId, '/kill-dsh', [])`。
 * 取证（cordis_inspect_list，client 平台，2026-10-01）显示客户端一共只有 8 个服务：
 * layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces ——
 * **没有 remote，也没有 commands**。点按钮必然抛
 * `cannot get property "remote.commands" without inject`。
 *
 * 正确通道是 composer 自己的 InputActions（slot 标准 prop，契约定义见
 * dsh-client-ui-conversation/lib/types/client/contract/input.d.ts）：
 *   setDraft('/kill-dsh') → submit() → adjudication → host 侧 kill-dsh handler
 * 这条路径完全不需要 RPC，也不需要 dynamic Plugin 的 `host` builtin。
 *
 * The action ends this page, so it takes two deliberate clicks and a visible
 * countdown — a single mis-click should never be able to stop the host.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-kill-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'dsh-kill-switch'
    const SLOT = 'conversation.composer.dock'
    const COMMAND = '/kill-dsh'
    /** How long the second click stays open. */
    const ARM_MS = 4000

    const EN = {
      title: 'Kill DSH',
      idle: 'Stop DSH',
      armed: 'Click again to stop',
      sending: 'Stopping…',
      // Honest limits of this path: we submit the command but get no return value
      // back (submit() is void, and the page is about to die anyway). "Submitted"
      // is all we can claim — and if the page does NOT go blank, the command was
      // refused; `/kill-dsh` in the composer is the manual way to find out why.
      sent: 'Stop submitted. The page will disconnect. If it stays, the command was refused — try /kill-dsh in the composer.',
      failed: 'Could not stop DSH',
      noComposer: 'This composer has no input actions — run /kill-dsh here instead.',
    }

    const ZH = {
      title: '终止 DSH',
      idle: '终止 DSH',
      armed: '再次点击以终止',
      sending: '正在终止…',
      // 这条路径拿不到宿主回执（submit() 无返回值，页面也马上就要断），所以只能说
      // 「已提交」。若页面没断，就是命令被拒了 —— 用 /kill-dsh 手动查原因。
      sent: '已提交终止，页面即将断开。若页面没断，说明命令被拒，可在本输入框手动输 /kill-dsh 排查。',
      failed: '终止失败',
      noComposer: '该输入框没有可用的输入动作 —— 请在此手动输 /kill-dsh。',
    }

    return {
      // `remote` removed in v2.0.1: it was never a client Service, and declaring it
      // is exactly what made the click fail. `slots` and `locale` are the real needs.
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const stopEn = ctx.locale.register(NS, 'en', EN)
        const stopZh = ctx.locale.register(NS, 'zh', ZH)

        // `inputActions` arrives as a slot standard prop (see the catalog in
        // dsh-client-ui-conversation contract/slots.d.ts). It is per-session, which
        // is why this slot is session-scoped.
        function KillButton({ inputActions }) {
          const [phase, setPhase] = useState('idle')
          const [left, setLeft] = useState(0)
          const [note, setNote] = useState('')

          // `t` reads the active locale at call time; this subscription is what
          // makes a locale switch repaint the label. It has to live in the
          // component — a hook call in `apply` is not a render and React rejects it.
          const [, setLocaleTick] = useState(0)
          useEffect(() => ctx.locale.subscribe(() => setLocaleTick((n) => n + 1)), [])

          useEffect(() => {
            if (phase !== 'armed') return undefined
            const started = Date.now()
            const tick = () => {
              const remaining = Math.max(0, ARM_MS - (Date.now() - started))
              setLeft(remaining)
              if (remaining === 0) setPhase('idle')
            }
            tick()
            const handle = setInterval(tick, 200)
            return () => clearInterval(handle)
          }, [phase])

          const send = useCallback(() => {
            // A slot occupant is not guaranteed to receive every standard prop
            // (replaceRisk is "none" here, but a future owner could narrow it).
            // Degrade to an actionable message instead of throwing inside a click.
            if (!inputActions || typeof inputActions.submit !== 'function') {
              setPhase('idle')
              setNote(t('noComposer'))
              return
            }
            setPhase('sending')
            setNote('')
            try {
              // The same two steps a human takes: type the slash line, press Enter.
              // The composer arbitrates the leading `/` and routes it to the host
              // handler registered as `kill-dsh`.
              //
              // Side effect worth stating plainly: setDraft replaces the whole draft,
              // so anything already typed in the composer is discarded. For a stop
              // control that is an acceptable trade — a draft is worth far less than
              // a host that refuses to stop — but it is not silent.
              inputActions.setDraft(COMMAND)
              inputActions.submit()
              setNote(t('sent'))
            } catch (error) {
              setPhase('idle')
              setNote(`${t('failed')}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }, [inputActions, t])

          const onClick = () => {
            if (phase === 'idle') {
              setNote('')
              setPhase('armed')
            } else if (phase === 'armed') {
              send()
            }
          }

          const danger = phase !== 'idle'
          const seconds = Math.ceil(left / 1000)
          const label =
            phase === 'sending' ? t('sending')
            : phase === 'armed' ? `${t('armed')} · ${seconds}s`
            : t('idle')

          return h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
              },
            },
            h(
              'button',
              {
                type: 'button',
                onClick,
                disabled: phase === 'sending',
                title: t('title'),
                'aria-live': 'polite',
                style: {
                  appearance: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '3px 10px',
                  fontSize: '12px',
                  lineHeight: '18px',
                  fontFamily: 'inherit',
                  borderRadius: '6px',
                  cursor: phase === 'sending' ? 'progress' : 'pointer',
                  opacity: phase === 'sending' ? 0.7 : 1,
                  border: `1px solid var(${danger ? '--dsw-alias-state-error-primary' : '--dsw-alias-border-l1'})`,
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: `var(${danger ? '--dsw-alias-state-error-primary' : '--dsw-alias-label-secondary'})`,
                },
              },
              h('span', {
                'aria-hidden': true,
                style: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: 'currentColor' },
              }),
              label,
            ),
            note
              ? h('span', {
                  role: 'status',
                  style: {
                    fontSize: '11px',
                    lineHeight: '16px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                }, note)
              : null,
          )
        }

        const stopSlots = ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: 'dsh-kill-switch', order: 20, label: () => t('title') },
          KillButton,
        ))

        return () => {
          stopSlots()
          stopZh()
          stopEn()
        }
      },
    }
  },
})
