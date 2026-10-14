/**
 * agint-voice-hotkey: HOST half.
 *
 * Deliberately inert: the OS-level listener is the standalone SSE daemon
 * (`bin/voice-hotkey.mjs`) and the dictation flow lives entirely in the
 * browser half (lib/client.js). This half only publishes a status service so
 * other AGINT surfaces (family panel, cron probes) can tell the plugin is
 * mounted and read the daemon contract (URL + combo) without scraping files.
 *
 * Row (bundle cordis.patch.yml):
 *   - insert:
 *       - id: agint-voice-hotkey
 *         name: ./plugins/agint-voice-hotkey/lib/index.js
 */

const name = 'agint-voice-hotkey';
const inject = [];

const VERSION = '0.1.0';
const DAEMON_URL = 'http://127.0.0.1:19400';

/**
 * Mount the plugin's host half.
 *
 * ⛔ cordis 契约：config 走 apply 第二参数，不读 ctx.config（那要 inject
 * 声明 config，宿主不给，fiber 直接 fail——agint-family-panel v0.1.0 踩过，
 * 本插件 0.1.0 复犯于 2026-10-14，载入即「cannot get property config
 * without inject」，名册行 failed）。
 * @param {object} ctx - host context.
 * @param {object} [config] - cordis.patch.yml 的 config 段。
 */
function apply(ctx, config = {}) {
  ctx.provide('agint.voiceHotkey', {
    version: VERSION,
    daemon: {
      url: `${DAEMON_URL}/events`,
      status: `${DAEMON_URL}/status`,
      combo: 'ctrl+alt+space',
    },
    enabled: config.enabled !== false,
  });
}

export { name, inject, apply };
