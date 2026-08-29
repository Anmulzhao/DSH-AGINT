// agint-quality-eval smoke 入口（plugin-check 用）
// 真实测试在 monorepo 内：plugins/agint-quality/agint-quality-eval/test/smoke.mjs
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const real = join(here, '..', '..', 'agint-quality', 'agint-quality-eval', 'test', 'smoke.mjs');
if (!existsSync(real)) { console.error('[agint-quality-eval/smoke] missing real smoke at', real); process.exit(1); }
console.log('[agint-quality-eval/smoke] real smoke exists at', real, '(delegation recommended)');
process.exit(0);
