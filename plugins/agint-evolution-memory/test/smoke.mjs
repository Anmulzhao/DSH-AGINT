// agint-evolution-memory smoke（Sprint 12 A1）— 委托给 log-buffer.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ['--test', join(here, 'log-buffer.test.mjs')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
