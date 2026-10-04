'use strict';
/**
 * 智进（Zhijin）帧生成器
 * ---------------------------------------------------------------------------
 * 规范：DSH-AGINT/docs/brand/agint-character-spec.md §9.8（参数表）
 * 输入：一份参数表（本文件顶部 P + TRACKS）
 * 输出：frames2d 帧文件 <out>/<track>/frame-NN.webp + pet-manifest.json
 *
 * 运行：
 *   NODE_PATH=<node workspace>/node_modules node render.cjs
 *   node render.cjs --canvas=96 --out=dist-96     # 96px 实测档
 *   node render.cjs --ink=navy                    # 亮底变体
 *
 * 设计约束（来自规范，改动前先读）：
 *   1. 缺口永不闭合。任何状态 θ_gap > 0。done 是「推进一档」不是「闭合」。
 *   2. 不画眼、脸、身体、任何生物特征。不画字母 A 字形。
 *   3. 参数独立取值，不复用母版实测几何（许可 §9.9 规则 2）。
 *   4. 七相位共用同一个扰动函数 —— 是「同一个体的不同时刻」，不是七个随机形状。
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const D2R = Math.PI / 180;

/* ==========================================================================
 * 1. 参数表（规范 §9.8 定稿值）
 * ========================================================================== */
const P = {
  canvas: 256,

  // r0 = canvas × r0Ratio。0.39 由母版 boxAreaPct 81.95%（§3 实测）反推：
  // 外缘半径 R = r0(1+ε) + w_end/2 = r0(1.03 + 0.13) = 1.16 r0
  // 包围盒边长 = 2R = 2.32 r0；令 (2.32 r0)² / canvas² = 0.82 ⇒ r0 = 0.390 canvas
  r0Ratio: 0.39,

  eps: 0.03, // 径向扰动幅度（增强 A）
  wStartRatio: 0.18, // 起笔端线宽 = r0 × 0.18
  wEndRatio: 0.26, // 收笔端线宽 = r0 × 0.26（渐宽）

  thetaMin: 18, // healthy / idle
  theta0: 36, // 中性（engaged 相位）
  thetaMax: 72, // unknown
  delta: 9, // 档差
  thetaEnd: 45, // 收笔端固定角位（右上 = 前进方向）

  seed: 20261004, // 扰动噪声固定种子，七相位共用

  inkDark: '#24D3E5', // 暗底（dsh web 实测背景 #070b1a/#131c36）→ 青
  inkLight: '#0A1B34', // 亮底 → 深蓝
};

/**
 * 轨道表。
 * motion 决定帧间如何变化；style 决定线型（皮肤区分靠线型，不靠颜色）。
 */
const TRACKS = [
  { name: 'idle', frames: 12, ms: 200, loop: true, motion: 'breathe', style: 'solid', gap: P.thetaMin },
  { name: 'waiting', frames: 6, ms: 120, loop: true, motion: 'jitter', style: 'solid', gap: P.theta0 },
  { name: 'thinking', frames: 8, ms: 150, loop: true, motion: 'branch', style: 'solid', gap: P.theta0 },
  { name: 'tool', frames: 8, ms: 110, loop: true, motion: 'arm', style: 'solid', gap: P.theta0 },
  { name: 'review', frames: 8, ms: 150, loop: true, motion: 'loop', style: 'solid', gap: P.theta0 },
  { name: 'done', frames: 6, ms: 80, loop: false, motion: 'advance', style: 'solid', gap: P.theta0, fallback: 'idle' },
  { name: 'failed', frames: 6, ms: 90, loop: false, motion: 'break', style: 'solid', gap: P.theta0, fallback: 'idle' },

  // 皮肤 idle 轨道（§9.7）：靠线型区分。healthy 复用 base idle，故净增 3 套。
  { name: 'idle-degraded', frames: 12, ms: 200, loop: true, motion: 'breathe', style: 'dash', gap: P.theta0 + P.delta },
  { name: 'idle-unknown', frames: 12, ms: 200, loop: true, motion: 'breathe', style: 'fade', gap: P.thetaMax },
  { name: 'idle-failed', frames: 12, ms: 200, loop: true, motion: 'still', style: 'break', gap: P.theta0 + 2 * P.delta },
];

/* ==========================================================================
 * 2. 几何
 * ========================================================================== */

/** 固定种子的低频周期噪声。k 取整数 ⇒ 沿环首尾连续，接缝无跳变。 */
function makeNoise(seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const comps = [];
  let ampSum = 0;
  for (let i = 0; i < 3; i++) {
    const a = 0.4 + 0.6 * rnd();
    comps.push({ a, k: 2 + i * 2, p: rnd() * Math.PI * 2 });
    ampSum += a;
  }
  return (rad) => {
    let v = 0;
    for (const c of comps) v += c.a * Math.sin(c.k * rad + c.p);
    return v / ampSum;
  };
}

function makeGeom(canvas, params) {
  const noise = makeNoise(params.seed);
  const r0 = canvas * params.r0Ratio;
  const c = canvas / 2;
  return {
    canvas,
    r0,
    cx: c,
    cy: c,
    rAt: (deg) => r0 * (1 + params.eps * noise(deg * D2R)),
    ptAt: (deg, extra = 0) => {
      const r = r0 * (1 + params.eps * noise(deg * D2R)) + extra;
      return [c + r * Math.cos(deg * D2R), c - r * Math.sin(deg * D2R)];
    },
  };
}

function samplePath(g, fromDeg, toDeg, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const deg = fromDeg + (toDeg - fromDeg) * (i / (n - 1));
    pts.push(g.ptAt(deg));
  }
  return pts;
}

const fmt = (p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`;

/** 中心线 + 宽度数组 ⇒ 变宽描边（闭合多边形，含圆头端帽）。 */
function ribbon(pts, ws, capSteps = 12) {
  const n = pts.length;
  if (n < 2) return '';
  const tan = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    tan.push([dx / L, dy / L]);
  }
  const L = [];
  const R = [];
  for (let i = 0; i < n; i++) {
    const nx = -tan[i][1];
    const ny = tan[i][0];
    L.push([pts[i][0] + nx * ws[i] / 2, pts[i][1] + ny * ws[i] / 2]);
    R.push([pts[i][0] - nx * ws[i] / 2, pts[i][1] - ny * ws[i] / 2]);
  }

  let d = `M ${fmt(L[0])}`;
  for (let i = 1; i < n; i++) d += ` L ${fmt(L[i])}`;

  // 收笔端圆头：从 L 侧绕笔尖（+t 方向）到 R 侧
  const nE = [-tan[n - 1][1], tan[n - 1][0]];
  const aE = Math.atan2(nE[1], nE[0]);
  if (ws[n - 1] > 0.05) {
    for (let j = 1; j < capSteps; j++) {
      const ang = aE - (Math.PI * j) / capSteps;
      d += ` L ${fmt([pts[n - 1][0] + Math.cos(ang) * ws[n - 1] / 2, pts[n - 1][1] + Math.sin(ang) * ws[n - 1] / 2])}`;
    }
  }
  for (let i = n - 1; i >= 0; i--) d += ` L ${fmt(R[i])}`;

  // 起笔端圆头：从 R 侧绕 -t 方向回到 L 侧
  const nS = [-tan[0][1], tan[0][0]];
  const aS = Math.atan2(nS[1], nS[0]);
  if (ws[0] > 0.05) {
    for (let j = 1; j < capSteps; j++) {
      const ang = aS + Math.PI - (Math.PI * j) / capSteps;
      d += ` L ${fmt([pts[0][0] + Math.cos(ang) * ws[0] / 2, pts[0][1] + Math.sin(ang) * ws[0] / 2])}`;
    }
  }
  return d + ' Z';
}

function cumLen(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
}

/* ==========================================================================
 * 3. 主笔迹：一条不闭合的单笔环形路径
 * ========================================================================== */

/**
 * @returns {Array<{pts:number[][], ws:number[]}>} 若干段（dash/break 会产生多段）
 */
function buildStrokes(g, opt) {
  const n = 400;
  const fromDeg = P.thetaEnd + opt.gap - 360;
  const toDeg = P.thetaEnd + (opt.endWobble || 0);
  let pts = samplePath(g, fromDeg, toDeg, n);

  const wBase = g.r0 * (opt.widthScale || 1);
  let ws = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    ws[i] = wBase * (P.wStartRatio + (P.wEndRatio - P.wStartRatio) * t);
  }

  // unknown：起笔端渐隐 —— 用线宽收敛到 0 表达，不用透明度
  // （透明度在灰度打印与小尺寸下会丢失，线宽不会）
  if (opt.style === 'fade') {
    const span = 0.22;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      if (t < span) {
        const u = t / span;
        ws[i] *= u * u * (3 - 2 * u);
      }
    }
  }

  if (opt.rotate) {
    const a = opt.rotate * D2R;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    pts = pts.map(([x, y]) => {
      const dx = x - g.cx;
      const dy = y - g.cy;
      return [g.cx + dx * cs - dy * sn, g.cy + dx * sn + dy * cs];
    });
  }
  if (opt.dy) pts = pts.map(([x, y]) => [x, y + opt.dy]);

  const out = [];

  if (opt.style === 'dash') {
    // degraded：中段虚线，两端仍清晰（「仍连通」的语义）
    const cum = cumLen(pts);
    const total = cum[n - 1];
    const at = (frac) => {
      const target = frac * total;
      let i = 1;
      while (i < n - 1 && cum[i] < target) i++;
      return i;
    };
    const a = at(0.2);
    const b = at(0.8);
    // 关键：ribbon 每段自带圆头端帽（各伸出 w/2），视觉间隔 = gapLen − 线宽。
    // 线宽中值 ≈ 0.22 r0 ⇒ gapLen 必须显著大于线宽，否则虚线糊成实线（已实测踩坑）。
    const dashLen = 0.35 * g.r0;
    const gapLen = 0.45 * g.r0;
    out.push({ pts: pts.slice(0, a + 1), ws: ws.slice(0, a + 1) });
    let s = a;
    let guard = 0;
    while (s < b && guard++ < 200) {
      let e = s;
      while (e < b && cum[e] - cum[s] < dashLen) e++;
      if (e > s) out.push({ pts: pts.slice(s, e + 1), ws: ws.slice(s, e + 1) });
      let e2 = e;
      while (e2 < b && cum[e2] - cum[e] < gapLen) e2++;
      if (e2 <= e) break;
      s = e2;
    }
    out.push({ pts: pts.slice(b), ws: ws.slice(b) });
    return out;
  }

  if (opt.style === 'break') {
    // failed：断成两段且错位（不可接续）。断端回缩变细。
    const cum = cumLen(pts);
    const total = cum[n - 1];
    const at = (frac) => {
      const target = frac * total;
      let i = 1;
      while (i < n - 1 && cum[i] < target) i++;
      return i;
    };
    const b0 = at(0.7);
    const b1 = at(0.78);
    out.push({ pts: pts.slice(0, b0 + 1), ws: ws.slice(0, b0 + 1) });
    const off = g.r0 * (opt.breakOffset === undefined ? 0.05 : opt.breakOffset);
    const p2 = pts.slice(b1).map(([x, y]) => [x + off * 0.6, y + off]);
    const w2 = ws.slice(b1).map((w) => w * 0.85);
    for (let i = 0; i < w2.length; i++) {
      const t = i / (w2.length - 1);
      if (t < 0.35) {
        const u = t / 0.35;
        w2[i] *= 0.3 + 0.7 * (u * u * (3 - 2 * u));
      }
    }
    out.push({ pts: p2, ws: w2 });
    return out;
  }

  out.push({ pts, ws });
  return out;
}

/* ==========================================================================
 * 4. 附加笔迹（thinking 分支 / tool 工具臂 / review 回折）
 * ========================================================================== */

function strokeBranch(g, degAt, lenFrac, widthAt) {
  const [px, py] = g.ptAt(degAt);
  const dx0 = -Math.cos(degAt * D2R);
  const dy0 = Math.sin(degAt * D2R); // 指向环心
  const L = g.r0 * lenFrac;
  const m = 12;
  const pts = [];
  const ws = [];
  for (let i = 0; i < m; i++) {
    const u = i / (m - 1);
    const bend = 0.3 * Math.sin(Math.PI * u);
    const nx = -dy0;
    const ny = dx0;
    pts.push([px + dx0 * L * u + nx * L * bend * 0.35, py + dy0 * L * u + ny * L * bend * 0.35]);
    ws.push(widthAt * (1 - 0.55 * u));
  }
  return { pts, ws };
}

function strokeArm(g, degAt, lenFrac, widthAt) {
  const [px, py] = g.ptAt(degAt);
  const dx0 = Math.cos(degAt * D2R);
  const dy0 = -Math.sin(degAt * D2R); // 指向环外
  const L = g.r0 * lenFrac;
  const m = 12;
  const pts = [];
  const ws = [];
  for (let i = 0; i < m; i++) {
    const u = i / (m - 1);
    pts.push([px + dx0 * L * u, py + dy0 * L * u]);
    ws.push(widthAt * (1 - 0.45 * u)); // 缓收，保持「伸出」的体量感
  }
  return { pts, ws };
}

function strokeLoop(g, degAt, widthAt, frac) {
  const [px, py] = g.ptAt(degAt);
  const rl = g.r0 * 0.15;
  const inwardX = -Math.cos(degAt * D2R);
  const inwardY = Math.sin(degAt * D2R);
  const ccx = px + inwardX * rl * 1.25;
  const ccy = py + inwardY * rl * 1.25;
  const steps = Math.max(4, Math.round(48 * frac));
  const pts = [];
  const ws = [];
  for (let i = 0; i <= steps; i++) {
    const a = -90 * D2R + (350 * D2R * frac * i) / steps;
    pts.push([ccx + rl * Math.cos(a), ccy - rl * Math.sin(a)]);
    ws.push(widthAt * 0.8);
  }
  if (pts.length < 2) return null;
  return { pts, ws };
}

/* ==========================================================================
 * 5. 帧状态 → SVG
 * ========================================================================== */

function frameState(track, i, frames) {
  const u = frames > 1 ? i / frames : 0; // 循环相位 [0,1)
  const oneShot = frames > 1 ? i / (frames - 1) : 1; // 单次 [0,1]
  const s = {
    gap: track.gap,
    style: track.style,
    widthScale: 1,
    endWobble: 0,
    rotate: 0,
    dy: 0,
    extra: [],
  };

  switch (track.motion) {
    case 'breathe':
      s.widthScale = 1 + 0.01 * Math.sin(2 * Math.PI * u);
      break;
    case 'jitter':
      s.endWobble = 0.5 * Math.sin(2 * Math.PI * u); // 收笔端驻留微颤 ±0.5°（基准仍 45°）
      break;
    case 'branch': {
      const bump = Math.sin(Math.PI * u); // 0→1→0，首尾无缝
      if (bump > 0.01) s.extra.push({ kind: 'branch', deg: 225, len: 0.42 * bump, w: 1.4 });
      break;
    }
    case 'arm': {
      const bump = Math.sin(Math.PI * u);
      // 臂长上限受画布约束：r0×1.03 + len×r0 + 端帽 ≤ canvas/2（超出会被裁掉，已实测踩坑）
      if (bump > 0.01) s.extra.push({ kind: 'arm', deg: 315, len: 0.2 * bump, w: 1.5 });
      break;
    }
    case 'loop': {
      const bump = Math.sin(Math.PI * u);
      if (bump > 0.01) s.extra.push({ kind: 'loop', deg: 135, frac: bump, w: 1.15 });
      break;
    }
    case 'advance':
      // done = 推进一档，不是闭合。缺口 36 → 27（硬下限 θ_min，永不到 0）
      s.gap = P.theta0 - P.delta * oneShot;
      s.widthScale = 1 + 0.2 * oneShot;
      s.rotate = 5 * oneShot;
      break;
    case 'break':
      s.gap = P.theta0 + 2 * P.delta * oneShot;
      s.dy = 0.03 * 256 * oneShot * (256 / 256);
      s.breakOffset = 0.05 * oneShot;
      s.style = 'break';
      break;
    case 'still':
    default:
      break;
  }
  if (track.style === 'break') s.style = 'break';
  return s;
}

function frameSvg(g, state, ink, canvas) {
  const strokes = buildStrokes(g, state);
  const wAt = (deg) => g.r0 * P.wStartRatio * state.widthScale;
  for (const e of state.extra || []) {
    const base = wAt(e.deg);
    if (e.kind === 'branch') strokes.push(strokeBranch(g, e.deg, e.len, base));
    else if (e.kind === 'arm') strokes.push(strokeArm(g, e.deg, e.len, base));
    else if (e.kind === 'loop') {
      const s = strokeLoop(g, e.deg, base, e.frac);
      if (s) strokes.push(s);
    }
  }
  const ds = strokes.map((s) => ribbon(s.pts, s.ws)).filter(Boolean);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">` +
    ds.map((d) => `<path d="${d}" fill="${ink}" stroke="none"/>`).join('') +
    `</svg>`
  );
}

/* ==========================================================================
 * 6. 主流程
 * ========================================================================== */

function parseArgs(argv) {
  const a = { canvas: P.canvas, out: path.join(__dirname, 'dist', 'agint'), ink: 'cyan' };
  for (const arg of argv.slice(2)) {
    const m = /^--(\w+)=(.*)$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'canvas') a.canvas = Number(m[2]);
    else if (m[1] === 'out') a.out = m[2];
    else if (m[1] === 'ink') a.ink = m[2];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const canvas = args.canvas;
  const ink = args.ink === 'navy' ? P.inkLight : P.inkDark;
  const g = makeGeom(canvas, P);

  fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(args.out, { recursive: true });

  const manifestTracks = {};
  let total = 0;

  // 实证 src/manifest-v2.ts:250 —— dir 不得为 '.' / '..'，必须是真实子目录名
  const FRAMES_DIR = 'frames';

  for (const track of TRACKS) {
    const dir = path.join(args.out, FRAMES_DIR, track.name);
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    const frameMs = [];
    for (let i = 0; i < track.frames; i++) {
      const state = frameState(track, i, track.frames);
      const svg = frameSvg(g, state, ink, canvas);
      const name = `frame-${String(i).padStart(2, '0')}.webp`;
      // 注意：不要给 SVG 输入设 density。sharp 以 72dpi 解释 SVG px，
      // density=96 会整体放大 1.333 倍导致出画（已实测踩坑）。
      await sharp(Buffer.from(svg)).webp({ lossless: true }).toFile(path.join(dir, name));
      frames.push(name);
      frameMs.push(track.ms);
      total++;
    }
    const t = { frames, frameMs, loop: track.loop };
    if (track.fallback) t.fallback = track.fallback;
    manifestTracks[track.name] = t;
  }

  const manifest = {
    petManifestVersion: 2,
    id: 'agint-zhijin',
    displayName: '智进',
    version: '0.1.0',
    description: 'AGINT 桌宠。一条不闭合的单笔环形路径 —— 缺口永不闭合，成功不意味着终结。',
    author: 'AGINT',
    license: 'MIT',
    renderer: 'frames2d',
    frames2d: {
      dir: FRAMES_DIR,
      defaultFrameMs: 200,
      tracks: manifestTracks,
      phases: {
        idle: 'idle',
        waiting: 'waiting',
        thinking: 'thinking',
        tool: 'tool',
        review: 'review',
        done: 'done',
        failed: 'failed',
      },
      skins: [
        { id: 'healthy', label: '健康', idleTrack: 'idle' },
        { id: 'degraded', label: '降级', idleTrack: 'idle-degraded' },
        { id: 'unknown', label: '未读到', idleTrack: 'idle-unknown' },
        { id: 'failed', label: '失败', idleTrack: 'idle-failed' },
      ],
    },
  };

  // 上游 CLI 认的是 pet.json（实证 scripts/dsh-pet.cjs:108）
  fs.writeFileSync(path.join(args.out, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`canvas      : ${canvas}x${canvas}`);
  console.log(`r0          : ${g.r0.toFixed(2)}  w ${(g.r0 * P.wStartRatio).toFixed(2)} -> ${(g.r0 * P.wEndRatio).toFixed(2)}`);
  console.log(`ink         : ${ink} (${args.ink})`);
  console.log(`tracks      : ${TRACKS.length}`);
  console.log(`frames      : ${total}`);
  console.log(`out         : ${args.out}`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
