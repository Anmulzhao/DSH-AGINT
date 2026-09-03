// Mirror of the perl regex in bin/plugin-check.sh dimension 9 (runtime-contract).
// Lets users without perl still run the same lint check from node:
//   node bin/_verify-dim9.js <lib/index.js>...
//
// We re-implement the same logic in JS so it works on any host with node but no perl.
const fs = require('fs');
const path = require('path');

const WATERFALL = '(tools/(?:pre-execute|post-execute|ptc-dispatch-log)|agent/pre-step)';
// Capture: 1=event 2=async 3=args list 4=single-arg name 5=body
const RE = new RegExp(
  `ctx\\.on\\(\\s*['"\`](${WATERFALL})['"\`]\\s*,\\s*(async\\s+)?(?:\\(([^)]*)\\)|(\\w+))\\s*=>\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`,
  'gs'
);

let totalHits = 0;
let totalFiles = 0;
for (const arg of process.argv.slice(2)) {
  totalFiles++;
  const src = fs.readFileSync(arg, 'utf8');
  let hits = 0, m;
  while ((m = RE.exec(src)) !== null) {
    const [, evt, , args1, argName, body] = m;
    const args = args1 !== undefined ? args1 : argName;
    const hasNext = /\bnext\s*\(/.test(body);
    const trimmed = body.trim();
    const empty = trimmed === '';
    const startLine = src.slice(0, m.index).split('\n').length;
    if (empty) {
      console.log(`[${arg}:${startLine}] EMPTY listener on ${evt} (args: ${args})`);
      hits++;
    } else if (!hasNext) {
      console.log(`[${arg}:${startLine}] NO_NEXT on ${evt} (args: ${args})`);
      console.log(`  body: ${body.trim().slice(0, 120)}${body.length > 120 ? '...' : ''}`);
      hits++;
    }
  }
  if (hits === 0) console.log(`OK: ${arg}`);
  totalHits += hits;
}
console.log(`\n${totalFiles} files scanned, ${totalHits} runtime-contract violation(s)`);
process.exit(totalHits === 0 ? 0 : 1);

