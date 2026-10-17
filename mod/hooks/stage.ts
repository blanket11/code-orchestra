// The live stage: a procedural light show drawn into a Raster
// (one cell = two pixels, `▀` with fg = top pixel, bg = bottom pixel).
// Everything is driven by the engine's step ticks, which arrive when the
// audio for that step is heard.

import type { Layers } from '../types'

export type Tick = {
  bar: number
  step: number
  chord?: string
  remix?: number
  remixName?: string
  mood?: string
  energy?: number
  layers?: Layers
  notes?: { part: string; midi?: number; drum?: string; vel: number }[]
  reflected?: { kind: string; count: number }[]
  fx?: { lift?: boolean; shadow?: boolean }
  mode?: string
  progress?: number | null
}

type P = { x: number; y: number; h: number; life: number; v: number }

export type Viz = {
  step: number
  energy: number
  hue: number
  hueTarget: number
  layers: Layers
  stars: P[]
  sparks: P[]
  hats: P[]
  confetti: P[]
  kick: number
  snare: number
  bass: number
  pad: number
  lift: number
  shadow: number
  seed: number
  running: boolean
}

const CAP = { stars: 60, sparks: 60, hats: 30, confetti: 48 }
const PLAYHEAD = 0.78

const CHORD_HUE: Record<string, number> = {
  Fmaj7: 195, G6: 265, Em7: 320, Am9: 28, 'C(add9)': 165, Cadd9: 165,
}

export function createViz(): Viz {
  return {
    step: 0, energy: 0, hue: 200, hueTarget: 200,
    layers: { pad: 0.35, drums: 0, bass: 0, melody: 0, arp: 0 },
    stars: [], sparks: [], hats: [], confetti: [],
    kick: 0, snare: 0, bass: 0, pad: 0, lift: 0, shadow: 0, seed: 1, running: false,
  }
}

function rnd(viz: Viz): number {
  viz.seed = (viz.seed * 1103515245 + 12345) & 0x7fffffff
  return viz.seed / 0x7fffffff
}

function push(list: P[], p: P, cap: number) {
  list.push(p)
  if (list.length > cap) list.splice(0, list.length - cap)
}

function chordHue(name: string | undefined): number {
  if (!name) return 200
  if (CHORD_HUE[name] !== undefined) return CHORD_HUE[name]
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** Feeds one heard step into the stage. */
export function onTick(viz: Viz, t: Tick): void {
  viz.step = t.step
  viz.energy = t.energy ?? viz.energy
  if (t.layers) viz.layers = t.layers
  viz.hueTarget = chordHue(t.chord)
  if (t.fx?.lift && t.step === 0) {
    viz.lift = 1
    for (let i = 0; i < 24; i++) {
      push(viz.confetti, { x: rnd(viz), y: rnd(viz) * 0.2, h: rnd(viz) * 360, life: 1, v: 0.2 + rnd(viz) * 0.5 }, CAP.confetti)
    }
  }
  if (t.fx?.shadow && t.step === 0) viz.shadow = 1
  for (const n of t.notes ?? []) {
    if (n.part === 'melody' && n.midi !== undefined) {
      const y = Math.max(0.08, Math.min(0.72, 1 - (n.midi - 68) / 28))
      push(viz.stars, { x: PLAYHEAD, y, h: (viz.hueTarget + (n.midi % 12) * 18) % 360, life: 0.6 + n.vel * 0.4, v: 0.16 }, CAP.stars)
    } else if (n.part === 'arp') {
      push(viz.sparks, { x: PLAYHEAD + (rnd(viz) - 0.3) * 0.25, y: 0.1 + rnd(viz) * 0.55, h: (viz.hueTarget + 60) % 360, life: 0.5 + n.vel * 0.5, v: 0.05 }, CAP.sparks)
    } else if (n.part === 'bass') {
      viz.bass = Math.max(viz.bass, 0.4 + n.vel * 0.6)
    } else if (n.part === 'pad') {
      viz.pad = 1
    } else if (n.part === 'drums') {
      if (n.drum === 'kick') viz.kick = Math.max(viz.kick, n.vel)
      else if (n.drum === 'snare' || n.drum === 'clap') viz.snare = Math.max(viz.snare, n.vel)
      else if (n.drum === 'hat') push(viz.hats, { x: PLAYHEAD, y: 0.03, h: 0, life: n.vel, v: 0.16 }, CAP.hats)
      else if (n.drum === 'crash') viz.lift = Math.max(viz.lift, 0.6)
    }
  }
}

/** Moves and decays everything by `dtMs`. */
export function advance(viz: Viz, dtMs: number): void {
  const dt = Math.max(0, Math.min(250, dtMs)) / 1000
  const decay = (v: number, tau: number) => v * Math.exp(-dt / tau)
  viz.kick = decay(viz.kick, 0.12)
  viz.snare = decay(viz.snare, 0.09)
  viz.bass = decay(viz.bass, 0.35)
  viz.pad = decay(viz.pad, 1.4)
  viz.lift = decay(viz.lift, 0.9)
  viz.shadow = decay(viz.shadow, 1.6)
  let dh = ((viz.hueTarget - viz.hue + 540) % 360) - 180
  viz.hue = (viz.hue + dh * Math.min(1, dt * 2.5) + 360) % 360
  const move = (list: P[], lifeTau: number) => {
    for (const p of list) { p.x -= p.v * dt; p.life -= dt / lifeTau }
    return list.filter(p => p.x > -0.05 && p.life > 0)
  }
  viz.stars = move(viz.stars, 4.5)
  viz.sparks = move(viz.sparks, 0.9)
  viz.hats = move(viz.hats, 0.6)
  for (const c of viz.confetti) c.y += c.v * dt * 0.6
  viz.confetti = move(viz.confetti, 1.6).filter(c => c.y < 1)
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m]
}

/** Draws the stage into Raster cells (`columns * rows` u32 triplets). */
export function draw(viz: Viz, columns: number, rows: number, tMs: number): Uint32Array {
  const W = columns, H = rows * 2
  const R = new Float32Array(W * H), G = new Float32Array(W * H), B = new Float32Array(W * H)
  const add = (x: number, y: number, [r, g, b]: [number, number, number], a: number) => {
    const xi = Math.round(x), yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= W || yi >= H || a <= 0) return
    const i = yi * W + xi
    R[i] = R[i]! + r * a; G[i] = G[i]! + g * a; B[i] = B[i]! + b * a
  }
  const live = viz.running ? 1 : 0.35
  const dim = 1 - viz.shadow * 0.35
  const t = tMs / 1000

  // night sky with a kick flash
  const flash = hsv(viz.hue, 0.6, 1)
  for (let y = 0; y < H; y++) {
    const k = y / Math.max(1, H - 1)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      R[i] = 0.03 + 0.03 * k + flash[0] * viz.kick * 0.13 * (1 - k * 0.5)
      G[i] = 0.035 + 0.01 * k + flash[1] * viz.kick * 0.13 * (1 - k * 0.5)
      B[i] = 0.09 + 0.05 * k + flash[2] * viz.kick * 0.13 * (1 - k * 0.5)
    }
  }

  // aurora ribbons in the chord's color: the pad
  const padA = (0.25 + viz.layers.pad * 0.45 + viz.pad * 0.3) * live
  for (let ribbon = 0; ribbon < 2; ribbon++) {
    const col = hsv(viz.hue + ribbon * 45, 0.75, 1)
    const base = H * (0.3 + ribbon * 0.2)
    const amp = H * (0.1 + 0.04 * ribbon)
    const sigma = 0.9 + H * 0.035 + viz.pad * 0.9
    for (let x = 0; x < W; x++) {
      const cy = base + Math.sin(x * 0.07 + t * (0.5 + ribbon * 0.3) + ribbon * 2) * amp + Math.sin(x * 0.19 - t * 0.9) * amp * 0.25
      for (let y = Math.max(0, Math.floor(cy - sigma * 3)); y < Math.min(H, Math.ceil(cy + sigma * 3)); y++) {
        const d = (y - cy) / sigma
        add(x, y, col, Math.exp(-d * d / 2) * padA * 0.62 * dim)
      }
    }
  }

  // bass: a breathing wave from the floor
  const bassCol = hsv(viz.hue + 180, 0.7, 1)
  const bassH = (viz.bass * 0.32 + viz.layers.bass * 0.05) * H * live
  for (let x = 0; x < W; x++) {
    const h = bassH * (0.65 + 0.35 * Math.sin(x * 0.23 - t * 6))
    for (let y = H - 2; y > Math.max(-1, H - 2 - h); y--) {
      const k = (H - 2 - y) / Math.max(1, h)
      add(x, y, bassCol, (1 - k) * Math.min(1, h) * 0.75 * dim)
    }
  }

  // playhead and snare shimmer
  const px = Math.round(W * PLAYHEAD)
  for (let y = 0; y < H; y++) {
    add(px, y, [0.6, 0.7, 1], (0.08 + viz.snare * 0.6) * live)
    if (viz.snare > 0.05) { add(px - 1, y, [0.6, 0.7, 1], viz.snare * 0.3); add(px + 1, y, [0.6, 0.7, 1], viz.snare * 0.3) }
  }

  // hats along the sky line
  for (const p of viz.hats) add(p.x * W, p.y * H, [0.8, 0.9, 1], p.life * 0.7)

  // melody stars: a white-hot head, a colored glow and a long light trail
  for (const s of viz.stars) {
    const col = hsv(s.h, 0.6, 1)
    const sx = s.x * W, sy = s.y * H
    const fresh = Math.max(0, Math.min(1, (PLAYHEAD - s.x) * -8 + 1)) // flare right at the playhead
    for (let k = 1; k < 16; k++) add(sx + k, sy, col, s.life * (1 - k / 16) * 0.7)
    add(sx, sy, [1, 1, 1], s.life * 1.2)
    add(sx - 1, sy, col, s.life * 0.8)
    add(sx, sy - 1, col, s.life * (0.6 + fresh * 0.6))
    add(sx, sy + 1, col, s.life * (0.6 + fresh * 0.6))
    if (fresh > 0.2) { add(sx, sy - 2, col, fresh * 0.4); add(sx, sy + 2, col, fresh * 0.4); add(sx - 2, sy, col, fresh * 0.4) }
  }

  // arp twinkles
  for (const p of viz.sparks) {
    const col = hsv(p.h, 0.4, 1)
    const tw = 0.6 + 0.4 * Math.sin(t * 20 + p.y * 50)
    add(p.x * W, p.y * H, col, p.life * tw)
  }

  // lift confetti
  for (const c of viz.confetti) add(c.x * W, c.y * H, hsv(c.h, 0.8, 1), c.life)
  if (viz.lift > 0.02) {
    for (let x = 0; x < W; x++) add(x, 0, hsv(viz.hue + x * 4, 0.6, 1), viz.lift * 0.5)
  }

  // step lights on the floor (their own row, painted over everything)
  for (let x = 0; x < W; x++) { const i = (H - 1) * W + x; R[i] = 0.02; G[i] = 0.02; B[i] = 0.05 }
  for (let s = 0; s < 16; s++) {
    const x0 = Math.floor((s / 16) * W) + 1, x1 = Math.floor(((s + 1) / 16) * W) - 1
    const isNow = viz.running && s === viz.step
    const col: [number, number, number] = isNow ? [1, 1, 1] : s % 4 === 0 ? hsv(viz.hue, 0.5, 0.55) : [0.16, 0.17, 0.26]
    for (let x = x0; x < Math.max(x0 + 1, x1); x++) {
      const i = (H - 1) * W + x
      R[i] = col[0]; G[i] = col[1]; B[i] = col[2]
    }
  }

  // pack two pixels per cell
  const out = new Uint32Array(W * rows * 3)
  const pack = (i: number) => {
    const q = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255))) & 0xf8
    return (q(R[i]!) << 16) | (q(G[i]!) << 8) | q(B[i]!)
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < W; c++) {
      const o = (r * W + c) * 3
      out[o] = 0x2580
      out[o + 1] = pack(2 * r * W + c)
      out[o + 2] = pack((2 * r + 1) * W + c)
    }
  }
  return out
}

export function toCells(words: Uint32Array): string {
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}
