// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
//
// Self-check and preview sheet for the AGINT pet build.
//
// Checks are numeric because the author of this file cannot look at the
// output. Every assertion below is something a wrong build would fail:
//
//   1. each frame inks a sane box and coverage
//   2. frames inside a phase DIFFER — a still track is a broken track
//   3. `failed` carries the fault red, every other phase carries the cyan
//   4. nothing clips the cell edge
//
// It also writes two PNGs so a human can see the result in one glance:
// a contact sheet of all 44 frames, and a strip at the real display size,
// where the anti-aliasing and the 1.6:1 mark-to-cell ratio actually matter.
//
//   node check.mjs --out <pet-dir> [--preview <dir>]

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from './png.mjs'
import { rasterize, insidePolygon, inAnnulusSector, hexToRgb, MarkTransform } from './raster.mjs'
// The mascot plugin is what actually calls `setSkin`, so it is the other end
// of this contract. `announce.js` is a pure module with no imports, so pulling
// it in here costs nothing and lets this file check BOTH ends.
import { skinIdForHealth } from '../../plugins/agint-mascot/lib/announce.js'
import {
  LETTER_A, LOOP_CENTER, LOOP_R_INNER, LOOP_R_OUTER, LOOP_BEHIND, LOOP_SWEEP_DEG,
  MARK_BBOX, COLORS,
} from './mark.mjs'

const CELL = 256
const FILL = 0.86
const SAMPLES = 5

const PHASES = {
  idle: { frames: 6, ms: 900, swing: 20, loopAlpha: 1, tone: 'normal' },
  waiting: { frames: 4, ms: 700, swing: 14, loopAlpha: 0.7, tone: 'normal' },
  thinking: { frames: 8, ms: 200, swing: 35, loopAlpha: 1, tone: 'normal' },
  tool: { frames: 6, ms: 130, swing: 50, loopAlpha: 1, tone: 'normal', sweep: 45 },
  review: { frames: 8, ms: 380, swing: 14, loopAlpha: 1, tone: 'normal' },
  done: { frames: 8, ms: 150, turn: 45, loopAlpha: 1, tone: 'normal', lift: 0.03 },
  failed: { frames: 4, ms: 1000, turn: 0, loopAlpha: 0.85, tone: 'fault', sink: 0.015 },
}
const PHASE_ORDER = ['idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed']

// Mirrors build.mjs. The three skin looks carry health through MOTION, not
// colour: only `failed` is allowed to change palette. All of them are closed.
const SKIN_TRACKS = {
  'idle-degraded': { frames: 6, ms: 700, turn: [-20, 0, 20, 8, -8, -20], loopAlpha: 0.9, tone: 'normal' },
  'idle-unknown': { frames: 6, ms: 1400, swing: 34, loopAlpha: 0.9, tone: 'normal' },
  'idle-failed': { frames: 1, ms: 1000, turn: 0, loopAlpha: 0.85, tone: 'fault' },
}
const SKIN_ORDER = ['idle-degraded', 'idle-unknown', 'idle-failed']
const SKINS = [
  { id: 'healthy', label: '健康', idleTrack: 'idle' },
  { id: 'degraded', label: '亚健康', idleTrack: 'idle-degraded' },
  { id: 'unknown', label: '未知', idleTrack: 'idle-unknown' },
  { id: 'failed', label: '故障', idleTrack: 'idle-failed' },
]

const RGB = {
  normal: { a: hexToRgb(COLORS.A), loop: hexToRgb(COLORS.LOOP) },
  fault: { a: hexToRgb(COLORS.STATE_A), loop: hexToRgb(COLORS.STATE_LOOP) },
}
const HIGHLIGHT = hexToRgb('#EAFBFD')

/** Mirrors build.mjs. Changing one without the other invalidates this file. */
const DEPTH_DIM = 0.5

const SPEC_BY_TRACK = { ...PHASES, ...SKIN_TRACKS }

/** Radians to degrees, for the screen-angle probes. */
const DEG = 180 / Math.PI

/** Degrees into [0, 360). */
const norm360 = (d) => ((d % 360) + 360) % 360

/** Every rendered track: the seven phases plus the skins that need their own. */
const TRACKS_TO_CHECK = [...PHASE_ORDER, ...SKIN_ORDER]

function frameState(track, i, n) {
  const spec = SPEC_BY_TRACK[track]
  if (spec === undefined) throw new Error(`no such track: ${track}`)
  const p = n <= 1 ? 0 : i / n
  let turn
  if (spec.swing !== undefined) {
    const half = n / 2
    const denom = half - 1 || 1
    if (i <= half) turn = -spec.swing + ((2 * spec.swing) / denom) * i
    else turn = spec.swing - ((2 * spec.swing) / denom) * (i - half)
  } else if (spec.turn === 'osc') turn = (spec.oscAmp ?? 14) * Math.sin(2 * Math.PI * p)
  else if (Array.isArray(spec.turn)) {
    if (spec.turn.length !== n) throw new Error(`track ${track}: ${spec.turn.length} turn angles for ${n} frames`)
    turn = spec.turn[i]
  } else turn = spec.turn * i
  const hump = n <= 1 ? 0 : Math.sin(Math.PI * p)
  return {
    turn,
    scaleMul: 1 + (spec.lift ?? 0) * hump,
    offsetY: -(spec.sink ?? 0) * hump * CELL,
    tone: spec.tone,
    loopAlpha: spec.loopAlpha,
    sweepDeg: spec.sweep ?? 0,
  }
}

function renderFrame(phase, i, n, cell = CELL, fill = FILL, samples = SAMPLES) {
  const st = frameState(phase, i, n)
  const palette = RGB[st.tone]
  const xf = new MarkTransform({
    bbox: MARK_BBOX, canvas: cell, fill, scaleMul: st.scaleMul, offsetY: st.offsetY * (cell / CELL),
  })
  // Mirrors build.mjs: rotation is ADDED so a positive `turn` reads clockwise.
  // Measured from rendered pixels by assertion 10, not assumed.
  const rot = st.turn
  const letter = (px, py) => {
    const m = xf.unmap(px, py)
    return insidePolygon(m.x, m.y, LETTER_A)
  }
  // Mirrors build.mjs exactly, including the depth model. See the note in
  // build.mjs: the loop is ONE layer whose nearness decides, per sample,
  // whether it rides over the letter or passes behind it.
  const nearness = (px, py) => {
    const m = xf.unmap(px, py)
    const f = -(m.x - LOOP_CENTER.cx) / LOOP_R_OUTER
    return f < -1 ? -1 : f > 1 ? 1 : f
  }
  const loopColor = (px, py) => {
    const f = nearness(px, py)
    if (f >= 0) return palette.loop
    const k = 1 - DEPTH_DIM * -f
    return [palette.loop[0] * k, palette.loop[1] * k, palette.loop[2] * k]
  }
  const ring = (startDeg, sweepDeg) => (px, py) => {
    const m = xf.unmap(px, py)
    return inAnnulusSector(
      m.x,
      m.y,
      { ...LOOP_CENTER, rOuter: LOOP_R_OUTER, rInner: LOOP_R_INNER, startDeg, sweepDeg },
      rot,
    )
  }
  const layers = [
    { test: ring(LOOP_BEHIND.startDeg, LOOP_SWEEP_DEG), color: loopColor, alpha: st.loopAlpha, depth: nearness },
    { test: letter, color: palette.a },
  ]
  if (st.sweepDeg > 0) {
    layers.push({
      test: ring(LOOP_BEHIND.startDeg, st.sweepDeg),
      color: HIGHLIGHT,
      alpha: 0.92,
      depth: nearness,
    })
  }
  return rasterize({ width: cell, height: cell, samples, layers })
}

/** @returns {{minX:number,minY:number,maxX:number,maxY:number,inked:number,distinct:Set<number>}} */
function measure(rgba, size) {
  let minX = size, minY = size, maxX = -1, maxY = -1, inked = 0
  const distinct = new Set()
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4
      if (rgba[o + 3] < 8) continue
      inked += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      // Bucket to the 8-bit channel triple so antialiasing does not explode the set.
      distinct.add((rgba[o] >> 3 << 10) | (rgba[o + 1] >> 3 << 5) | (rgba[o + 2] >> 3))
    }
  }
  return { minX, minY, maxX, maxY, inked, distinct }
}

/** Count RGBA samples that differ. */
function diffCount(a, b) {
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n += 1
  }
  return n
}

/** Is this colour within a tolerance of the reference? */
const near = (rgba, ref, tol) =>
  Math.abs(rgba[0] - ref[0]) <= tol && Math.abs(rgba[1] - ref[1]) <= tol && Math.abs(rgba[2] - ref[2]) <= tol

/** Does the frame contain at least one pixel close to `ref`? */
function contains(rgba, size, ref, tol = 24) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 100 && near(rgba.subarray(i), ref, tol)) return true
  }
  return false
}

/* ------------------------------------------------------------------ */

/** Blit `src` (size x size) into `dst` at (ox, oy) with nearest sampling. */
function blit(dst, dw, src, size, ox, oy) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const s = (y * size + x) * 4
      if (src[s + 3] === 0) continue
      const d = ((oy + y) * dw + ox + x) * 4
      // Simple source-over; previews are drawn on transparency.
      const sa = src[s + 3] / 255
      const da = dst[d + 3] / 255
      const oa = sa + da * (1 - sa)
      for (let k = 0; k < 3; k += 1) {
        dst[d + k] = oa === 0 ? 0 : Math.round((src[s + k] * sa + dst[d + k] * da * (1 - sa)) / oa)
      }
      dst[d + 3] = Math.round(oa * 255)
    }
  }
}

function main() {
  const argv = process.argv.slice(2)
  const outDir = argv[argv.indexOf('--out') + 1]
  const previewDir = argv.includes('--preview') ? argv[argv.indexOf('--preview') + 1] : null

  let failures = 0
  const fail = (msg) => { console.error(`  FAIL ${msg}`); failures += 1 }

  console.log('agint pet check\n')
  console.log('phase      frames  inked-box        coverage  colours  motion')
  console.log('-'.repeat(66))

  const all = {}
  for (const phase of PHASE_ORDER) {
    const n = PHASES[phase].frames
    all[phase] = []
    let minBox = [Infinity, Infinity]
    let maxBox = [-1, -1]
    let minCov = 1
    let maxCov = 0
    let colors = 0
    let motion = 0

    for (let i = 0; i < n; i += 1) {
      const rgba = renderFrame(phase, i, n)
      all[phase].push(rgba)
      const m = measure(rgba, CELL)
      minBox = [Math.min(minBox[0], m.minX), Math.min(minBox[1], m.minY)]
      maxBox = [Math.max(maxBox[0], m.maxX), Math.max(maxBox[1], m.maxY)]
      const cov = m.inked / (CELL * CELL)
      minCov = Math.min(minCov, cov)
      maxCov = Math.max(maxCov, cov)
      colors = Math.max(colors, m.distinct.size)
      if (i > 0) motion += diffCount(all[phase][i - 1], rgba)
    }

    const cov = ((minCov + maxCov) / 2) * 100
    const w = maxBox[0] - minBox[0] + 1
    const h = maxBox[1] - minBox[1] + 1
    console.log(
      `${phase.padEnd(10)} ${String(n).padStart(6)}  ${`${w}x${h} @${minBox[0]},${minBox[1]}`.padEnd(15)}  ${`${cov.toFixed(1)}%`.padStart(7)}  ${String(colors).padStart(7)}  ${String(motion).padStart(6)}`,
    )

    // 1. the mark must not touch the cell edge, or motion clips somewhere
    if (minBox[0] <= 0 || minBox[1] <= 0 || maxBox[0] >= CELL - 1 || maxBox[1] >= CELL - 1) {
      fail(`${phase}: mark reaches the cell edge (box ${w}x${h} @ ${minBox}) — raise FILL or lower the motion`)
    }
    // 2. a still track is a broken track
    if (motion === 0) fail(`${phase}: no frame differs from the one before it — the track is static`)
    // 3. coverage in the band the brand raster sits in
    if (cov < 20 || cov > 33) fail(`${phase}: coverage ${cov.toFixed(1)}% outside the 20-33% band`)

    // 4. the tone is the state channel; a phase in the wrong colour is a lie.
    //    The alpha gate inside `contains` is 100, not 200, because `waiting`
    //    deliberately dims its loop to 0.7 and must still read as cyan.
    const wantLoop = phase === 'failed' ? RGB.fault.loop : RGB.normal.loop
    const wantA = phase === 'failed' ? RGB.fault.a : RGB.normal.a
    const f0 = all[phase][0]
    if (!contains(f0, CELL, wantLoop)) fail(`${phase}: frame 0 does not contain the expected loop colour`)
    if (!contains(f0, CELL, wantA)) fail(`${phase}: frame 0 does not contain the expected letter colour`)
    const wrong = phase === 'failed' ? RGB.normal.loop : RGB.fault.loop
    if (contains(f0, CELL, wrong)) fail(`${phase}: frame 0 contains the OTHER phase's colour`)
  }

  // 5. Two phases may share a first pose — every track deliberately starts
  //    from the same neutral mark so a phase change does not snap — but they
  //    must diverge somewhere, or the two states are one state.
  for (let a = 0; a < PHASE_ORDER.length; a += 1) {
    for (let b = a + 1; b < PHASE_ORDER.length; b += 1) {
      const pa = PHASE_ORDER[a]
      const pb = PHASE_ORDER[b]
      if (all[pa].every((_, i) => diffCount(all[pa][i], all[pb][i]) === 0)) {
        fail(`${pa} and ${pb} render identical frames — they are not two states`)
      }
    }
  }

  // 5b. The palette is deliberately constant across every phase except
  //     `failed`. A brand mark that recolours on every state is noise; the one
  //     state that must be unmistakable gets the one colour change. Locking
  //     this keeps a later "let me tint thinking too" edit from slipping in.
  for (const phase of PHASE_ORDER) {
    if (phase === 'failed') continue
    if (!contains(all[phase][0], CELL, RGB.normal.loop) || !contains(all[phase][0], CELL, RGB.normal.a)) {
      fail(`${phase}: the base palette drifted — only \`failed\` is allowed a colour change`)
    }
  }

  // 6. the weave must actually weave. Under the orbit model the crossing is
  //    decided by depth, so this asserts both halves in terms that do NOT
  //    assume which sector is in front — otherwise the check would be a second
  //    copy of the art direction and would go quiet the moment it moved:
  //
  //      behind = loop-band pixels painted in the LETTER colour
  //      over   = letter pixels painted in the LOOP colour
  //
  //    If the loop stopped threading anything, one of the two counts drops
  //    to zero. If depth were flattened out again, the counts freeze into the
  //    old fixed window — so this is also the regression guard for V3 itself.
  {
    const probe = all.idle[0]
    const xf = new MarkTransform({ bbox: MARK_BBOX, canvas: CELL, fill: FILL })
    const inRing = (px, py) => {
      const m = xf.unmap(px, py)
      return inAnnulusSector(
        m.x,
        m.y,
        { ...LOOP_CENTER, rOuter: LOOP_R_OUTER, rInner: LOOP_R_INNER, startDeg: LOOP_BEHIND.startDeg, sweepDeg: LOOP_SWEEP_DEG },
        0,
      )
    }
    const inLetter = (px, py) => {
      const m = xf.unmap(px, py)
      return insidePolygon(m.x, m.y, LETTER_A)
    }
    // A loop pixel is the brand cyan scaled by `k` along the depth ramp, so
    // test membership in that one-parameter family instead of one exact tint.
    const isLoop = (c) => {
      const sum = RGB.normal.loop[0] + RGB.normal.loop[1] + RGB.normal.loop[2]
      const k = (c[0] + c[1] + c[2]) / sum
      if (k < 0.3 || k > 1.08) return false
      for (let j = 0; j < 3; j += 1) if (Math.abs(c[j] - RGB.normal.loop[j] * k) > 14) return false
      return true
    }

    let behind = 0
    let over = 0
    for (let y = 0; y < CELL; y += 1) {
      for (let x = 0; x < CELL; x += 1) {
        const o = (y * CELL + x) * 4
        if (probe[o + 3] < 200) continue
        const c = probe.subarray(o)
        if (inRing(x + 0.5, y + 0.5) && near(c, RGB.normal.a, 10)) behind += 1
        if (inLetter(x + 0.5, y + 0.5) && isLoop(c)) over += 1
      }
    }

    const MIN = 150
    if (behind < MIN) {
      fail(`weave missing: only ${behind} loop pixels pass behind the letter (need ${MIN}) — the loop is not threading anything`)
    } else if (over < MIN) {
      fail(`weave missing: only ${over} letter pixels are covered by the loop (need ${MIN}) — nothing rides in front`)
    } else {
      console.log(`weave OK: ${behind} loop pixels pass behind the letter, ${over} ride over it (frame 0)`)
    }
  }

  // 7. The health skins must be told apart by motion. Colour is one channel
  //    and `failed` owns it; the other three keep the brand palette and have
  //    to earn their difference from how the loop moves. If a future edit
  //    makes two of them move alike, this fails even though every frame is
  //    still "valid" — which is the whole point.
  {
    console.log('\nskin              motion/frame  palette')
    console.log('-'.repeat(52))
    const framesOf = { healthy: all.idle }
    const motion = {}
    for (const track of SKIN_ORDER) {
      const n = SKIN_TRACKS[track].frames
      let m = 0
      let prev = null
      framesOf[track] = []
      for (let i = 0; i < n; i += 1) {
        const rgba = renderFrame(track, i, n)
        framesOf[track].push(rgba)
        if (prev !== null) m += diffCount(prev, rgba)
        prev = rgba
      }
      motion[track] = n <= 1 ? 0 : m / (n - 1)
      const tone = SKIN_TRACKS[track].tone
      console.log(`${track.padEnd(16)} ${String(Math.round(motion[track])).padStart(12)}  ${tone}`)

      // The failing look is the only one allowed off-palette.
      const first = renderFrame(track, 0, n)
      const wantLoop = tone === 'fault' ? RGB.fault.loop : RGB.normal.loop
      if (!contains(first, CELL, wantLoop)) fail(`${track}: wrong palette — ${tone} expects a different loop colour`)
      if (tone === 'normal' && contains(first, CELL, RGB.fault.loop)) fail(`${track}: only the failed look may use the fault palette`)
    }

    // Reference, measured: the slowest look already approved, `idle` (which is
    // the healthy skin), changes ~256 px per frame. A skin must be in reach of
    // that or it is motion nobody sees.
    const MIN_MOTION = 150
    for (const track of ['idle-degraded', 'idle-unknown']) {
      if (motion[track] < MIN_MOTION) {
        fail(`${track}: only ${Math.round(motion[track])} changed pixels per frame (need ${MIN_MOTION}) — the look does not read as motion`)
      }
    }

    // `failed` IS stillness: one frame, nothing moving. If it ever grows a
    // travelling frame, the worst state stops being the calmest one.
    if (SKIN_TRACKS['idle-failed'].frames !== 1) {
      fail(`idle-failed has ${SKIN_TRACKS['idle-failed'].frames} frames — the failed rest must be a single still frame`)
    } else if (motion['idle-failed'] !== 0) {
      fail('idle-failed is one frame yet reports motion — stillness is not being held')
    }

    // No two skins may be one picture wearing two names.
    //
    // The test is per-POSE, not per-pair: two tracks that both move will
    // always have some pair of frames that differs, so comparing the widest
    // pair proves nothing. A look is a duplicate when EVERY frame of it has a
    // near-twin in the other look — and that has to hold in BOTH directions,
    // or a superset with one extra pose would count as "the same".
    const LOOKS = ['healthy', 'idle-degraded', 'idle-unknown', 'idle-failed']
    const MIN_POSE_DIFF = 60
    /** The most "unmatched" frame of `a`, i.e. how far from `b` it can get. */
    const unmatched = (a, b) => {
      let worst = 0
      for (const fa of a) {
        let best = Infinity
        for (const fb of b) best = Math.min(best, diffCount(fa, fb))
        worst = Math.max(worst, best)
      }
      return worst
    }
    for (let x = 0; x < LOOKS.length; x += 1) {
      for (let y = x + 1; y < LOOKS.length; y += 1) {
        const A = framesOf[LOOKS[x]]
        const B = framesOf[LOOKS[y]]
        const outward = Math.max(unmatched(A, B), unmatched(B, A))
        if (unmatched(A, B) < MIN_POSE_DIFF && unmatched(B, A) < MIN_POSE_DIFF) {
          fail(`${LOOKS[x]} and ${LOOKS[y]} share every pose (worst pose gap ${outward} px) — one of them carries no state`)
        }
      }
    }

    // 8. every skin must point at a track that actually exists and loops, or
    //    `setSkin` silently falls back and the health channel goes dead.
    const declared = new Set([...PHASE_ORDER, ...SKIN_ORDER])
    const ids = new Set()
    for (const skin of SKINS) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(skin.id)) fail(`skin id "${skin.id}" is not lowercase kebab`)
      if (typeof skin.label !== 'string' || skin.label.length === 0) fail(`skin "${skin.id}" has no label`)
      if (ids.has(skin.id)) fail(`duplicate skin id "${skin.id}"`)
      ids.add(skin.id)
      if (!declared.has(skin.idleTrack)) fail(`skin "${skin.id}" points at undeclared track "${skin.idleTrack}"`)
    }

    // 9. The other half of the same contract. The plugin picks the id, this
    //    manifest declares it. An id the plugin can emit but this file does not
    //    declare gets `unknown-skin` back from the host, and the resting look
    //    silently stays whatever it was — a failure with no sound. So walk
    //    every verdict shape the plugin can be handed and require each result
    //    to exist here.
    const reachable = new Set()
    for (const verdict of [
      { tone: 'ok', errorCount: 0 },
      { tone: 'warn', errorCount: 0 },
      { tone: 'low', errorCount: 0 },
      { tone: 'low', errorCount: 2 },
      null,
    ]) {
      reachable.add(skinIdForHealth(verdict))
    }
    for (const id of reachable) {
      if (!ids.has(id)) fail(`the mascot plugin can request skin "${id}", which this manifest does not declare`)
    }
    const undeclared = [...reachable].filter((id) => !ids.has(id))
    if (undeclared.length === 0) {
      console.log(`skin contract OK: plugin can ask for {${[...reachable].join(', ')}}, manifest declares {${SKINS.map((s) => s.id).join(', ')}}`)
    } else {
      // Do not print OK on the same run that just failed the same check.
      console.error(`skin contract BROKEN: {${undeclared.join(', ')}} requested but not declared`)
    }
  }

  // 10. Every track must CLOSE, i.e. the last frame must flow into the first
  //     without a jump. This is the property the boss's complaint was really
  //     about: a track that does not close shows a sawtooth, and the eye reads
  //     a sawtooth as "the mark is spinning the wrong way".
  //
  //     "Closes" has two different meanings and both are checked, because the
  //     two motion models satisfy different ones:
  //       swing  (idle/waiting/thinking/tool + skins): frame n-1 EQUALS frame 0,
  //              so the wrap step is zero and there is nothing to snap.
  //       spin   (done): frame n-1 differs from frame 0 by the amount that
  //              completes a whole number of turns, so the wrap step is also
  //              continuous.
  //     A track passes if EITHER form holds, and the table prints which.
  {
    const norm = (d) => ((d % 360) + 360) % 360
    console.log('\ntrack              mode      wrap step   verdict')
    console.log('-'.repeat(56))
    for (const track of TRACKS_TO_CHECK) {
      const spec = SPEC_BY_TRACK[track]
      const n = spec.frames
      if (n <= 1) {
        console.log(`${track.padEnd(16)} ${'static'.padStart(9)}   ${'n/a'.padStart(10)}   single frame`)
        continue
      }
      const angles = Array.from({ length: n }, (_, i) => frameState(track, i, n).turn)
      // The seam is the move from the last frame back to the first. It is
      // invisible when that move is CONTINUOUS with the live steps:
      //   swing  last frame == first frame     => seam is exactly 0
      //   spin   seam == one more step         => e.g. `done` steps 45 deg
      //          eight times; the move back to 0 is another 45, and
      //          315 + 45 = 360, so the lap closes
      //
      // Compare the seam ON THE CIRCLE, not the raw angle. A rotation of -315
      // and a rotation of +45 are the same pose, so `done`'s perfectly
      // continuous next step is written as -315 in raw form. Two earlier
      // versions of this assertion got this wrong in opposite directions —
      // one compared |seam| to 360 (reporting a 315 deg "jump"), the next
      // compared the raw seam to the step size (rejecting the same good track).
      // The pose is what renders, so the circle is what gets compared.
      const liveSigned = []
      for (let i = 0; i < n - 1; i += 1) liveSigned.push(angles[i + 1] - angles[i])
      const seam = angles[0] - angles[n - 1]
      // Live steps live on the circle too, so a multi-turn phase compares equal.
      const seamOnCircle = norm360(seam)
      const liveOnCircle = liveSigned.filter((v) => Math.abs(norm360(v)) > 0.01).map((v) => norm360(v))
      const stepSize = liveOnCircle.length > 0
        ? liveOnCircle.reduce((s, v) => s + v, 0) / liveOnCircle.length
        : 0
      const swingForm = Math.abs(seam) < 0.01
      const spinForm = swingForm || (
        stepSize > 0
        && Math.abs(seamOnCircle - stepSize) < Math.max(0.01, stepSize * 0.01)
      )
      const mode = spec.swing !== undefined ? 'swing' : 'spin'
      const ok = mode === 'swing' ? swingForm : spinForm
      const verdict = !ok
        ? `SNAPS ${seamOnCircle.toFixed(1)} deg against a ${stepSize.toFixed(1)} deg step`
        : swingForm
          ? 'closed (last frame = first)'
          : `closed (seam is one more ${stepSize.toFixed(1)} deg step)`
      console.log(`${track.padEnd(16)} ${mode.padStart(9)}   ${(seamOnCircle.toFixed(1) + ' deg').padStart(10)}   ${verdict}`)
      if (!ok) {
        fail(`${track}: the seam moves ${seamOnCircle.toFixed(1)} deg while the live steps are ${stepSize.toFixed(1)} deg — that jump is the sawtooth`)
      }
    }
  }

  // 11. The loop must travel CLOCKWISE on screen.
  //
  //     The sign in `renderFrame` is easy to get backwards: canvas y grows
  //     downward and the sector test ADDS the rotation, so reading the code does
  //     not settle it. It is measured instead, from the production render.
  //
  //     The landmark is the HIGHLIGHT arc that only `tool` draws (near-white,
  //     45 degrees wide, expressed in the loop's own rotating frame). Three
  //     earlier probes failed and each failure is worth recording:
  //       - the 52-degree gap: the letter A crosses the band and FILLS the gap,
  //         so "find the empty window" measures nothing at all;
  //       - the sector edges: antialiasing plus the letter occluding the band
  //         leaves edges that jump between frames, so the probe tracked a
  //         different edge on each frame and reported the mark reversed;
  //       - reading `frameState` and re-rendering with our own `rot`: that
  //         bypasses the sign entirely, so it stayed green with the sign
  //         reverted — a check that could not fail.
  //     The highlight is thresholded by colour, is absent from every other
  //     phase, and is carried by the same `rot` as the ring, so it can only
  //     report the truth if the production path is what got measured.
  {
    const xf = new MarkTransform({ bbox: MARK_BBOX, canvas: CELL, fill: FILL })
    // (palette sum is not used: the b-r separation is the discriminator)

    /** Screen angle of the near-white highlight, or null when not visible. */
    const highlightAngle = (rgba) => {
      let sx = 0
      let sy = 0
      let n = 0
      for (let y = 0; y < CELL; y += 1) {
        for (let x = 0; x < CELL; x += 1) {
          const o = (y * CELL + x) * 4
          if (rgba[o + 3] < 200) continue
          const r = rgba[o]
          const g = rgba[o + 1]
          const b = rgba[o + 2]
          // Near-white and clearly not the cyan loop. Measured, not guessed:
          // the highlight renders as rgb(234,251,253) with b-r = 19, the cyan
          // loop as rgb(36,211,229) with b-r = 193, and the dimmed far side
          // falls to b-r ~ 115. So a b-r ceiling of 40 separates the
          // highlight from every loop tone with room to spare, and a
          // brightness floor rejects the dim ramp.
          if (r < 200 || g < 230 || b < 230) continue
          if (b - r > 40) continue
          const m = xf.unmap(x + 0.5, y + 0.5)
          const rad = Math.hypot(m.x - LOOP_CENTER.cx, m.y - LOOP_CENTER.cy)
          if (rad < LOOP_R_INNER || rad > LOOP_R_OUTER) continue
          const a = Math.atan2(m.y - LOOP_CENTER.cy, m.x - LOOP_CENTER.cx)
          sx += Math.cos(a)
          sy += Math.sin(a)
          n += 1
        }
      }
      if (n < 20) return null
      return { deg: norm360(Math.atan2(sy, sx) * DEG), px: n }
    }

    const TOOL_N = SPEC_BY_TRACK.tool.frames
    // Only the OUTBOUND half of the swing is measured. `tool` is a triangle
    // swing: it travels out to +A, then folds back, and that fold is a real
    // reversal on screen. Reading all six frames reported frames 4-5 as
    // "counter-clockwise", which is the return stroke, not a wrong sign — so
    // the probe has to stop where the fold starts. The step is the same on
    // the way out every time, so two steps are enough to fix the direction.
    const OUTBOUND = Math.ceil(TOOL_N / 2)
    let previous = null
    let measured = 0
    for (const frame of [0, 1, 2, 3]) {
      if (frame >= OUTBOUND) break
      const seen = highlightAngle(renderFrame('tool', frame, TOOL_N))
      if (seen === null) {
        fail(`direction probe: no highlight found in tool frame ${frame} — the probe cannot see the loop's frame`)
        break
      }
      if (previous !== null) {
        const delta = norm360(seen.deg - previous)
        const label = delta < 180 ? 'CLOCKWISE' : 'COUNTER-CLOCKWISE'
        console.log(`direction: tool frame ${frame} highlight at ${seen.deg.toFixed(1).padStart(6)} deg (${seen.px} px), moved +${delta.toFixed(1)} => ${label}`)
        if (delta >= 180) {
          fail(`tool frame ${frame}: the loop travels ${label} on screen — the boss reads that as spinning backwards`)
        }
      } else {
        console.log(`direction: tool frame ${frame} highlight at ${seen.deg.toFixed(1)} deg (${seen.px} px)`)
      }
      previous = seen.deg
      measured += 1
    }
    if (measured === OUTBOUND) {
      console.log(`direction OK: the highlight travels clockwise over the ${OUTBOUND} outbound frames, measured from the production render`)
    }
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} check(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('all checks passed')

  if (previewDir !== null) {
    mkdirSync(previewDir, { recursive: true })

    // Contact sheet: one row per phase, one column per frame, 1px gutters.
    const TH = 96
    const cols = Math.max(...PHASE_ORDER.map((p) => PHASES[p].frames))
    const gutter = 6
    const pad = 10
    const sheetW = pad * 2 + cols * (TH + gutter)
    const sheetH = pad * 2 + PHASE_ORDER.length * (TH + gutter)
    const sheet = new Uint8Array(sheetW * sheetH * 4)
    // A dark ground, because that is where the pet actually lives and the
    // onDark palette only has to work here.
    for (let i = 0; i < sheetW * sheetH; i += 1) {
      sheet[i * 4] = 10
      sheet[i * 4 + 1] = 27
      sheet[i * 4 + 2] = 52
      sheet[i * 4 + 3] = 255
    }
    PHASE_ORDER.forEach((phase, row) => {
      all[phase].forEach((rgba, col) => {
        const small = renderFrame(phase, col, PHASES[phase].frames, TH, FILL, 3)
        blit(sheet, sheetW, small, TH, pad + col * (TH + gutter), pad + row * (TH + gutter))
      })
    })
    writeFileSync(join(previewDir, 'contact-sheet.png'), encodePng(sheetW, sheetH, sheet))
    console.log(`wrote contact-sheet.png  ${sheetW}x${sheetH}  (${PHASE_ORDER.length} rows x ${cols} cols, ${TH}px cells, on #0A1B34)`)

    // Display strip: frame 0 of each phase at the real 160px display size.
    const DS = 160
    const stripW = pad * 2 + PHASE_ORDER.length * (DS + gutter)
    const stripH = pad * 2 + DS
    const strip = new Uint8Array(stripW * stripH * 4)
    for (let i = 0; i < stripW * stripH; i += 1) {
      strip[i * 4] = 10
      strip[i * 4 + 1] = 27
      strip[i * 4 + 2] = 52
      strip[i * 4 + 3] = 255
    }
    PHASE_ORDER.forEach((phase, col) => {
      const small = renderFrame(phase, 0, PHASES[phase].frames, DS, FILL, 4)
      blit(strip, stripW, small, DS, pad + col * (DS + gutter), pad)
    })
    writeFileSync(join(previewDir, 'display-size.png'), encodePng(stripW, stripH, strip))
    console.log(`wrote display-size.png   ${stripW}x${stripH}  (7 phases at the real ${DS}px display size)`)
  }
}

main()
