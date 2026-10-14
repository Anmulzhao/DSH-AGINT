// agint-voice-hotkey smoke test: syntax + wiring assertions (no browser here).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [
  ['lib/index.js', ['agint.voiceHotkey', '19400']],
  ['lib/client.js', ['__ModuleLoader__', 'conversation.input.left', 'inputActions.submit()', '127.0.0.1:19400/events', 'encodeWave', 'speech.transcribe']],
];

let failed = 0;
for (const [file, needles] of checks) {
  const abs = resolve(root, file);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  } catch (err) {
    console.error(`FAIL syntax ${file}:`, String(err.stderr || err.message).slice(0, 300));
    failed += 1;
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) {
      console.error(`FAIL wiring ${file}: missing "${needle}"`);
      failed += 1;
    }
  }
}
// Regression guard: cordis throws when a plugin reads ctx.config without
// declaring it in inject (family-panel v0.1.0 incident; this plugin's own
// 2026-10-14 boot failure). The host half must apply with such a ctx.
const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href);
const hostileCtx = {
  provide: () => void 0,
};
Object.defineProperty(hostileCtx, 'config', {
  get() {
    throw new Error('cannot get property config without inject');
  },
});
try {
  host.apply(hostileCtx);
  console.log('smoke: ok host apply survives config-less ctx');
} catch (err) {
  console.error('FAIL host apply:', err.message);
  failed += 1;
}

if (failed) {
  console.error(`smoke: ${failed} FAIL`);
  process.exit(1);
}
console.log('smoke: ok (2 files, syntax + wiring)');
