// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
//
// A tiny supersampling rasterizer for flat vector art.
//
// The pet frames are two shapes in two brand colours on transparency. What
// they need is exact geometry and clean edges — not a general-purpose
// renderer. This does that and nothing else: point-in-polygon, point-in-annulus
// sector, and ordered layer compositing at NxN supersampling.

/** Parse `#RRGGBB` into `[r, g, b]`. Throws on anything else, on purpose. */
export function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) throw new Error(`hexToRgb: not #RRGGBB: ${hex}`)
  const n = Number.parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

const DEG = 180 / Math.PI

/**
 * Even-odd point-in-polygon. The pet's only polygon is the letter A, which is
 * concave, so even-odd is the right rule.
 *
 * @param {number} x @param {number} y
 * @param {readonly (readonly [number, number])[]} pts
 * @returns {boolean}
 */
export function insidePolygon(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Normalize an angle in degrees to [0, 360). */
export function norm360(deg) {
  return ((deg % 360) + 360) % 360
}

/**
 * Point-in-annular sector, the ring's test.
 *
 * `startDeg`/`sweepDeg` describe the sector as a start angle plus a signed
 * sweep, which is how the ring's own geometry is authored (SVG arc flags
 * `large-arc` + `sweep` encode the same thing). Sweep follows screen
 * coordinates, where y grows downward, so a positive sweep turns clockwise —
 * the same direction SVG uses.
 *
 * @param {number} x @param {number} y
 * @param {{cx: number, cy: number, rOuter: number, rInner: number, startDeg: number, sweepDeg: number}} ring
 * @param {number} rotationDeg - added to startDeg, so the whole sector turns.
 * @returns {boolean}
 */
export function inAnnulusSector(x, y, ring, rotationDeg = 0) {
  const dx = x - ring.cx
  const dy = y - ring.cy
  const r = Math.hypot(dx, dy)
  if (r < ring.rInner || r > ring.rOuter) return false
  // A test point exactly at the centre has no angle; it is inside the hole
  // anyway unless rInner is 0, and the radial test above already rejected it.
  if (dx === 0 && dy === 0) return ring.rInner === 0
  const theta = norm360(Math.atan2(dy, dx) * DEG)
  const sweep = ring.sweepDeg
  // The sector is measured RELATIVE to its start angle, not from 0. Getting
  // this wrong is silent and total: testing `theta <= sweep` makes a sector
  // that starts late in the circle swallow everything from 0, so a
  // "front" arc drawn over a "behind" arc covers the whole ring and the two
  // become indistinguishable — the weave disappears and rotation stops
  // changing any pixel.
  //
  // Rotation turns the sector by moving its start angle, which is the only
  // place a rotation can act once the test is expressed relatively.
  const start = norm360(ring.startDeg + rotationDeg)
  const rel = norm360(theta - start)
  if (sweep >= 0) return rel <= sweep
  return rel >= 360 + sweep
}

/**
 * Rasterize layers into straight RGBA.
 *
 * Layers are NOT simply painted back to front. Every layer carries a DEPTH,
 * and each output sample is decided by the hitting layer with the GREATEST
 * depth; ties go to the later layer. That one rule is what lets the loop
 * weave: the letter sits at depth 0 and the loop carries a depth that varies
 * along its own arc, so which of the two wins changes from point to point and
 * from frame to frame. No one animates the crossing. It falls out of depth.
 *
 * A layer with no `depth` behaves exactly as before: every layer then ties at
 * 0 and the later one wins, which is plain back-to-front painting.
 *
 * `color` and `depth` may each be a constant or a function of the sample
 * position, which is how one loop layer gets a continuous brightness ramp
 * instead of N visibly stepped sectors.
 *
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} [options.samples] - supersampling factor per axis.
 * @param {{
 *   test: (x: number, y: number) => boolean,
 *   color: readonly number[] | ((x: number, y: number) => readonly number[]),
 *   alpha?: number,
 *   depth?: number | ((x: number, y: number) => number),
 * }[]} options.layers
 *   `alpha` is 0..1 and defaults to 1. `depth` defaults to 0.
 * @returns {Uint8Array} width*height*4
 */
export function rasterize({ width, height, samples = 4, layers }) {
  const ss = Math.max(1, Math.round(samples))
  const step = 1 / (ss + 1) // keep samples off the pixel edges
  const perSample = ss * ss
  const out = new Uint8Array(width * height * 4)
  const alphas = layers.map((l) => Math.max(0, Math.min(1, l.alpha ?? 1)) * 255)
  // Resolve once per layer whether these are constants, so the per-sample
  // branch below is a typeof check on a boolean rather than on the value.
  const colorFn = layers.map((l) => (typeof l.color === 'function' ? l.color : null))
  const depthFn = layers.map((l) => (typeof l.depth === 'function' ? l.depth : null))
  const depthVal = layers.map((l) => (typeof l.depth === 'number' ? l.depth : 0))

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy += 1) {
        const y = py + step + sy * (1 / ss)
        for (let sx = 0; sx < ss; sx += 1) {
          const x = px + step + sx * (1 / ss)
          // Walk from the LAST layer down, and replace the winner only on a
          // STRICTLY greater depth. Equal depths therefore keep the later
          // layer, which is the old behaviour when nothing sets a depth.
          let win = -1
          let winDepth = 0
          for (let li = layers.length - 1; li >= 0; li -= 1) {
            if (!layers[li].test(x, y)) continue
            const d = depthFn[li] === null ? depthVal[li] : depthFn[li](x, y)
            if (win === -1 || d > winDepth) {
              win = li
              winDepth = d
            }
          }
          if (win === -1) continue
          const lc = colorFn[win] === null ? layers[win].color : colorFn[win](x, y)
          const la = alphas[win] / 255 // layer coverage as a 0..1 fraction
          r += lc[0] * la
          g += lc[1] * la
          b += lc[2] * la
          a += la
        }
      }
      const o = (py * width + px) * 4
      if (a === 0) {
        out[o] = 0
        out[o + 1] = 0
        out[o + 2] = 0
        out[o + 3] = 0
        continue
      }
      // Un-premultiply: colour is the alpha-weighted average, straight again.
      out[o] = Math.round(r / a)
      out[o + 1] = Math.round(g / a)
      out[o + 2] = Math.round(b / a)
      out[o + 3] = Math.round((a / perSample) * 255)
    }
  }
  return out
}

/**
 * A reusable affine map from mark space to canvas space.
 *
 * Built once and reused by every sample, because the pet build calls the
 * point-in-shape tests millions of times and re-deriving the transform per
 * sample is the difference between a second and a minute.
 */
export class MarkTransform {
  /**
   * @param {object} options
   * @param {{minX: number, minY: number, maxX: number, maxY: number}} options.bbox - the mark's bounds in mark space.
   * @param {number} options.canvas - square canvas edge in px.
   * @param {number} options.fill - fraction of the canvas the mark's WIDER side should occupy (0..1).
   * @param {number} [options.offsetX] - extra canvas-space px shift.
   * @param {number} [options.offsetY] - extra canvas-space px shift.
   * @param {number} [options.scaleMul] - multiplier on the fitted scale (for the `done` lift).
   */
  constructor({ bbox, canvas, fill, offsetX = 0, offsetY = 0, scaleMul = 1 }) {
    this.canvas = canvas
    this.scale = (canvas * fill * scaleMul) / Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY)
    this.cx = (bbox.minX + bbox.maxX) / 2
    this.cy = (bbox.minY + bbox.maxY) / 2
    this.half = canvas / 2
    this.offsetX = offsetX
    this.offsetY = offsetY
  }

  /** @param {number} x @param {number} y @returns {{x: number, y: number}} canvas space */
  map(x, y) {
    return {
      x: this.half + (x - this.cx) * this.scale + this.offsetX,
      y: this.half + (y - this.cy) * this.scale + this.offsetY,
    }
  }

  /** @param {number} x @param {number} y @returns {{x: number, y: number}} mark space */
  unmap(x, y) {
    return {
      x: this.cx + (x - this.half - this.offsetX) / this.scale,
      y: this.cy + (y - this.half - this.offsetY) / this.scale,
    }
  }
}
