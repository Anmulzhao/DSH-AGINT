// fixture-B-implemented / test/smoke.mjs — minimal smoke
// 真实测试在 dim10 detector 内部完成（验证 computeComposite 存在）。
import { computeComposite } from '../lib/index.js';
const out = computeComposite({ metric_a: 1, metric_b: 2 });
console.log('[fixture-B-implemented] smoke OK, computeComposite(1,2) =', out);