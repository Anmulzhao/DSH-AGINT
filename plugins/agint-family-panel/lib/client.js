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

    /**
     * 档案页的数据源：v2 整页的实时聚合端点。
     *
     * 为什么不新开一条 `/dossier?id=` 路由（v0.4.0 的取舍）：
     * 档案要的东西横跨四类事实 —— 插件自述（manifest/CHANGELOG/代码体量）、依赖边
     * （scan.hits）、实测产出（tools/cron/bus）、归因表。这些全在 `/v2/data` 里，
     * 而且**只有一份**。另开路由要么重算一遍（两套口径必然漂），要么做切片（切片
     * 的筛选条件又是一套口径）。整页视图已经在用这份 payload，档案页直接复用它，
     * 口径只有一个。代价是单次 ~180KB：本地回环 + 60s 缓存，点击即开，可接受。
     */
    const V2_DATA_PATH = 'api/agint-family/v2/data';

    /** 档案数据的进程内缓存：面板常开时避免每次点插件都重拉。 */
    const BOARD_TTL_MS = 60000;
    const boardCache = { at: 0, payload: null, error: null };

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

    /**
     * 拉取面板全量聚合 payload（含档案层），带 60s 缓存。
     * 失败一律返回 `{ok:false,error}`，绝不把非 JSON 正文交给 JSON.parse ——
     * 宿主半没挂载时 /api 路径回的是纯文本，那会把解析错误伪装成插件故障。
     * @param {AbortSignal} [signal]
     * @param {{force?:boolean}} [opts]
     */
    async function fetchBoard(signal, opts) {
      const now = Date.now();
      const force = Boolean(opts && opts.force);
      if (!force && boardCache.payload && now - boardCache.at < BOARD_TTL_MS) return boardCache.payload;
      let response;
      try {
        response = await fetch(V2_DATA_PATH, { headers: { accept: 'application/json' }, signal });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return { ok: false, error: '宿主半不可达（档案数据端点未挂载）' };
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, error: `宿主半未挂载或未重启（返回非 JSON：${String(text).slice(0, 60)}）` };
      }
      if (!response.ok || (data && data.ok === false)) {
        return { ok: false, error: (data && data.error) ? String(data.error) : `HTTP ${response.status}` };
      }
      boardCache.at = now;
      boardCache.payload = data;
      return data;
    }

    /**
     * 7 天产出曲线。与整页视图同一条纪律：全表统一 √ 尺度（线性会让大插件把
     * 其余压成贴底直线），跨行可直接比较高低。
     */
    function sparkline(values, max) {
      const arr = Array.isArray(values) ? values : [];
      if (!arr.some((v) => v > 0)) return null;
      const w = 96, hgt = 22, base = hgt - 1;
      const cap = Math.max(1, max || 1);
      const x = (i) => (i * (w / (arr.length - 1))).toFixed(1);
      const y = (v) => (base - Math.sqrt(Math.min(v, cap) / cap) * (hgt - 5)).toFixed(1);
      const pts = arr.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      return h('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, 'aria-label': '近 7 天产出曲线', role: 'img' },
        h('line', { x1: 0, y1: base, x2: w, y2: base, stroke: 'currentColor', strokeWidth: 1, opacity: 0.2 }),
        h('polygon', { points: `0,${base} ${pts} ${w},${base}`, fill: 'currentColor', opacity: 0.12 }),
        h('polyline', { points: pts, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      );
    }

    /**
     * 把 `/v2/data` 的 payload 建成**按插件取用**的索引。
     *
     * 派生逻辑放在这里（浏览器侧）而不是 host 侧的理由：host 已经有唯一一份
     * payload，再在 host 里派生一份等于开第二个口径；放在消费端，两个视图用
     * 同一堆原始事实（hits / tools / cron / bus / dossiers）。归因表本身是
     * 从 payload 取的（`owners`），不是本地常量。
     */
    function buildDossierIndex(P) {
      const hits = Array.isArray(P.scan?.hits) ? P.scan.hits : [];
      const provided = (P.scan?.provided && typeof P.scan.provided === 'object') ? P.scan.provided : {};
      const owners = (P.owners && typeof P.owners === 'object') ? P.owners : null;
      const toolTable = Array.isArray(owners?.tool) ? owners.tool : [];
      const cronTable = (owners?.cron && typeof owners.cron === 'object') ? owners.cron : {};
      const hostKeys = new Set(Array.isArray(owners?.hostKeys) ? owners.hostKeys : []);
      const byId = (P.dossiers && P.dossiers.byId && typeof P.dossiers.byId === 'object') ? P.dossiers.byId : {};
      const order = Array.isArray(P.dossiers?.order) && P.dossiers.order.length
        ? P.dossiers.order
        : Object.keys(byId).sort();

      const ownerOfTool = (name) => {
        const t = String(name ?? '');
        for (const pair of toolTable) {
          const prefix = Array.isArray(pair) ? pair[0] : null;
          if (typeof prefix === 'string' && t.startsWith(prefix)) return pair[1];
        }
        return null;
      };
      const providerOf = (svc) => {
        if (!svc) return null;
        if (provided[svc]) return provided[svc];
        const parts = String(svc).split('.');
        while (parts.length > 2) {
          parts.pop();
          const key = parts.join('.');
          if (provided[key]) return provided[key];
        }
        return null;
      };
      const isHostService = (svc) => !String(svc ?? '').startsWith('agint.') && hostKeys.has(svc);

      // 出边（它取谁）
      const out = new Map();
      for (const entry of hits) {
        const [pl, file, line, svc, kind] = entry;
        let rec = out.get(pl);
        if (!rec) { rec = { code: new Map(), comment: [], umbrella: [] }; out.set(pl, rec); }
        if (kind === 'code') {
          if (!rec.code.has(svc)) rec.code.set(svc, []);
          rec.code.get(svc).push({ file, line });
        } else if (kind === 'comment') rec.comment.push({ svc, file, line });
        else rec.umbrella.push({ svc, file, line });
      }
      // 入边（谁取它）—— 按服务归属反查，不按插件目录扫
      const into = new Map();
      for (const entry of hits) {
        const [pl, file, line, svc, kind] = entry;
        if (kind !== 'code') continue;
        const p = providerOf(svc);
        if (!p || p === pl) continue;
        let m = into.get(p);
        if (!m) { m = new Map(); into.set(p, m); }
        if (!m.has(pl)) m.set(pl, []);
        m.get(pl).push({ svc, file, line });
      }

      // 产出：工具 / cron / bus / 7 天
      const tools = Array.isArray(P.tools?.rows) ? P.tools.rows : [];
      const cron = Array.isArray(P.cron?.jobs) ? P.cron.jobs : [];
      const toolDailyMap = (P.tools?.daily && typeof P.tools.daily === 'object') ? P.tools.daily : {};
      const busDailyMap = (P.bus?.daily && typeof P.bus.daily === 'object') ? P.bus.daily : {};
      const busPub = new Map();
      for (const pair of (Array.isArray(P.bus?.sources) ? P.bus.sources : [])) {
        if (Array.isArray(pair)) busPub.set(pair[0], pair[1]);
      }
      const rowsByOwner = new Map();
      for (const row of tools) {
        const o = ownerOfTool(row.t);
        if (!o) continue;
        let list = rowsByOwner.get(o);
        if (!list) { list = []; rowsByOwner.set(o, list); }
        list.push(row);
      }
      const cronByOwner = new Map();
      for (const job of cron) {
        const o = cronTable[job.j];
        if (!o) continue;
        let list = cronByOwner.get(o);
        if (!list) { list = []; cronByOwner.set(o, list); }
        list.push(job);
      }
      // 产出按插件缓存：档案页会来回切插件，重复遍历没必要。
      const actCache = new Map();
      const activityOf = (id) => {
        const hit = actCache.get(id);
        if (hit) return hit;
        const rows = rowsByOwner.get(id) || [];
        const daily = [0, 0, 0, 0, 0, 0, 0];
        let n = 0, f = 0, last = 0;
        for (const row of rows) {
          n += row.n || 0;
          f += row.f || 0;
          if ((row.last || 0) > last) last = row.last || 0;
          const d = toolDailyMap[row.t];
          if (Array.isArray(d)) d.forEach((v, i) => { if (i < 7) daily[i] += v || 0; });
        }
        const bd = busDailyMap[id];
        if (Array.isArray(bd)) bd.forEach((v, i) => { if (i < 7) daily[i] += v || 0; });
        const jobs = (cronByOwner.get(id) || []).slice()
          .sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
        for (const job of jobs) {
          const t = job.last ? new Date(job.last).getTime() : 0;
          if (t > last) last = t;
        }
        const value = { tools: rows, n, f, bus: busPub.get(id) || 0, jobs, daily, last };
        actCache.set(id, value);
        return value;
      };

      /**
       * 声明与代码的对差（只报事实，不评判）：
       *  - `declaredUnused`：manifest 声明消费、代码里没有任何命中（含注释命中也算「提过」）
       *  - `undeclared`：代码真取、manifest 没声明
       * 宿主注入名（inject / optionalInject）不参与 —— 它们结构上不写在 ctx.get 实参位。
       */
      const declaredGap = (id) => {
        const d = byId[id];
        if (!d || !d.contract) return null;
        const rec = out.get(id) || { code: new Map(), comment: [], umbrella: [] };
        const taken = new Set([...rec.code.keys()]);
        const mentioned = new Set([...rec.comment.map((c) => c.svc), ...rec.umbrella.map((u) => u.svc)]);
        const declared = new Set([...(d.contract.consumes || []), ...(d.contract.optionalInject || [])]);
        const declaredUnused = [...declared].filter((k) => !taken.has(k) && !mentioned.has(k));
        const undeclared = [...taken].filter((k) => !declared.has(k));
        return { declaredUnused, undeclared };
      };

      /**
       * 全表统一的曲线尺度：档案页要能横向比较插件（A 的 8000 次/天 vs B 的 3 次/天
       * 若各自归一，画出来一样高）。这段在首次建索引时跑一遍，成本 O(插件数)。
       */
      let maxDaily = 1;
      for (const id of order) {
        for (const v of activityOf(id).daily) if (v > maxDaily) maxDaily = v;
      }
      for (const id of order) activityOf(id).maxDaily = maxDaily;

      return { byId, order, out, into, activityOf, declaredGap, providerOf, isHostService, ownerOfTool, maxDaily, raw: P };
    }

    /** Component-local CSS: tokens only, so both themes follow the host. */
    function PanelStyles() {
      return h('style', null, PANEL_CSS);
    }
    /** 面板样式（浏览器半自带，只用宿主 token；缺 token 时括号里的值兜底）。 */
    const PANEL_CSS = [
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
        /* 名册成员行：整行可点，进档案。按钮语义（键盘可达），外观保持行。 */
        `.agintfp-member{display:flex;align-items:center;gap:8px;width:100%;min-width:0;
          font:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:6px;
          padding:3px 4px;margin:0 -4px;color:inherit}
        .agintfp-member:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
        .agintfp-member:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary,#2f9e5f);outline-offset:1px}
        .agintfp-member .agintfp-go{flex:none;font-size:11px;opacity:.0;transition:opacity .12s}
        .agintfp-member:hover .agintfp-go,.agintfp-member:focus-visible .agintfp-go{opacity:.75}
        /* 档案页：单列 + 上限宽度。宿主中栏保底 400px，窄屏不溢出的关键是最小宽度归零。 */
        .agintfp-dossier{display:grid;gap:14px;max-width:900px;min-width:0}
        .agintfp-sec{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));
          border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-l1,transparent);min-width:0}
        .agintfp-sec>h3{margin:0 0 2px;font-size:12px;font-weight:600;letter-spacing:.02em;
          color:var(--dsw-alias-label-primary,inherit)}
        .agintfp-sec>h3 .agintfp-hint{font-weight:400;margin-left:6px;
          color:var(--dsw-alias-label-tertiary,inherit)}
        .agintfp-sec>p{margin:0 0 10px;font-size:11.5px;line-height:1.7;
          color:var(--dsw-alias-label-tertiary,inherit);max-width:88ch}
        .agintfp-kv{display:grid;grid-template-columns:fit-content(38%) 1fr;gap:3px 12px;
          font-size:12px;align-items:baseline}
        .agintfp-kv dt{color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
        .agintfp-kv dd{margin:0;color:var(--dsw-alias-label-primary,inherit);
          min-width:0;overflow-wrap:anywhere}
        .agintfp-nums{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}
        .agintfp-num{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));
          border-radius:8px;padding:8px 10px;min-width:0}
        .agintfp-num b{display:block;font-size:19px;font-weight:600;line-height:1.2;
          font-variant-numeric:tabular-nums}
        .agintfp-num span{display:block;margin-top:2px;font-size:11px;
          color:var(--dsw-alias-label-tertiary,inherit)}
        .agintfp-tbl{width:100%;border-collapse:collapse;font-size:12px}
        .agintfp-tbl th{text-align:left;font-weight:500;font-size:10.5px;letter-spacing:.03em;
          color:var(--dsw-alias-label-tertiary,inherit);padding:3px 6px 5px;white-space:nowrap;
          border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))}
        .agintfp-tbl td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));
          vertical-align:top;overflow-wrap:anywhere}
        /* 第一列是身份（服务名 / 插件名 / 版本 / 目录）：不许断词。
           窄面板里它会撑宽表格，由 .agintfp-scroll 横向滚动兜住 ——
           断成 "agint.eventBus.pblis / h" 比横向滚一下难读得多。 */
        .agintfp-tbl td:first-child,.agintfp-tbl th:first-child{white-space:nowrap}
        .agintfp-tbl tr:last-child td{border-bottom:0}
        .agintfp-scroll{overflow-x:auto;min-width:0;margin:0 -2px;padding:0 2px}
        .agintfp-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;
          color:var(--dsw-alias-label-tertiary,inherit);letter-spacing:-.01em}
        .agintfp-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;
          padding:1px 7px;border-radius:999px;white-space:nowrap;
          border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));
          color:var(--dsw-alias-label-secondary,inherit)}
        .agintfp-badges{display:flex;gap:6px;flex-wrap:wrap}
        .agintfp-note{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,inherit);
          margin:0}
        .agintfp-debt{margin:0;padding:0;list-style:none;display:grid;gap:5px}
        .agintfp-debt li{display:flex;gap:7px;font-size:12px;line-height:1.65;min-width:0}
        .agintfp-debt .agintfp-lv{flex:none;font-size:10.5px;padding:0 5px;border-radius:4px;
          border:1px solid currentColor;line-height:16px;height:16px;margin-top:2px}
        details.agintfp-fold>summary{cursor:pointer;font-size:12px;
          color:var(--dsw-alias-label-secondary,inherit);padding:2px 0}
        details.agintfp-fold[open]>summary{margin-bottom:8px}`,
      ].join('\n');

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

    /**
     * One plugin row inside a group card.
     *
     * v0.4.0 起整行是按钮：点进该插件的档案页。用 `button` 而不是 div+onClick，
     * 是为了键盘可达（Tab / Enter）与读屏语义 —— 名册是本面板唯一的导航面。
     */
    function MemberRow({ member, onOpen }) {
      const state = member.disabled ? 'disabled' : member.status;
      return h('button', {
        type: 'button',
        className: 'agintfp-member',
        title: `${member.id} · 打开档案`,
        onClick: () => { if (typeof onOpen === 'function') onOpen(member.id); },
      },
        h('span', { className: 'agintfp-dot', style: { background: stateColor(state) } }),
        h('span', { className: 'agintfp-name' }, member.id.replace(/^agint-/, '')),
        h('span', { className: 'agintfp-go', style: { marginLeft: 'auto' } }, '档案 →'),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,inherit)', flex: 'none' } }, stateLabel(state)),
      );
    }

    /** 形态分类 → 人话。分类器给的是结构判断，不是 manifest 自述。 */
    const KIND_LABEL = {
      host: '宿主插件', dual: '双半（host + 浏览器）', checker: '检查器', container: '聚合容器',
      library: '库（被 import）', sdk: '服务型', 'tool-only': '纯工具', unmounted: '未挂载',
    };

    /** ISO / ms → `MM-DD HH:mm`。取不到给破折号，不给 1970。 */
    function fmtTime(value) {
      if (!value) return '—';
      const ms = typeof value === 'number' ? value : new Date(value).getTime();
      if (!Number.isFinite(ms) || ms <= 0) return '—';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 相对时间（分钟级以下说「刚刚」）。 */
    function fmtAgo(value) {
      if (!value) return '—';
      const ms = typeof value === 'number' ? value : new Date(value).getTime();
      if (!Number.isFinite(ms) || ms <= 0) return '—';
      const sec = (Date.now() - ms) / 1000;
      if (sec < 60) return '刚刚';
      if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
      if (sec < 86400) return `${Math.round(sec / 3600)} 小时前`;
      return `${Math.round(sec / 86400)} 天前`;
    }

    /** 首句：档案页的「一句话职责」。完整自述收在折叠里，不删信息。
     *  ⛔ 在句号处截断就不要再加省略号 —— 那是完整一句，加「…」会读成还有下文。 */
    function firstSentence(text, max) {
      const t = String(text || '').trim();
      if (!t) return '';
      const cap = max || 170;
      const stop = t.indexOf('。');
      const atSentenceEnd = stop > 0 && stop + 1 <= cap;
      const end = atSentenceEnd ? stop + 1 : Math.min(t.length, cap);
      return t.slice(0, end) + (!atSentenceEnd && end < t.length ? '…' : '');
    }

    /** 分区外壳。`hint` 是标题右侧的小字口径说明。 */
    function Section({ title, hint, note, children }) {
      return h('section', { className: 'agintfp-sec' },
        h('h3', null, title, hint ? h('span', { className: 'agintfp-hint' }, hint) : null),
        note ? h('p', null, note) : null,
        children,
      );
    }

    /** 定义列表：rows = [[term, value], ...] */
    function KV({ rows }) {
      const flat = [];
      rows.forEach((pair, i) => {
        flat.push(h('dt', { key: `t${i}` }, pair[0]));
        flat.push(h('dd', { key: `d${i}` }, pair[1]));
      });
      return h('dl', { className: 'agintfp-kv' }, flat);
    }

    /** 紧凑表。rows 为节点数组（调用方自己 map，便于逐单元格排版）。 */
    function Table({ head, rows, empty }) {
      return h('div', { className: 'agintfp-scroll' },
        h('table', { className: 'agintfp-tbl' },
          h('thead', null, h('tr', null, head.map((c, i) => h('th', { key: i }, c)))),
          h('tbody', null,
            rows.length
              ? rows
              : h('tr', null, h('td', { colSpan: head.length, className: 'agintfp-mono' }, empty || '（无）')),
          ),
        ),
      );
    }

    /** 一个数字块。 */
    function Num({ value, label, color }) {
      return h('div', { className: 'agintfp-num' },
        h('b', { style: color ? { color } : undefined }, String(value)),
        h('span', null, label),
      );
    }

    const DEBT_LEVEL = {
      err: { label: '缺陷', color: 'var(--dsw-alias-state-error-primary, #d64545)' },
      warn: { label: '偏差', color: 'var(--dsw-alias-state-warn-primary, #c98a1b)' },
      info: { label: '提示', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
    };

    /**
     * 单插件档案页。
     *
     * 编排顺序 = 「它是什么 → 它承诺什么 → 它连谁 → 它干了什么 → 它欠什么 → 它变过什么」。
     * 每一节都必须有「取不到」的分支：档案页宁可显示「未读到 + 原因」，
     * 也不能把缺失画成 0 —— 0 是一个事实陈述，缺失不是。
     */
    function DossierView({ id, index, member, loading, error, onBack, onOpen, onRefresh }) {
      const d = index ? index.byId[id] : null;
      const header = h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
        h('button', { type: 'button', className: 'agintfp-btn', onClick: onBack, title: '返回名册' }, '← 名册'),
        h('div', { style: { minWidth: 0, flex: '1 1 240px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { className: 'agintfp-dot', style: { background: stateColor(memberStatus(member)) } }),
            h('span', { style: { fontSize: 17, fontWeight: 600, overflowWrap: 'anywhere' } }, id),
            d && d.meta.version
              ? h('span', { className: 'agintfp-badge' }, `v${d.meta.version}`)
              : h('span', { className: 'agintfp-badge' }, '版本未读到'),
            h('span', { className: 'agintfp-badge' }, stateLabel(memberStatus(member))),
          ),
          h('div', { style: { marginTop: 4, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary,inherit)' } },
            d ? (d.dir + (d.rel !== d.dir ? ` / ${String(d.rel).slice(d.dir.length + 1)}` : '')) : '档案未采集到',
          ),
        ),
        h('button', { type: 'button', className: 'agintfp-btn', onClick: onRefresh, disabled: loading }, loading ? '刷新中…' : '刷新'),
      );

      if (error) {
        return h('div', { className: 'agintfp-dossier' }, header,
          h(Section, { title: '读不到档案' },
            h('p', { className: 'agintfp-note' }, String(error)),
            h('p', { className: 'agintfp-note' }, '档案数据来自宿主半的 /v2/data。若面板刚升级过，需要重启 dsh 让 host 半加载新代码。'),
          ));
      }
      if (!d) {
        return h('div', { className: 'agintfp-dossier' }, header,
          h(Section, { title: '目录里没有这个插件' },
            h('p', { className: 'agintfp-note' },
              '名册这一行来自宿主 loader（说明它被 patch 要求加载），但插件目录扫描没找到同名目录。'),
            h('p', { className: 'agintfp-note' }, index
              ? `本次归档了 ${index.order.length} 个插件目录。可能是：bundle 外部挂载、目录名与 entry id 不同、或该行是宿主内建。`
              : '档案尚未载入。'),
          ));
      }

      const meta = d.meta;
      const contract = d.contract;
      const outRec = index.out.get(id) || { code: new Map(), comment: [], umbrella: [] };
      const intoMap = index.into.get(id) || new Map();
      const act = index.activityOf(id);
      const gap = index.declaredGap(id);

      // ── 分量 ──
      const inCount = intoMap.size;
      const nums = h('div', { className: 'agintfp-nums' },
        h(Num, { value: d.code.state === 'missing' ? '—' : d.code.lines.toLocaleString(), label: d.code.state === 'missing' ? '无 lib（容器/门面）' : `行代码 · ${d.code.files} 文件` }),
        h(Num, { value: contract ? contract.provides.length : '—', label: contract ? '提供的服务' : '契约不可得' }),
        h(Num, { value: outRec.code.size, label: '取用的服务', color: outRec.code.size === 0 ? 'var(--dsw-alias-label-tertiary, #8a8a8a)' : undefined }),
        h(Num, { value: inCount, label: '依赖它的插件', color: inCount === 0 ? 'var(--dsw-alias-label-tertiary, #8a8a8a)' : undefined }),
      );

      // ── 契约 ──
      const contractNode = !contract
        ? h(Section, { title: '契约 · 它向外承诺什么', hint: '不可得' },
          h('p', { className: 'agintfp-note' },
            d.layer === 'package'
              ? '这个目录只有 package.json，没有 manifest.json —— 它没有登记 inject / provides / consumes。档案不替它编一份契约。'
              : '既无 manifest.json 也无 package.json —— 契约为零，只剩代码与目录。'))
        : h(Section, {
          title: '契约 · 它向外承诺什么',
          hint: d.contractSource === 'self' ? 'manifest.json' : `manifest 来自 ${d.contractSource}`,
        },
          contract.provides.length
            ? h(Table, {
              head: ['服务', '自述（manifest 原文）'],
              rows: contract.provides.map((svc) => h('tr', { key: svc },
                h('td', { className: 'agintfp-mono' }, svc),
                h('td', { style: { fontSize: 11.5 } },
                  contract.serviceDocs[svc] ? String(contract.serviceDocs[svc]) : h('span', { className: 'agintfp-mono' }, '—（manifest 未写自述）')),
              )),
              empty: '不提供任何服务',
            })
            : h('p', { className: 'agintfp-note' }, '不提供任何服务（manifest 的 provides 为空）—— 它是消费方或纯工具。'),
          h('div', { style: { marginTop: 10 } },
            h(KV, {
              rows: [
                ['宿主注入 inject', contract.inject.length ? contract.inject.join('、') : '无'],
                ['软注入 optionalInject', contract.optionalInject.length ? contract.optionalInject.join('、') : '无'],
                ['声明消费 consumes', contract.consumes.length ? contract.consumes.join('、') : '无'],
                ['监听事件', contract.events.length ? contract.events.join('、') : '无'],
                ['工具（manifest）', contract.tools.length ? contract.tools.join('、') : '无'],
                ['存储域', contract.storageDomains.length
                  ? `${contract.storageDomains.join('、')}${contract.storageSchemaVersion !== null ? `（schema v${contract.storageSchemaVersion}）` : ''}`
                  : '无'],
                ['权限 · env', contract.permissions?.env?.length ? contract.permissions.env.join('、') : '无'],
                ['权限 · fs', contract.permissions?.fs?.length ? contract.permissions.fs.join('、') : '无'],
                ['权限 · net', contract.permissions?.network?.length ? contract.permissions.network.join('、') : '无'],
                /**
                 * ⚠️ `shell: []` 是**空数组**，`Boolean([]) === true` —— 直接判真会把每个
                 * 插件都标成「能起子进程」。manifest 里 shell 既可能是布尔也可能是数组
                 * （权限白名单），两种形态都要按「有没有内容」判。
                 */
                ['权限 · shell', (() => {
                  const sh = contract.permissions?.shell;
                  const can = Array.isArray(sh) ? sh.length > 0 : Boolean(sh);
                  return can
                    ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #c98a1b)' } }, `是${Array.isArray(sh) ? `（${sh.join('、')}）` : '（能起子进程）'}`)
                    : '否';
                })()],
                ['生命周期', contract.lifecycle
                  ? `intervals ${contract.lifecycle.intervals ?? '?'} · listeners ${contract.lifecycle.listeners ?? '?'} · 退出 ${contract.lifecycle.shutdown ?? '?'}`
                  : '未声明'],
                ['测试入口', contract.tests?.command
                  ? h('span', { className: 'agintfp-mono' }, String(contract.tests.command))
                  : '未声明'],
              ],
            }),
          ),
        );

      // ── 接线 ──
      // 取用表：注释态与伞态不冒充「提供方」，各自标明标记。
      const outRows = [];
      for (const [svc, evs] of outRec.code) {
        const provider = index.providerOf(svc);
        const host = index.isHostService(svc);
        outRows.push(h('tr', { key: `c-${svc}` },
          h('td', { className: 'agintfp-mono' }, svc),
          h('td', null, provider || (host ? 'dsh 宿主' : h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #c98a1b)' } }, '无提供方'))),
          h('td', { className: 'agintfp-mono' }, evs.map((e) => `${e.file}:${e.line}`).join('、')),
        ));
      }
      for (const c of outRec.comment) {
        outRows.push(h('tr', { key: `m-${c.svc}-${c.line}` },
          h('td', { className: 'agintfp-mono' }, c.svc),
          h('td', { className: 'agintfp-mono' }, '—（仅注释）'),
          h('td', { className: 'agintfp-mono' }, `${c.file}:${c.line}`),
        ));
      }
      for (const u of outRec.umbrella) {
        outRows.push(h('tr', { key: `u-${u.svc}-${u.line}` },
          h('td', { className: 'agintfp-mono' }, u.svc),
          h('td', { className: 'agintfp-mono' }, '—（伞键不可达）'),
          h('td', { className: 'agintfp-mono' }, `${u.file}:${u.line}`),
        ));
      }

      /**
       * 入边收敛：基础设施插件被 20+ 个插件依赖（event-bus 实测 26 个），全展开会把
       * 一页拉成三页。前 8 个常显（那是一眼要看的分量），其余收进折叠 —— 不是截断，
       * 是不让人先被长列表淹没。数量始终写全。
       */
      const inEntries = [...intoMap.entries()];
      const inRowOf = ([consumer, evs]) => h('tr', { key: consumer },
        h('td', null, h('button', {
          type: 'button', className: 'agintfp-member', style: { padding: 0, margin: 0, width: 'auto' },
          onClick: () => onOpen(consumer), title: `打开 ${consumer} 的档案`,
        }, h('span', { style: { fontSize: 12 } }, consumer))),
        h('td', { className: 'agintfp-mono' }, evs.map((e) => e.svc).filter((v, i, a) => a.indexOf(v) === i).join('、')),
        h('td', { className: 'agintfp-mono' }, evs.slice(0, 4).map((e) => `${e.file}:${e.line}`).join('、') + (evs.length > 4 ? ` +${evs.length - 4}` : '')),
      );
      const inRows = inEntries.slice(0, 8).map(inRowOf);
      const inRest = inEntries.slice(8).map(inRowOf);

      const wiringNode = h(Section, {
        title: '接线 · 它与谁相连',
        hint: '边来自源码扫描，不是 manifest 自述',
      },
        h('p', null, '「取用」是它在代码里真调用对方服务的位置；「依赖它的」是别人调用它提供的服务的位置。两者都带 文件:行号。'),
        h(Table, { head: ['服务', '提供方', '证据'], rows: outRows, empty: '代码里没有取任何服务（可能是纯工具或纯库）' }),
        h('div', { style: { marginTop: 12 } },
          h(Table, { head: ['依赖它的插件', '用到的服务', '证据'], rows: inRows, empty: '没有插件在代码里取它提供的服务' }),
          inRest.length
            ? h('details', { className: 'agintfp-fold', style: { marginTop: 6 } },
              h('summary', null, `展开其余 ${inRest.length} 个（共 ${inEntries.length} 个依赖它的插件）`),
              h(Table, { head: ['依赖它的插件', '用到的服务', '证据'], rows: inRest }))
            : null,
        ),
        gap && (gap.declaredUnused.length || gap.undeclared.length)
          ? h('div', { style: { marginTop: 10 } },
            h('p', { className: 'agintfp-note' },
              gap.declaredUnused.length ? `声明了但代码里没取：${gap.declaredUnused.join('、')}。` : '',
              gap.undeclared.length ? `${gap.declaredUnused.length ? ' ' : ''}代码里取了但 manifest 没声明：${gap.undeclared.join('、')}。` : '',
            ))
          : null,
      );

      // ── 产出 ──
      const failRate = act.n ? (act.f / act.n) * 100 : 0;
      const spark = sparkline(act.daily, act.maxDaily);
      const activityNode = h(Section, {
        title: '产出 · 它干了什么',
        hint: '30 天实测',
      },
        h('p', null, '工具调用与 bus 发布来自 $DSH_HOME/storages 的实测行；cron 归属来自显式表。工具→插件归属按命名前缀推断（U4 未证实），不是宿主枚举的真值。'),
        h('div', { className: 'agintfp-nums' },
          h(Num, { value: act.n.toLocaleString(), label: '工具调用 · 30 天' }),
          h(Num, {
            value: act.n ? `${failRate.toFixed(1)}%` : '—',
            label: act.n ? `失败 ${act.f} 次` : '无调用可算失败率',
            color: failRate >= 10 ? 'var(--dsw-alias-state-error-primary, #d64545)' : failRate >= 5 ? 'var(--dsw-alias-state-warn-primary, #c98a1b)' : undefined,
          }),
          h(Num, { value: act.bus, label: 'bus 发布 · 全历史' }),
          h(Num, { value: act.jobs.length, label: 'cron 任务' }),
        ),
        h('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          spark
            ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary, #2f9e5f)' } }, spark)
            : h('span', { className: 'agintfp-mono' }, '近 7 天无产出'),
          h('span', { className: 'agintfp-mono' }, act.daily.join(' / ')),
          h('span', { className: 'agintfp-mono' }, `最近活动 ${fmtAgo(act.last)}`),
        ),
        (act.tools.length || act.jobs.length)
          ? h('div', { style: { marginTop: 10 } },
            h(Table, {
              head: ['工具', '调用', '失败', '最近'],
              rows: act.tools.slice(0, 10).map((t) => h('tr', { key: t.t },
                h('td', { className: 'agintfp-mono' }, t.t),
                h('td', null, String(t.n)),
                h('td', null, String(t.f)),
                h('td', { className: 'agintfp-mono' }, fmtTime(t.last)),
              )),
              empty: '无归属工具',
            }),
            act.jobs.length
              ? h('div', { style: { marginTop: 10 } },
                h(Table, {
                  head: ['cron 任务', '上次跑', '结果'],
                  rows: act.jobs.map((j) => h('tr', { key: j.j },
                    h('td', { className: 'agintfp-mono' }, j.j),
                    h('td', { className: 'agintfp-mono' }, fmtTime(j.last)),
                    h('td', null, String(j.res ?? '—')),
                  )),
                  empty: '无',
                }))
              : null,
          )
          : h('p', { className: 'agintfp-note', style: { marginTop: 8 } },
            '30 天内没有可归因的实测产出。这不等于它没用：它可能只提供服务给别人、只在事件触发时工作、或者归属表还没覆盖它的工具名（U4）。'),
      );

      // ── 债 ──
      const debtItems = [];
      for (const item of d.drift) {
        const lv = DEBT_LEVEL[item.level] || DEBT_LEVEL.info;
        debtItems.push(h('li', { key: `d-${item.code}` },
          h('span', { className: 'agintfp-lv', style: { color: lv.color } }, lv.label),
          h('span', null, item.text),
        ));
      }
      if (outRec.comment.length) {
        debtItems.push(h('li', { key: 'comment-hits' },
          h('span', { className: 'agintfp-lv', style: { color: DEBT_LEVEL.info.color } }, '提示'),
          h('span', null, `${outRec.comment.length} 处服务名只出现在注释里（文档腐化候选）：${outRec.comment.map((c) => `${c.svc}@${c.file}:${c.line}`).join('、')}`),
        ));
      }
      if (outRec.umbrella.length) {
        debtItems.push(h('li', { key: 'umbrella-hits' },
          h('span', { className: 'agintfp-lv', style: { color: DEBT_LEVEL.warn.color } }, '偏差'),
          h('span', null, `${outRec.umbrella.length} 处伞键取用（cordis 服务存储扁平，恒 undefined，不建边）`),
        ));
      }
      const noProvider = [...outRec.code.entries()].filter(([svc]) => !index.providerOf(svc) && !index.isHostService(svc));
      if (noProvider.length) {
        debtItems.push(h('li', { key: 'no-provider' },
          h('span', { className: 'agintfp-lv', style: { color: DEBT_LEVEL.warn.color } }, '偏差'),
          h('span', null, `${noProvider.length} 个取用的服务在本次扫描里没有提供方：${noProvider.map(([svc]) => svc).join('、')}`),
        ));
      }
      const debtNode = h(Section, {
        title: '债 · 它与事实不符的地方',
        hint: `${debtItems.length} 条`,
      },
        h('p', null, '只收能用命令复核的差异：版本号不等、文件缺失、契约与代码分家、声明了没落地。判断「写得好不好」是神谕层的活，这里不做。'),
        debtItems.length
          ? h('ul', { className: 'agintfp-debt' }, debtItems)
          : h('p', { className: 'agintfp-note' }, '未见可核对的结构差异。'),
      );

      // ── 变更史 ──
      const cl = d.doc.changelog;
      const historyNode = h(Section, {
        title: '变更史',
        hint: cl.present ? `${cl.versions} 个版本条目` : '无 CHANGELOG',
      },
        cl.present && cl.recent.length
          ? h(Table, {
            head: ['版本', '日期', '这一版做了什么'],
            rows: cl.recent.map((item) => h('tr', { key: `${item.version}-${item.date}` },
              h('td', { className: 'agintfp-mono', style: { color: 'var(--dsw-alias-label-primary, inherit)' } }, item.version),
              h('td', { className: 'agintfp-mono', style: { whiteSpace: 'nowrap' } }, item.date || '—'),
              h('td', { style: { fontSize: 11.5 } }, item.title || '（条目未写标题）'),
            )),
            empty: '没有可解析的版本条目',
          })
          : h('p', { className: 'agintfp-note' },
            cl.present
              ? 'CHANGELOG.md 存在，但没有 `## <版本号>` 形式的标题，读不出变更史。'
              : '没有 CHANGELOG.md —— 这个插件的变更史不可考，只能从 git 历史里找。'),
      );

      // ── 位置（只在多处时出现） ──
      const locationNode = d.locations.length > 1
        ? h(Section, { title: '物理位置', hint: `${d.locations.length} 处` },
          h('p', null, '同一个插件 id 出现在多个目录。读哪一份取决于挂载行 —— 面板不替你选，只把事实列全。'),
          h(Table, {
            head: ['目录', '代码', 'manifest', 'package', '角色'],
            rows: d.locations.map((loc) => h('tr', { key: loc.rel },
              h('td', { className: 'agintfp-mono' }, loc.rel),
              h('td', null, loc.hasLib ? '有' : h('span', { className: 'agintfp-mono' }, '无')),
              h('td', { className: 'agintfp-mono' }, loc.manifestVersion || '—'),
              h('td', { className: 'agintfp-mono' }, loc.pkgVersion || '—'),
              h('td', null, loc.role === 'primary' ? '主（代码来源）' : '次'),
            )),
            empty: '—',
          }))
        : null;

      // ── 同类邻居 ──
      const idx = index.order.indexOf(id);
      const prev = idx > 0 ? index.order[idx - 1] : null;
      const next = idx >= 0 && idx < index.order.length - 1 ? index.order[idx + 1] : null;
      const navNode = (prev || next)
        ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          prev ? h('button', { type: 'button', className: 'agintfp-btn', onClick: () => onOpen(prev) }, `← ${prev.replace(/^agint-/, '')}`) : null,
          next ? h('button', { type: 'button', className: 'agintfp-btn', onClick: () => onOpen(next) }, `${next.replace(/^agint-/, '')} →`) : null,
        )
        : null;

      return h('div', { className: 'agintfp-dossier' },
        header,
        h('div', { className: 'agintfp-badges' },
          h('span', { className: 'agintfp-badge' }, KIND_LABEL[d.kind] || (d.kind || '形态未分类')),
          meta.agintKind ? h('span', { className: 'agintfp-badge' }, `声明 ${meta.agintKind}`) : null,
          meta.tier !== null ? h('span', { className: 'agintfp-badge' }, `tier ${meta.tier}`) : null,
          meta.stability ? h('span', { className: 'agintfp-badge' }, meta.stability) : null,
          meta.mountOrder !== null ? h('span', { className: 'agintfp-badge' }, `挂载序 ${meta.mountOrder}`) : null,
          d.mounted === null
            ? h('span', { className: 'agintfp-badge' }, '挂载态未读到')
            : h('span', { className: 'agintfp-badge' }, d.mounted ? 'patch 里有这一行' : 'patch 里没有这一行'),
          d.layer !== 'manifest' ? h('span', { className: 'agintfp-badge' }, `身份来源 ${d.layer}`) : null,
        ),
        meta.description
          ? h(Section, { title: '它自己说它是什么', hint: 'manifest / package 原文' },
            h('p', { style: { fontSize: 12.5, lineHeight: 1.75, color: 'var(--dsw-alias-label-primary, inherit)', margin: 0 } },
              firstSentence(meta.description)),
            meta.description.length > 170
              ? h('details', { className: 'agintfp-fold', style: { marginTop: 6 } },
                h('summary', null, `展开完整自述（${meta.description.length} 字）`),
                h('p', { className: 'agintfp-note' }, meta.description))
              : null)
          : null,
        h(Section, { title: '分量', hint: '一眼看它有多大、承多重' }, nums),
        contractNode,
        wiringNode,
        activityNode,
        debtNode,
        historyNode,
        locationNode,
        h(Section, { title: '身份明细', hint: 'manifest 字段原样' },
          h(KV, {
            rows: [
              ['插件 id', id],
              ['目录', h('span', { className: 'agintfp-mono' }, d.rel)],
              ['形态（分类器）', d.kind || '未分类'],
              ['main', contract?.main ? h('span', { className: 'agintfp-mono' }, String(contract.main)) : (d.pkg?.main ? h('span', { className: 'agintfp-mono' }, String(d.pkg.main)) : '未声明')],
              ['owner', meta.owner || '未声明'],
              ['兼容起点', meta.compatSince || '未声明'],
              ['版本来源', meta.versionSource === 'manifest' ? 'manifest.json' : meta.versionSource === 'package' ? 'package.json' : '未读到'],
              ['README', d.doc.readme.present ? `${(d.doc.readme.bytes / 1024).toFixed(1)} KB` : '无'],
              ['CHANGELOG', d.doc.changelog.present ? `${d.doc.changelog.versions} 条` : '无'],
              ['代码大头', d.code.big.length
                ? h('span', { className: 'agintfp-mono' }, d.code.big.map((b) => `${b.file} ${b.lines}`).join(' · '))
                : '—'],
            ],
          }),
        ),
        navNode,
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,inherit)', lineHeight: 1.7 } },
          `档案时点 ${fmtTime(index.raw.generatedAt)}　·　口径：契约与体量读插件目录（静态），接线与产出读运行态聚合（30 天窗口）。两者不是同一时刻的事实。`,
        ),
      );
    }

    /** 名册成员的状态字符串（可能没有这一行 → unknown，不是 ok）。 */
    function memberStatus(member) {
      if (!member) return 'unknown';
      return member.disabled ? 'disabled' : (member.status || 'unknown');
    }

    /** The panel page. */
    function FamilyPanel({ ctx }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      // 0.2.1：v2 内嵌为默认视图；v1 名册（分组/信号）保留可切换。
      const [view, setView] = React.useState('v2');
      /**
       * 档案页（v0.4.0）：`detailId` 非空 = 正在看某个插件的档案。
       * 这是名册的下钻层级，不是第三个并列视图 —— 返回就是清空它。
       */
      const [detailId, setDetailId] = React.useState(null);
      const [board, setBoard] = React.useState(null);
      const [boardErr, setBoardErr] = React.useState(null);
      const [boardLoading, setBoardLoading] = React.useState(false);
      const frameRef = React.useRef(null);
      const [frameH, setFrameH] = React.useState(0);
      // 0.2.7：iframe 元素进 state 当 effect 依赖。iframe 只在 data 载入后才渲染，
      // 首挂载时 ref 还是 null，旧 effect（依赖 [view]）直接 return，监听器永远
      // 没挂上——这就是「只有切 v1 再切回 v2 高度才正常」的根因。回调 ref 把
      // 元素本身交给 effect，iframe 一出现就挂 load/RO/轮询。
      const [frameEl, setFrameEl] = React.useState(null);
      const attachFrame = React.useCallback((node) => {
        frameRef.current = node;
        setFrameEl(node);
      }, []);

      // 0.2.2：v2 iframe 自适应内页高度（同源直读 scrollHeight；跨域或未就绪
      // 退回视口高兜底）。外层 .agintfp-root 统一滚动，与 v1 的整页下拉一致；
      // 内页滚到底不再撞在半高窗口里。load 后 3s 轮询兜异步取数引起的高度变化。
      React.useEffect(() => {
        const f = frameEl;
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
              if (ro) { try { ro.disconnect(); } catch {} }
              ro = new ResizeObserver(sync);
              if (f.contentDocument && f.contentDocument.body) ro.observe(f.contentDocument.body);
            }
          } catch { /* RO 挂不上就只靠轮询 */ }
          if (poll) clearInterval(poll);
          poll = setInterval(sync, 3000);
        };
        f.addEventListener('load', onLoad);
        // 防御：effect 挂上时 iframe 可能已加载完（切回 v2 复用缓存文档），
        // load 不会再触发，这里主动补一次。
        try {
          if (f.contentDocument && f.contentDocument.readyState === 'complete') onLoad();
        } catch { /* 同源读不了：等 load / sync 兜底 */ }
        sync();
        return () => {
          alive = false;
          if (ro) { try { ro.disconnect(); } catch {} }
          if (poll) clearInterval(poll);
          f.removeEventListener('load', onLoad);
        };
      }, [frameEl]);

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

      /**
       * 档案数据懒加载：面板打开时不拉（185KB），点进某个插件才拉，之后按 60s
       * 缓存复用。失败只影响档案页，名册照常可用。
       */
      const loadBoard = React.useCallback(async (force) => {
        setBoardLoading(true);
        try {
          const result = await fetchBoard(undefined, { force: Boolean(force) });
          if (result && result.ok === false) {
            setBoardErr(result.error || '档案数据读取失败');
          } else {
            setBoardErr(null);
            setBoard(result);
          }
        } catch (err) {
          if (!err || err.name !== 'AbortError') setBoardErr(String((err && err.message) || err));
        } finally {
          setBoardLoading(false);
        }
      }, []);

      React.useEffect(() => {
        if (detailId && board === null && boardErr === null && !boardLoading) void loadBoard(false);
      }, [detailId, board, boardErr, boardLoading, loadBoard]);

      /** 档案索引：只在 payload 变化时重建（一次 O(插件数)，之后全走 Map）。 */
      const index = React.useMemo(
        () => (board && !boardErr ? buildDossierIndex(board) : null),
        [board, boardErr],
      );

      /** 名册行按 id 索引：档案页要拿 loader 的实时状态（档案只有目录事实）。 */
      const memberById = React.useMemo(() => {
        const map = new Map();
        if (data && Array.isArray(data.groups)) {
          for (const group of data.groups) {
            for (const member of group.members || []) map.set(member.id, member);
          }
        }
        return map;
      }, [data]);

      const body = (() => {
        /**
         * 档案页排在最前：它读的是插件目录（静态事实），不依赖 loader 快照。
         * 名册快照挂了也应该能看档案 —— 两件事的失败模式本来就不同。
         */
        if (detailId) {
          return h(DossierView, {
            id: detailId,
            index,
            member: memberById.get(detailId) || null,
            loading: boardLoading,
            error: boardErr,
            onBack: () => setDetailId(null),
            onOpen: (nextId) => { if (nextId) setDetailId(nextId); },
            onRefresh: () => void loadBoard(true),
          });
        }
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
            ref: attachFrame,
            title: 'AGINT 家族面板（Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定）',
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
                : group.members.map((member) => h(MemberRow, { key: member.id, member, onOpen: setDetailId })),
            )),
          ),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,inherit)' } },
            '点任意插件行 → 打开它的档案（契约 / 接线 / 实测产出 / 债 / 变更史）。'),
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
          subtitle: detailId
            ? `档案 · ${detailId}`
            : (data && data.generatedAt ? `快照 ${new Date(data.generatedAt).toLocaleString('zh-CN')}` : '家族插件总览'),
        },
          h('button', {
            type: 'button', className: 'agintfp-btn',
            title: view === 'v2' ? '切回家族名册视图（分组 / 行状态 / 通电信号）' : '切回家族面板视图（Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定）',
            onClick: () => {
              // 档案是名册的下钻层级：从这个按钮出去先回到名册，不留在 detail 里。
              setDetailId(null);
              setView(view === 'v2' ? 'v1' : 'v2');
            },
          }, view === 'v2' ? '切换到家族名册' : '切换到家族面板'),
          h('button', {
            type: 'button', className: 'agintfp-btn',
            onClick: () => {
              if (detailId) { void loadBoard(true); return; }
              if (view === 'v2' && frameRef.current) {
                setFrameH(0);
                frameRef.current.src = V2_PATH + '?r=' + Date.now();
              } else void load();
            },
          }, (loading && view === 'v1' && !detailId) || boardLoading ? '刷新中…' : '刷新'),
          h('button', {
            type: 'button', className: 'agintfp-btn',
            title: '在新标签页打开家族面板',
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
      /**
       * 只给测试用：档案页的**纯渲染面**（没有 hooks，输入 props 输出元素树）。
       *
       * 为什么需要这个出口：档案页最容易错的不是交互，而是编排 —— 少一节、
       * 字段读错、把「取不到」画成 0。这些用真宿主验证要重启 dsh，代价太高；
       * 导出后可以在 node 里用 createElement 替身直接断言「这个插件渲染出了
       * 哪几节、关键事实有没有出现」。宿主不会读这个键。
       */
      __test__: { buildDossierIndex, DossierView, firstSentence, sparkline, PANEL_CSS, fetchBoardPath: V2_DATA_PATH },
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
