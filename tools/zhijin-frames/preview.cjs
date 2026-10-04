'use strict';
/**
 * 对照表生成器 —— 把关键帧排成一张网格，供人工复核形状。
 * 用法：node preview.cjs --src=dist/agint --out=sheet.png --cell=256
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CELLS = [
  ['idle', 0, 'idle'],
  ['waiting', 1, 'waiting'],
  ['thinking', 4, 'thinking'],
  ['tool', 4, 'tool'],
  ['review', 4, 'review'],
  ['done', 5, 'done'],
  ['failed', 5, 'failed'],
  ['idle-degraded', 0, 'skin:degraded'],
  ['idle-unknown', 0, 'skin:unknown'],
  ['idle-failed', 0, 'skin:failed'],
];

function parseArgs(argv) {
  const a = { src: path.join(__dirname, 'dist', 'agint'), out: 'sheet.png', cell: 256 };
  for (const arg of argv.slice(2)) {
    const m = /^--(\w+)=(.*)$/.exec(arg);
    if (!m) continue;
    a[m[1]] = m[1] === 'cell' ? Number(m[2]) : m[2];
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv);
  const COLS = 5;
  const ROWS = Math.ceil(CELLS.length / COLS);
  const PAD = 6;
  const LABEL = 16;
  const cell = a.cell;
  const W = COLS * (cell + PAD) + PAD;
  const H = ROWS * (cell + PAD + LABEL) + PAD;

  const composites = [];
  const texts = [];
  CELLS.forEach(([track, frame, label], idx) => {
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    const x = PAD + col * (cell + PAD);
    const y = PAD + row * (cell + PAD + LABEL);
    const file = path.join(a.src, 'frames', track, `frame-${String(frame).padStart(2, '0')}.webp`);
    composites.push({ input: file, left: x, top: y });
    texts.push({ x, y: y + cell + 2, label });
  });

  const labelSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    texts
      .map(
        (t) =>
          `<text x="${t.x}" y="${t.y + 11}" font-family="monospace" font-size="11" fill="#9AA4B8">${t.label}</text>`
      )
      .join('') +
    `</svg>`;

  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 12, g: 16, b: 28, alpha: 1 } } })
    .composite([...composites, { input: Buffer.from(labelSvg), left: 0, top: 0 }])
    .png()
    .toFile(a.out);

  console.log('sheet:', a.out, `${W}x${H}`, 'cells', CELLS.length);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
