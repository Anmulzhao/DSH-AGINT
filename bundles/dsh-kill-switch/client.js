/**
 * Browser half of the kill-switch bundle.
 *
 * Renders one button in the composer dock. It holds no process logic: the click
 * becomes a `kill-dsh` command line that the host half owns, so the button and
 * the composer slash command cannot drift apart.
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
      // The host only *schedules* the kill at this point; nothing has died yet,
      // so the copy says scheduled. Claiming "stopped" here was the v1 lie.
      sent: 'Stop scheduled. The page will disconnect in a moment.',
      failed: 'Could not stop DSH',
    }

    const ZH = {
      title: '终止 DSH',
      idle: '终止 DSH',
      armed: '再次点击以终止',
      sending: '正在终止…',
      // 此刻宿主只是**排程**了终止，还没有进程真的死掉 —— 所以说"已排程"，不说"已终止"。
      sent: '已排程终止，页面即将断开。',
      failed: '终止失败',
    }

    return {
      inject: ['slots', 'remote', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const stopEn = ctx.locale.register(NS, 'en', EN)
        const stopZh = ctx.locale.register(NS, 'zh', ZH)

        function KillButton({ sessionId }) {
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

          const send = useCallback(async () => {
            setPhase('sending')
            setNote('')
            try {
              const result = await ctx.remote.commands.execute(sessionId, COMMAND, [])
              if (!result || result.ok !== true) {
                const detail = result && result.error
                  ? `${result.error.code}: ${result.error.message}`
                  : 'the host refused the call'
                throw new Error(detail)
              }
              if (result.value === undefined) {
                throw new Error('the /kill-dsh command is not registered on this host')
              }
              const settled = result.value.result
              if (settled && settled.kind === 'error') throw new Error(settled.text)
              setNote((settled && settled.text) || t('sent'))
            } catch (error) {
              setPhase('idle')
              setNote(`${t('failed')}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }, [sessionId, t])

          const onClick = () => {
            if (phase === 'idle') {
              setNote('')
              setPhase('armed')
            } else if (phase === 'armed') {
              void send()
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
