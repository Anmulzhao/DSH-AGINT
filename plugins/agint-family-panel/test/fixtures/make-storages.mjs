// test/fixtures/make-storages.mjs — 动态生成假 storages（时间戳相对当前，防 30 天窗口滑出）
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function makeStorages(home, now = Date.now()) {
  const dir = join(home, 'storages');
  mkdirSync(dir, { recursive: true });
  const D = 86400000;
  const tl = (t, tool, ok) => JSON.stringify({ ts: t, tool, ok, latencyMs: 0, sessionId: 's', callId: 'c' });
  writeFileSync(join(dir, 'agint_tool_stats.jsonl'), [
    tl(now - 1 * 3600e3, 'alpha_do', true),
    tl(now - 1 * 3600e3, 'alpha_do', false),
    tl(now - 2 * D, 'beta_act', true),
    tl(now - 2 * D, 'beta_act', true),
    tl(now - 2 * D, 'beta_act', true),
    tl(now - 3 * D, 'pwsh', true),
    tl(now - 3 * D, 'pwsh', false),
    tl(now - 40 * D, 'old_tool', true), // 30 天窗口外，必须被排除
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'agint_cron.json'), JSON.stringify({
    unit: 'u', global: {}, tables: { cron_state: {
      'alpha-daily': { lastRunAt: new Date(now - 5 * 3600e3).toISOString(), lastResult: 'ok', lastError: null, updatedAt: '' },
      'mystery-job': { lastRunAt: new Date(now - 9 * 3600e3).toISOString(), lastResult: '?', lastError: 'x', updatedAt: '' },
    } },
  }));
  const ev = (topic, source, ago) => ({ envelope: { id: `${topic}-${ago}`, topic, source, occurredAt: new Date(now - ago).toISOString(), payload: {} } });
  writeFileSync(join(dir, 'agint_event_bus.json'), JSON.stringify({
    unit: 'u', global: {}, tables: {
      events: {
        e1: ev('alpha.did', 'agint-alpha', 1 * 3600e3),
        e2: ev('alpha.did', 'agint-alpha', 2 * D),
        e3: ev('beta.did', 'agint-beta', 3 * D),
      },
      deadletter: {},
    },
  }));
  return dir;
}
