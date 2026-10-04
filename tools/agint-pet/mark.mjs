// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
//
// The AGINT mark, as geometry.
//
// Transcribed from the brand source of truth,
// `docs/assets/brand/agint-brand-icon.svg` (12 lines, three paths). Nothing
// here is a redraw or an approximation: these are the same numbers the
// shipped icon raster was built from.
//
// What the mark is, per the SVG's own `<desc>`: "字母 A 与自进化回环交织：
// 回环上端收进 A 顶点之后，下端从右笔画上方穿出" — the letter A with the
// self-evolution loop woven through it. The loop disappears behind the apex
// and comes back out in front of the right stroke.
//
// The shipped SVG is dark-mode-on-light: the A is deep space blue. The pet
// lives on DSH's dark GUI, so this build uses the brand's onDark pairing —
// the same switch the shipped `agint-icon-1024-onDark.png` makes.

/** SVG group transform: <g transform="translate(-4.05,-1.5)">. */
const SVG_TRANSLATE = { x: -4.05, y: -1.5 }

/**
 * Layer 2: the letter A, no crossbar, sharp apex. Post-translate applied.
 * Source: M173,20 L19.9,343 L58.4,343 L173,101.3 L287.6,343 L326.1,343 Z
 */
export const LETTER_A = [
  [173, 20],
  [19.9, 343],
  [58.4, 343],
  [173, 101.3],
  [287.6, 343],
  [326.1, 343],
].map(([x, y]) => [x + SVG_TRANSLATE.x, y + SVG_TRANSLATE.y])

/**
 * The loop, as a circle with a hole.
 *
 * Both SVG arcs share one centre, solved from the endpoints: the outer arc
 * A106.5,106.5 between (169.1,82.5) and (135.6,169.6), and the inner return
 * A78.5,78.5 between (163.5,167.2) and (188.2,103). Both solve to the same
 * point, so the ring is concentric and is authored here as radii rather than
 * as two separate arcs.
 *
 * The solve runs on the RAW path coordinates and the result is then shifted by
 * the same group transform as the letter. Skipping that shift was a real bug
 * during the first build: it put the ring 4.05px right of where it belongs
 * and made the whole mark 1.3% too wide, which `build.mjs --verify` caught by
 * comparing the box against the shipped icon's 933x919.
 */
export const LOOP_CENTER = (() => {
  // Solve the centre of an arc through two points at a fixed radius.
  //   mid ± h * perp,  h = sqrt(r^2 - (d/2)^2)
  const p1 = { x: 169.1, y: 82.5 }
  const p2 = { x: 135.6, y: 169.6 }
  const r = 106.5
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const d = Math.hypot(dx, dy)
  const h = Math.sqrt(r * r - (d / 2) ** 2)
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  // Two solutions exist. The one the SVG takes is the one where the arc
  // bulges AWAY from the chord's origin side, which is mid + h*(dy,-dx)/d.
  // Picking the other one mirrors the ring across the chord and moves its
  // right edge 90 units out, which --verify catches.
  const cx = mid.x + (h * dy) / d
  const cy = mid.y - (h * dx) / d
  // The inner return arc must land on the same centre. It carries sweep=0, the
  // opposite of the outer arc, so it takes the mirrored sign. If the two
  // solutions drift, the transcription is wrong and the ring is not the ring
  // the brand drew.
  const inner = { x: 163.5, y: 167.2 }
  const toInner = { x: 188.2, y: 103 }
  const dr = Math.hypot(toInner.x - inner.x, toInner.y - inner.y)
  const ih = Math.sqrt(78.5 ** 2 - (dr / 2) ** 2)
  const imid = { x: (inner.x + toInner.x) / 2, y: (inner.y + toInner.y) / 2 }
  const icx = imid.x - (ih * (toInner.y - inner.y)) / dr
  const icy = imid.y + (ih * (toInner.x - inner.x)) / dr
  // The SVG prints its coordinates to one decimal, so the two arcs cannot
  // agree to better than a few hundredths of a unit. Measured drift on the
  // real file is 0.022 units against a 106.5 radius — 0.02%. A tolerance of
  // 0.05 catches a genuinely different centre without failing on rounding.
  if (Math.hypot(icx - cx, icy - cy) > 0.05) {
    throw new Error(`mark.mjs: the two arcs disagree on the centre (${cx},${cy}) vs (${icx},${icy})`)
  }
  return { cx: cx + SVG_TRANSLATE.x, cy: cy + SVG_TRANSLATE.y }
})()
export const LOOP_R_OUTER = 106.5
export const LOOP_R_INNER = 78.5

/**
 * The loop spans 308°, not 360° — the remaining 52° is the gap at the top
 * right, which is what makes it read as a loop threading something rather
 * than as a plain ring.
 *
 * Angular reference: the arc start point (169.1, 82.5) post-translate is
 * (165.05, 81.0), i.e. 227.1° from the centre. Everything below is measured
 * from there, so sector 0° == the SVG's 227.1°.
 */
export const LOOP_START_DEG = 227.1
/** Whole loop: 308°, matching the SVG's `large-arc=1` flag on the outer arc. */
export const LOOP_SWEEP_DEG = 308

/**
 * The weave, expressed as a split of the 308°.
 *
 * The SVG draws the loop twice. Layer 1 paints all 308° BEHIND the A. Layer 3
 * repaints the last 120.2° IN FRONT of it, and that repaint is what creates
 * the weaving. Solved from the layer-3 arc endpoints: its start (135.6, 169.6)
 * is at 175.1° world, which is 308° into the loop, and its end (302.8, 247.6)
 * is at 54.9°, which is 187.8° in.
 */
export const LOOP_BEHIND = { startDeg: 227.1, sweepDeg: 187.8 }
export const LOOP_IN_FRONT = { startDeg: 54.9, sweepDeg: 120.2 }

/** Bounds of the whole mark, post-translate. Drives the fit and the cell size. */
export const MARK_BBOX = (() => {
  const xs = LETTER_A.map(([x]) => x)
  const ys = LETTER_A.map(([, y]) => y)
  const minX = Math.min(...xs, LOOP_CENTER.cx - LOOP_R_OUTER)
  const maxX = Math.max(...xs, LOOP_CENTER.cx + LOOP_R_OUTER)
  const minY = Math.min(...ys, LOOP_CENTER.cy - LOOP_R_OUTER)
  const maxY = Math.max(...ys, LOOP_CENTER.cy + LOOP_R_OUTER)
  return { minX, minY, maxX, maxY }
})()

/**
 * Brand colours.
 *
 * `A` is the onDark primary (near-white) because the pet renders on DSH's
 * dark shell. `LOOP` is the signal cyan, which the brand keeps identical in
 * both variants — it is the one colour that never flips.
 *
 * `STATE_LOOP` and `STATE_A` carry the failed tone. Both were measured
 * against the dark ground in the character spec: the cyan sits at 9.45:1
 * against #0A1B34, the fault red at 5.69:1. Neither is a guess.
 */
export const COLORS = {
  /** On-dark primary. Deep space blue flipped to near-white. */
  A: '#F5F8FC',
  /** Signal cyan. Identical in both brand variants. */
  LOOP: '#24D3E5',
  /** Fault tone for the loop. */
  STATE_LOOP: '#FF5C5C',
  /** Fault tone for the letter, dimmed so the loop stays the loudest thing. */
  STATE_A: '#8A94A6',
}
