/**
 * agint-family-panel: BROWSER half (native docked panel).
 *
 * Registered as a lazy module factory whose id equals the package name, so the
 * shell's module table resolves it exactly like an official client plugin. It
 * owns no DOM of its own: both surfaces are the shell's own seats —
 *
 *   - `sidebar.panellist`  : one entry row (icon + label) in the shell's list
 *   - `main` (keyed)       : the panel page in the center column
 *
 * Both go through `ctx.slots.inject`, so a shell that never declares a seat
 * leaves the panel simply absent instead of failing boot. The panel id is the
 * address the layout uses for both seats, exactly as the sidebar contract
 * requires, and switching seats is the layout service's job
 * (`ctx.layout.selectPanel`), never a DOM takeover.
 *
 * Styling rules followed here (host plugin UI discipline):
 *   - only `--dsw-alias-*` theme tokens, so light/dark follow the host;
 *   - no Harness client package is required at runtime (they are not API);
 *   - the page is an entry-style page, so it honours
 *     `--dsh-frame-top-clearance` like the Plugin Manager does.
 */
window.__ModuleLoader__.load({
  id: 'agint-family-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Panel id: addresses BOTH the sidebar row and the main keyed slot. */
    const PANEL_ID = 'agint-family';

    /** Row order among the shell's global panel rows (Plugins 0, Schedule 10, task board 20). */
    const PANEL_ORDER = 40;

    /**
     * Document-relative API path. The host registers root-absolute, but index
     * is served with `<base href="./">`: keeping the leading slash would let a
     * sub-path deployment escape its entry directory.
     */
    const API_PATH = 'api/agint-family/status';

    /**
     * v2 整页的文档相对路径（同 API_PATH 的 base-href 纪律）。0.2.1 起 v2 是
     * 停靠面板的默认视图（iframe 内嵌），这个路径同时用作内嵌 src 与「新标签页
     * 打开」的目标；不用 data.apiPrefix 的根绝对路径，防子路径部署逃逸。
     */
    const V2_PATH = 'api/agint-family/v2';

    /** Auto refresh interval while the panel is mounted. */
    const REFRESH_MS = 60000;

    /**
     * One signal's state to a token-backed color. Unknown reads stay amber on
     * purpose: "we could not tell" is not the same as "fine".
     * @param {string} state - signal or row state.
     * @returns {string} a CSS color expression.
     */
    function stateColor(state) {
      if (state === 'ok' || state === 'active' || state === 'loaded') {
        return 'var(--dsw-alias-state-success-primary, #2f9e5f)';
      }
      if (state === 'error' || state === 'failed') {
        return 'var(--dsw-alias-state-error-primary, #d64545)';
      }
      if (state === 'unknown' || state === 'unavailable') {
        return 'var(--dsw-alias-state-warn-primary, #c98a1b)';
      }
      return 'var(--dsw-alias-label-tertiary, #8a8a8a)';
    }

    /** Human label for a row state. */
    function stateLabel(state) {
      const table = {
        active: '已激活', loaded: '已加载', failed: '失败', error: '失败',
        disabled: '已停用', unknown: '状态未读到', pending: '等待中', loading: '加载中',
      };
      return table[state] ?? state;
    }

    /**
     * Fetch the snapshot without ever handing a non-JSON body to JSON.parse.
     * An unmounted host half answers an /api path with the plain text
     * "not found", which would otherwise surface as a JavaScript parse error.
     * @param {AbortSignal} signal - abort signal.
     * @returns {Promise<object>} the payload; `ok:false` carries `error`.
     */
    async function fetchStatus(signal) {
      let response;
      try {
        response = await fetch(API_PATH, { headers: { accept: 'application/json' }, signal });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return { ok: false, error: '宿主半不可达（插件未挂载或 dsh web 未重启）' };
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, error: `宿主半未挂载（返回非 JSON：${String(text).slice(0, 60)}）` };
      }
      if (!response.ok) {
        return { ok: false, error: (data && data.error) ? String(data.error) : `HTTP ${response.status}` };
      }
      return data;
    }

    /** Component-local CSS: tokens only, so both themes follow the host. */
    function PanelStyles() {
      return h('style', null, [
        `.agintfp-root{font:inherit;color:var(--dsw-alias-label-primary,inherit);
          padding:var(--dsh-frame-top-clearance,48px) 24px 24px;box-sizing:border-box;
          min-width:0;overflow-y:auto;height:100%}`,
        `.agintfp-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}`,
        `.agintfp-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));
          border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-l1,transparent);min-width:0}`,
        `.agintfp-row{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 0}`,
        `.agintfp-name{font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          color:var(--dsw-alias-label-secondary,inherit)}`,
        `.agintfp-btn{font:inherit;cursor:pointer;border-radius:8px;padding:5px 12px;
          border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));
          background:var(--dsw-alias-button-elevated-fill,transparent);
          color:var(--dsw-alias-label-primary,inherit)}`,
        `.agintfp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}`,
        `.agintfp-dot{width:8px;height:8px;border-radius:50%;flex:none}`,
      ].join('\n'));
    }

    /** A small headline with an optional trailing control cluster. */
    function Head({ title, subtitle, children }) {
      return h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 } },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 18, fontWeight: 600 } }, title),
          subtitle ? h('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary,inherit)' } }, subtitle) : null,
        ),
        h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } }, children),
      );
    }

    /** One count chip. */
    function Chip({ label, value, color }) {
      return h('div', { className: 'agintfp-card', style: { padding: '8px 12px' } },
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,inherit)' } }, label),
        h('div', { style: { fontSize: 20, fontWeight: 600, color: color || 'var(--dsw-alias-label-primary,inherit)' } }, String(value)),
      );
    }

    /** One signal row: label, value, and the reason when it is not ok. */
    function SignalRow({ signal }) {
      const ok = signal.state === 'ok';
      return h('div', { className: 'agintfp-row' },
        h('span', { className: 'agintfp-dot', style: { background: stateColor(signal.state) } }),
        h('span', { className: 'agintfp-name', style: { color: 'var(--dsw-alias-label-secondary,inherit)' } }, signal.label),
        h('span', { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-primary,inherit)' } },
          ok
            ? (signal.value === null ? (signal.note || '通电') : String(signal.value))
            : (signal.reason || '未通电'),
        ),
      );
    }

    /** One plugin row inside a group card. */
    function MemberRow({ member }) {
      const state = member.disabled ? 'disabled' : member.status;
      return h('div', { className: 'agintfp-row' },
        h('span', { className: 'agintfp-dot', style: { background: stateColor(state) } }),
        h('span', { className: 'agintfp-name', title: member.id }, member.id.replace(/^agint-/, '')),
        h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-tertiary,inherit)', flex: 'none' } }, stateLabel(state)),
      );
    }

    /** The panel page. */
    function FamilyPanel({ ctx }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      // 0.2.1：v2 内嵌为默认视图；v1 名册（分组/信号）保留可切换。
      const [view, setView] = React.useState('v2');
      const frameRef = React.useRef(null);
      const [frameH, setFrameH] = React.useState(0);

      // 0.2.2：v2 iframe 自适应内页高度（同源直读 scrollHeight；跨域或未就绪
      // 退回视口高兜底）。外层 .agintfp-root 统一滚动，与 v1 的整页下拉一致；
      // 内页滚到底不再撞在半高窗口里。load 后 3s 轮询兜异步取数引起的高度变化。
      React.useEffect(() => {
        if (view !== 'v2') return undefined;
        const f = frameRef.current;
        if (!f) return undefined;
        let ro = null;
        let poll = null;
        let alive = true;
        const sync = () => {
          if (!alive) return;
          try {
            const doc = f.contentDocument;
            if (!doc || !doc.documentElement) return;
            const hgt = Math.max(
              doc.documentElement.scrollHeight,
              doc.body ? doc.body.scrollHeight : 0,
            );
            if (hgt > 120) setFrameH(hgt + 24);
          } catch { /* 同源读不了：维持兜底高度，不抛 */ }
        };
        const onLoad = () => {
          sync();
          try {
            if (typeof ResizeObserver === 'function') {
              ro = new ResizeObserver(sync);
              if (f.contentDocument && f.contentDocument.body) ro.observe(f.contentDocument.body);
            }
          } catch { /* RO 挂不上就只靠轮询 */ }
          poll = setInterval(sync, 3000);
        };
        f.addEventListener('load', onLoad);
        sync();
        return () => {
          alive = false;
          if (ro) { try { ro.disconnect(); } catch {} }
          if (poll) clearInterval(poll);
          f.removeEventListener('load', onLoad);
        };
      }, [view]);

      const load = React.useCallback(async () => {
        setLoading(true);
        try {
          const controller = new AbortController();
          const result = await fetchStatus(controller.signal);
          if (result.ok === false) {
            setError(result.error);
            setData(null);
          } else if (result.enabled === false) {
            setError(null);
            setData({ ...result, switchedOff: true });
          } else {
            setError(null);
            setData(result);
          }
        } catch (err) {
          if (err && err.name !== 'AbortError') setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const run = () => { if (alive) void load(); };
        run();
        const timer = setInterval(run, REFRESH_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [load]);

      const back = () => {
        try {
          const layout = ctx && ctx.get ? ctx.get('layout') : null;
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null);
        } catch { /* layout absent: nothing to switch back to */ }
      };

      const body = (() => {
        if (error !== null) {
          return h('div', { className: 'agintfp-card' },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '读不到家族状态'),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,inherit)' } }, String(error)),
          );
        }
        if (data === null) {
          return h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary,inherit)' } }, loading ? '载入中…' : '暂无数据');
        }
        if (data.switchedOff) {
          return h('div', { className: 'agintfp-card' },
            h('div', { style: { fontWeight: 600 } }, '面板已被 kill-switch 关闭'),
            h('div', { style: { fontSize: 12, marginTop: 6, color: 'var(--dsw-alias-label-secondary,inherit)' } },
              'host 半仍在监听，把 agint-family-panel 的 enabled 改回 true 并重启 dsh web 即可恢复。'),
          );
        }
        if (view === 'v2') {
          return h('iframe', {
            ref: frameRef,
            title: 'AGINT 家族 v2 面板（Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定）',
            src: V2_PATH,
            scrolling: frameH > 0 ? 'no' : 'auto',
            style: {
              display: 'block', width: '100%',
              height: frameH > 0 ? `${frameH}px` : 'calc(100vh - 190px)',
              minHeight: 480,
              border: '1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22))', borderRadius: 10,
              background: 'var(--dsw-alias-bg-l1,transparent)',
            },
          });
        }
        const counts = data.counts || {};
        return h('div', { style: { display: 'grid', gap: 16 } },
          h('div', { className: 'agintfp-grid' },
            h(Chip, { label: '家族插件', value: counts.total ?? 0 }),
            h(Chip, { label: '已激活', value: counts.active ?? 0, color: stateColor('ok') }),
            h(Chip, { label: '失败', value: counts.failed ?? 0, color: stateColor('failed') }),
            h(Chip, { label: '已停用', value: counts.disabled ?? 0 }),
            h(Chip, { label: '状态未读到', value: counts.unknown ?? 0, color: stateColor('unknown') }),
          ),
          h('div', { className: 'agintfp-card' },
            h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '通电信号'),
            (data.signals || []).map((signal) => h(SignalRow, { key: signal.key, signal })),
          ),
          h('div', { className: 'agintfp-grid' },
            (data.groups || []).map((group) => h('div', { key: group.id, className: 'agintfp-card' },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, group.label),
              h('div', { style: { fontSize: 11, marginBottom: 8, color: 'var(--dsw-alias-label-tertiary,inherit)' } },
                `${group.members.length} 个成员`),
              group.members.length === 0
                ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,inherit)' } }, '（该组无行挂载）')
                : group.members.map((member) => h(MemberRow, { key: member.id, member })),
            )),
          ),
          (data.unmappedIds && data.unmappedIds.length > 0)
            ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,inherit)' } },
              `分组表待补：${data.unmappedIds.join('、')}`)
            : null,
          data.rosterError
            ? h('div', { style: { fontSize: 12, color: stateColor('error') } }, `roster 读取失败：${data.rosterError}`)
            : null,
        );
      })();

      return h('div', { className: 'agintfp-root', 'data-dsh-plugin': 'agint-family-panel' },
        h(PanelStyles, null),
        h(Head, {
          title: 'AGINT 家族',
          subtitle: data && data.generatedAt ? `快照 ${new Date(data.generatedAt).toLocaleString('zh-CN')}` : '家族插件总览',
        },
          h('button', {
            type: 'button', className: 'agintfp-btn',
            title: view === 'v2' ? '切回 v1 名册视图（分组 / 行状态 / 通电信号）' : '切回 v2 面板视图（Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定）',
            onClick: () => setView(view === 'v2' ? 'v1' : 'v2'),
          }, view === 'v2' ? '切换到 v1 名册' : '切换到 v2 面板'),
          h('button', {
            type: 'button', className: 'agintfp-btn',
            onClick: () => {
              if (view === 'v2' && frameRef.current) {
                setFrameH(0);
                frameRef.current.src = V2_PATH + '?r=' + Date.now();
              } else void load();
            },
          }, loading && view === 'v1' ? '刷新中…' : '刷新'),
          h('button', {
            type: 'button', className: 'agintfp-btn',
            title: '在新标签页打开 v2 整页',
            onClick: () => window.open(V2_PATH, '_blank', 'noopener'),
          }, '新标签页打开'),
          h('button', { type: 'button', className: 'agintfp-btn', onClick: back }, '返回会话'),
        ),
        body,
      );
    }

    /**
     * The sidebar row glyph. The shell owns the button, label and rail; this
     * draws only the glyph, like every other panel row.
     */
    function PanelIcon({ size }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 8, cy: 3.4, r: 1.6 }),
        h('circle', { cx: 3.6, cy: 12, r: 1.6 }),
        h('circle', { cx: 12.4, cy: 12, r: 1.6 }),
        h('path', { d: 'M8 5v3M8 8 4 10.6M8 8l4 2.6' }),
      );
    }

    return {
      /** Only the slot registry is a hard dependency; layout is probed lazily. */
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        if (!slots || typeof slots.inject !== 'function') return;
        const disposers = [];

        // Both seats are declared by shell plugins this package does not own at
        // runtime, so each registration waits for its seat. A shell without the
        // seat leaves the panel absent; it never fails the GUI.
        const register = (seat, options, component) => {
          try {
            disposers.push(slots.inject(seat, () => slots.register(options, component)));
          } catch (err) {
            console.error('[agint-family-panel] seat registration failed:', seat, err);
          }
        };

        register('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: 'AGINT 家族',
        }, PanelIcon);

        register('main', {
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ ctx }),
        }, FamilyPanel);

        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose(); } catch { /* teardown must not throw */ }
          }
        }, 'agint-family-panel: seats');
      },
    };
  },
});
