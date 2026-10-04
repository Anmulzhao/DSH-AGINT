// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
//
// AGINT pet asset build.
//
// ## What this makes
//
// Seven phase tracks of a frames2d pet, drawn from the real brand geometry
// (see mark.mjs) rather than from a redrawn approximation. 44 PNG frames.
//
// ## The one idea
//
// The mark is a letter A with a self-evolution loop woven through it. A
// letterform does not bounce. So the A is the still part: it never scales,
// never shifts, never rotates, in any of the seven phases.
//
// The loop is the part that means something, so it carries all the motion.
// It does not spin in its own plane — a flat ring turning reads as a letter
// C skidding on glass, because a circle has no feature to show the turn.
// It ORBITS: every point of the loop carries a depth, the near arc rides over
// the letter and stays at full brand cyan, and the far arc drops behind the
// letter and dims. The loop's own rotation then carries that whole depth
// field around the letter, so the crossing point travels by itself. No one
// animates the weave. It falls out of depth.
//
// The silhouette never changes: the loop stays the exact brand circle at
// every frame, which is why `build.mjs --verify` still measures it against
// the shipped 933x919 icon. Only depth, brightness and occlusion move.
//
// That leaves three channels for state, and the character spec asks for
// exactly three: motion (which phase track is playing), colour (tone), and
// text (the announcement bubble, which is the plugin's job, not this file's).
//
// ## Running it
//
//   node build.mjs --out <dir>     build the pet into <dir>
//   node build.mjs --verify        check the geometry against the shipped icon
//
// No dependencies. Needs node >= 18.

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from './png.mjs'
import { rasterize, insidePolygon, inAnnulusSector, hexToRgb, MarkTransform } from './raster.mjs'
import {
  LETTER_A,
  LOOP_CENTER,
  LOOP_R_INNER,
  LOOP_R_OUTER,
  LOOP_SWEEP_DEG,
  LOOP_BEHIND,
  // `verifyGeometry` reproduces the SHIPPED icon's own static layering, not
  // the pet's depth model, because that is what it is checking against. The
  // two must stay independent: the check below is the transcription test, and
  // it must not start passing or failing because the art direction moved.
  LOOP_IN_FRONT,
  MARK_BBOX,
  COLORS,
} from './mark.mjs'

/* ------------------------------------------------------------------ *
 * Output shape
 * ------------------------------------------------------------------ */

/** Square cell edge in px. The pet displays at 160; 256 leaves headroom for hidpi. */
const CELL = 256

/**
 * Fraction of the cell the mark's WIDER side occupies. The rest is motion
 * headroom, so nothing clips when the loop swings or the mark lifts.
 *
 * The shipped 1024 icon fits the mark to 933/1024 = 0.911 of the canvas.
 * 0.86 is a little looser, because a still letter plus a turning loop needs
 * room that a static icon does not.
 */
const FILL = 0.86

/** Supersampling factor per axis. 5x5 = 25 samples/pixel. */
const SAMPLES = 5

/**
 * Orbit depth.
 *
 * `nearness` runs +1 at the loop's leftmost point to -1 at its rightmost, so
 * depth is a property of the loop, not of the frame. Positive is toward the
 * viewer, and the viewer looks slightly down the vertical axis the letter
 * stands on — so the loop sweeps around the letter rather than across it.
 *
 * `DEPTH_DIM` is how far the receding arc dims. The near half keeps EXACTLY
 * the brand cyan: the published mark never shows a dark cyan, so dimming both
 * halves would quietly rewrite the palette. Only the part that has gone behind
 * the letter loses light.
 */
const DEPTH_DIM = 0.5

/* ------------------------------------------------------------------ *
 * Art direction: the seven phases
 * ------------------------------------------------------------------ */

/**
 * `turn` is degrees per frame. A number turns clockwise; the string 'osc'
 * swings back and forth instead, which is what reading/reviewing looks like.
 *
 * `lift` and `sink` are fractions of the cell edge, applied to the whole mark
 * and used only where the phase earns them. A 2% move is felt, not seen;
 * anything past 4% stops being tasteful and starts being a cartoon.
 */
const PHASES = {
  idle: { frames: 6, ms: 900, turn: 5, loopAlpha: 1, tone: 'normal' },
  waiting: { frames: 4, ms: 700, turn: 1.5, loopAlpha: 0.7, tone: 'normal' },
  thinking: { frames: 8, ms: 200, turn: 13, loopAlpha: 1, tone: 'normal' },
  tool: { frames: 6, ms: 130, turn: 26, loopAlpha: 1, tone: 'normal', sweep: 45 },
  review: { frames: 8, ms: 380, turn: 'osc', loopAlpha: 1, tone: 'normal' },
  done: { frames: 8, ms: 150, turn: 45, loopAlpha: 1, tone: 'normal', lift: 0.03 },
  failed: { frames: 4, ms: 1000, turn: 0, loopAlpha: 0.85, tone: 'fault', sink: 0.015 },
}

const PHASE_ORDER = ['idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed']

/* ------------------------------------------------------------------ *
 * System-health skins
 * ------------------------------------------------------------------ */

/**
 * The skins say how AGINT is doing. Health is a STATE, not a moment, so it
 * rides `ctx.pet.setSkin()` rather than `announce` — an announcement is a
 * sentence the pet says once; a skin is how it rests until things change.
 *
 * The four looks are told apart by MOTION first and colour second. Colour
 * alone cannot carry state (see the character spec), so three of the four
 * keep the brand palette and differ only in how the loop moves:
 *
 *   healthy   drifts forward at a steady pace (reuses the `idle` track)
 *   degraded  still goes forward, but it limps: long stalls, then a snatch
 *   unknown   swings back and forth and NEVER advances; nothing is progressing
 *   failed    one still frame. Not moving is the message, and it is the only
 *             look allowed off-palette.
 *
 * `turn` may be:
 *   - a number: degrees per frame
 *   - 'osc':    a back-and-forth swing of `oscAmp` degrees (default 14)
 *   - an array: one absolute angle per frame.  Needed when the step PATTERN
 *               carries the meaning — see `idle-unknown`.
 *
 * `ms` may be a number or an array of per-frame dwells. Uneven dwells are how
 * `idle-degraded` limps without changing how far it travels per frame: the
 * angle steps stay even, the cadence does not. check.mjs asserts each skin
 * still moves enough to read, so neither channel can go quietly dead.
 */
const SKIN_TRACKS = {
  'idle-degraded': { frames: 6, ms: 700, turn: [0, 14, 16, 34, 36, 52], loopAlpha: 0.9, tone: 'normal' },
  'idle-unknown': { frames: 6, ms: 900, turn: [0, 14, 22, 14, 0, -14], loopAlpha: 0.9, tone: 'normal' },
  'idle-failed': { frames: 1, ms: 1000, turn: 0, loopAlpha: 0.85, tone: 'fault' },
}

const SKIN_ORDER = ['idle-degraded', 'idle-unknown', 'idle-failed']

const SKINS = [
  { id: 'healthy', label: '健康', idleTrack: 'idle' },
  { id: 'degraded', label: '亚健康', idleTrack: 'idle-degraded' },
  { id: 'unknown', label: '未知', idleTrack: 'idle-unknown' },
  { id: 'failed', label: '故障', idleTrack: 'idle-failed' },
]

/** Every rendered track: the seven phases plus the skins that need their own. */
const TRACK_ORDER = [...PHASE_ORDER, ...SKIN_ORDER]

/* ------------------------------------------------------------------ *
 * Frame state
 * ------------------------------------------------------------------ */

const RGB = {
  normal: { a: hexToRgb(COLORS.A), loop: hexToRgb(COLORS.LOOP) },
  fault: { a: hexToRgb(COLORS.STATE_A), loop: hexToRgb(COLORS.STATE_LOOP) },
}

/** A short near-white arc riding the loop's leading edge. */
const HIGHLIGHT = hexToRgb('#EAFBFD')

/**
 * The per-frame state of the mark, derived from the phase and the frame index.
 * @param {string} phase @param {number} i @param {number} n
 */
const SPEC_BY_TRACK = { ...PHASES, ...SKIN_TRACKS }

/**
 * @param {string} phase - a phase name or a skin track name.
 * @param {number} i @param {number} n
 */
function frameState(phase, i, n) {
  const spec = SPEC_BY_TRACK[phase]
  if (spec === undefined) throw new Error(`no such track: ${phase}`)
  const phaseProgress = n <= 1 ? 0 : i / n

  let turn
  if (spec.turn === 'osc') {
    // A full sine cycle over the track, so frame n-1 flows into frame 0.
    turn = (spec.oscAmp ?? 14) * Math.sin(2 * Math.PI * phaseProgress)
  } else if (Array.isArray(spec.turn)) {
    if (spec.turn.length !== n) {
      throw new Error(`track ${phase}: ${spec.turn.length} turn angles for ${n} frames`)
    }
    turn = spec.turn[i]
  } else {
    turn = spec.turn * i
  }

  // A single hump that starts and ends at rest, so the loop back to frame 0
  // has no visible seam.
  const hump = n <= 1 ? 0 : Math.sin(Math.PI * phaseProgress)

  return {
    turn,
    scaleMul: 1 + (spec.lift ?? 0) * hump,
    offsetY: -(spec.sink ?? 0) * hump * CELL,
    tone: spec.tone,
    loopAlpha: spec.loopAlpha,
    sweepDeg: spec.sweep ?? 0,
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Draw one frame.
 * @param {string} phase @param {number} i @param {number} n
 * @returns {Uint8Array} RGBA, CELL*CELL*4
 */
export function renderFrame(phase, i, n) {
  const st = frameState(phase, i, n)
  const palette = RGB[st.tone]
  const xf = new MarkTransform({ bbox: MARK_BBOX, canvas: CELL, fill: FILL, scaleMul: st.scaleMul, offsetY: st.offsetY })

  // Rotation is subtracted inside the sector test, so a positive `turn` here
  // moves the loop clockwise on screen.
  const rot = -st.turn

  const letter = (px, py) => {
    const m = xf.unmap(px, py)
    return insidePolygon(m.x, m.y, LETTER_A)
  }

  /**
   * The whole loop as ONE layer. Its front/behind split used to be two fixed
   * sectors; it is now this single depth field, which the rotation carries
   * around the letter.
   *
   * @returns {number} nearness, -1 (far) .. +1 (near)
   */
  const nearness = (px, py) => {
    const m = xf.unmap(px, py)
    const f = -(m.x - LOOP_CENTER.cx) / LOOP_R_OUTER
    return f < -1 ? -1 : f > 1 ? 1 : f
  }

  // The loop layer's colour is a function of position because the depth cues
  // are: a near:er arc keeps the brand cyan, a receding one loses light.
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
    // One layer for the loop. Depth decides against the letter per sample.
    { test: ring(LOOP_BEHIND.startDeg, LOOP_SWEEP_DEG), color: loopColor, alpha: st.loopAlpha, depth: nearness },
    // The letter sits at the default depth 0, i.e. the loop's own horizon.
    { test: letter, color: palette.a },
  ]

  if (st.sweepDeg > 0) {
    // The highlight rides the loop's own leading edge, so it is expressed in
    // the loop's rotating frame: it starts where the loop starts, every frame.
    // It carries the same depth, so it dives behind the letter too rather than
    // appearing to skate across the whole mark.
    layers.push({
      test: ring(LOOP_BEHIND.startDeg, st.sweepDeg),
      color: HIGHLIGHT,
      alpha: 0.92,
      depth: nearness,
    })
  }

  return rasterize({ width: CELL, height: CELL, samples: SAMPLES, layers })
}

/* ------------------------------------------------------------------ *
 * Geometry self-check
 * ------------------------------------------------------------------ */

/**
 * Check the reconstructed geometry against the shipped icon's measured stats.
 *
 * The numbers come from reading `docs/assets/brand/png/agint-icon-1024-onDark.png`
 * pixel by pixel: 933x919 inked box centred in 1024, 26.19% of the canvas
 * actually inked. If the transcription in mark.mjs were wrong, the box aspect
 * and the coverage would both drift.
 */
export function verifyGeometry() {
  const size = 1024
  // The shipped icon is an SVG with viewBox "0 0 360 360" rasterised at 1024,
  // so its scale is fixed at 1024/360 = 2.8444. Reproduce that exact scale
  // rather than fitting, or the comparison is not like-for-like.
  const scale = size / 360
  const xf = new MarkTransform({ bbox: MARK_BBOX, canvas: size, fill: (MARK_BBOX.maxX - MARK_BBOX.minX) * scale / size })
  const rot = 0
  const ring = (sector) => (px, py) => {
    const m = xf.unmap(px, py)
    return inAnnulusSector(m.x, m.y, { ...LOOP_CENTER, rOuter: LOOP_R_OUTER, rInner: LOOP_R_INNER, ...sector }, rot)
  }
  const letter = (px, py) => {
    const m = xf.unmap(px, py)
    return insidePolygon(m.x, m.y, LETTER_A)
  }
  const rgba = rasterize({
    width: size,
    height: size,
    samples: 2,
    layers: [
      { test: ring(LOOP_BEHIND), color: RGB.normal.loop },
      { test: letter, color: RGB.normal.a },
      { test: ring(LOOP_IN_FRONT), color: RGB.normal.loop },
    ],
  })

  let minX = size
  let minY = size
  let maxX = -1
  let maxY = -1
  let inked = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rgba[(y * size + x) * 4 + 3] < 8) continue
      inked += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  // The pixel box under-measures height by ~10px, and that is a measurement
  // artefact rather than a geometry error: the apex and the two bottom corners
  // are single points, so their antialiasing falls below the alpha threshold
  // and the tip drops out. The analytic box has no such problem, so it is the
  // one the check compares against; the pixel box is still printed as a second
  // reading of the same thing.
  const analytic = {
    w: Math.round((MARK_BBOX.maxX - MARK_BBOX.minX) * scale),
    h: Math.round((MARK_BBOX.maxY - MARK_BBOX.minY) * scale),
  }

  return {
    box: { w: maxX - minX + 1, h: maxY - minY + 1, minX, minY },
    analytic,
    expectedBox: { w: 933, h: 919 },
    coverage: inked / (size * size),
    expectedCoverage: 0.2619,
  }
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

/** Per-frame dwell list. A number repeats; an array must cover every frame. */
function frameMsOf(track, spec) {
  if (!Array.isArray(spec.ms)) return Array.from({ length: spec.frames }, () => spec.ms)
  if (spec.ms.length !== spec.frames) {
    throw new Error(`track ${track}: ${spec.ms.length} dwell values for ${spec.frames} frames`)
  }
  return spec.ms.slice()
}

function buildManifest() {
  const tracks = {}
  const phases = {}
  for (const track of TRACK_ORDER) {
    const spec = SPEC_BY_TRACK[track]
    tracks[track] = {
      frames: Array.from({ length: spec.frames }, (_, i) => `${String(i).padStart(3, '0')}.png`),
      frameMs: frameMsOf(track, spec),
      loop: true,
    }
    if (PHASES[track] !== undefined) phases[track] = track
  }
  return {
    petManifestVersion: 2,
    id: 'agint',
    displayName: '智进',
    renderer: 'frames2d',
    frames2d: {
      dir: 'frames',
      defaultFrameMs: 200,
      tracks,
      phases,
      skins: SKINS,
    },
    description:
      '智进（AGINT）的形象：一个字母 A 与自进化回环交织。字母不动，回环绕着它转 —— '
      + '近端 Stay 品牌青压在字母之上，远端转暗并没入字母之后，编织点因此自己走。'
      + '轮廓每一帧都与已发布品牌图标一致（A 近白 #F5F8FC，回环信号青 #24D3E5），适配 DSH 深色外壳。',
    license: 'MIT',
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { out: null, verify: false }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[i + 1]
    if (argv[i] === '--verify') out.verify = true
  }
  return out
}

function main() {
  const args = parseArgs(process.argv)

  if (args.verify) {
    const r = verifyGeometry()
    console.log(`analytic box           ${r.analytic.w}x${r.analytic.h}   <- compared`)
    console.log(`shipped icon box       ${r.expectedBox.w}x${r.expectedBox.h}`)
    console.log(`pixel box (threshold)  ${r.box.w}x${r.box.h} @ (${r.box.minX},${r.box.minY})   <- under-reads sharp tips`)
    console.log(`box width error        ${r.analytic.w - r.expectedBox.w} px`)
    console.log(`box height error       ${r.analytic.h - r.expectedBox.h} px`)
    console.log(`reconstructed coverage ${(r.coverage * 100).toFixed(2)}%`)
    console.log(`shipped icon coverage  ${(r.expectedCoverage * 100).toFixed(2)}%`)
    const sizeErr = Math.max(Math.abs(r.analytic.w - r.expectedBox.w), Math.abs(r.analytic.h - r.expectedBox.h))
    const drift = Math.abs(r.coverage - r.expectedCoverage)
    if (sizeErr > 4) {
      console.error(`box size error ${sizeErr}px > 4px — transcription is wrong`)
      process.exitCode = 1
    } else if (drift > 0.01) {
      console.error(`coverage drift ${(drift * 100).toFixed(2)}% > 1% — transcription is wrong`)
      process.exitCode = 1
    } else {
      console.log('OK — transcription matches the shipped raster')
    }
    return
  }

  if (args.out === null) {
    console.error('usage: node build.mjs --out <dir> | node build.mjs --verify')
    process.exitCode = 2
    return
  }

  const framesRoot = join(args.out, 'frames')
  if (existsSync(framesRoot)) rmSync(framesRoot, { recursive: true })

  let total = 0
  for (const track of TRACK_ORDER) {
    const spec = SPEC_BY_TRACK[track]
    const dir = join(framesRoot, track)
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < spec.frames; i += 1) {
      const png = encodePng(CELL, CELL, renderFrame(track, i, spec.frames))
      writeFileSync(join(dir, `${String(i).padStart(3, '0')}.png`), png)
      total += 1
    }
  }

  writeFileSync(join(args.out, 'pet.json'), `${JSON.stringify(buildManifest(), null, 2)}\n`)

  console.log(`built ${total} frames at ${CELL}x${CELL} into ${framesRoot}`)
  for (const phase of PHASE_ORDER) {
    const s = PHASES[phase]
    console.log(`  ${phase.padEnd(9)} ${String(s.frames).padStart(2)} frames @ ${s.ms}ms  turn=${s.turn}`)
  }
}

main()
