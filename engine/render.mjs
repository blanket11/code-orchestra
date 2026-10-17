#!/usr/bin/env node
// Offline render + mechanical audio check. No sound is played.
//   node engine/render.mjs --script demo --out work/demo.wav [--seconds 60]
//   node engine/render.mjs --script replay --events recordings/replay.json --out work/replay.wav
//   node engine/render.mjs --script idle --seconds 20 --out work/idle.wav
// Prints a JSON report: length, peak, clipping, silent spans, kick-onset alignment.

import fs from 'node:fs'
import path from 'node:path'
import { createPerformer, SAMPLES_PER_STEP } from './performer.mjs'
import { SAMPLE_RATE } from './synth.mjs'

const argv = process.argv.slice(2)
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined }
const script = opt('script') || 'demo'
const seconds = Number(opt('seconds') || 60)
const out = opt('out')
const volume = Number(opt('volume') || 0.35)

export function renderOffline({ script, seconds, events, volume = 0.35, flood = 0 }) {
  const p = createPerformer({ seed: 1 })
  if (script === 'demo') p.startDemo()
  else if (script === 'replay') p.startReplay(events)
  p.fadeTo(volume, 1.5)
  const total = Math.round(seconds * SAMPLE_RATE)
  const L = new Float32Array(total), R = new Float32Array(total)
  const ticks = []
  const block = 480
  for (let pos = 0; pos < total; pos += block) {
    if (flood && pos % (SAMPLE_RATE / 10) < block) for (let i = 0; i < flood; i++) p.pushLive(['read', 'edit', 'bash', 'search'][i % 4])
    const n = Math.min(block, total - pos)
    const b = p.render(n)
    L.set(b.L, pos); R.set(b.R, pos)
    for (const t of b.ticks) ticks.push({ ...t, sample: pos + t.offset })
  }
  return { L, R, ticks, performer: p }
}

export function analyze({ L, R, ticks }) {
  const n = L.length
  let peak = 0, clipped = 0
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]))
    if (a > peak) peak = a
    if (a >= 0.999) clipped++
  }
  // RMS per 250 ms window; silent if below -60 dBFS (after the 1.5 s fade-in)
  const win = SAMPLE_RATE / 4
  const rms = []
  for (let s = 0; s + win <= n; s += win) {
    let acc = 0
    for (let i = s; i < s + win; i++) acc += L[i] * L[i] + R[i] * R[i]
    rms.push(Math.sqrt(acc / (2 * win)))
  }
  const silentWindows = rms.map((v, i) => ({ v, t: i * 0.25 })).filter(x => x.t >= 1.5 && x.v < 0.001).map(x => x.t)
  // kick onsets: energy right after the step boundary vs right before
  let kicks = 0, aligned = 0
  const w = Math.round(SAMPLE_RATE * 0.008)
  const energy = (a, b) => { let e = 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++) e += L[i] * L[i]; return e / Math.max(1, b - a) }
  for (const t of ticks) {
    if (!t.notes.some(x => x.drum === 'kick') || t.sample < SAMPLE_RATE * 2) continue
    kicks++
    const before = energy(t.sample - w, t.sample), after = energy(t.sample, t.sample + w)
    if (after > before * 1.5) aligned++
  }
  const stepsOnGrid = ticks.every(t => t.sample % SAMPLES_PER_STEP === 0)
  const modes = [...new Set(ticks.map(t => t.mode))]
  const remixes = [...new Set(ticks.map(t => t.remix))]
  const maxNotes = Math.max(0, ...ticks.map(t => t.notes.length))
  return {
    seconds: n / SAMPLE_RATE,
    peak: Math.round(peak * 1000) / 1000,
    peakDbfs: Math.round(20 * Math.log10(peak || 1e-9) * 10) / 10,
    clippedSamples: clipped,
    meanRms: Math.round((rms.reduce((a, b) => a + b, 0) / Math.max(1, rms.length)) * 10000) / 10000,
    silentWindowsAfterFadeIn: silentWindows.length,
    steps: ticks.length,
    stepsOnGrid,
    kicks, kicksWithOnset: aligned,
    maxNotesPerStep: maxNotes,
    modesSeen: modes, remixesSeen: remixes,
    lifts: ticks.filter(t => t.fx?.lift && t.step === 0).length,
    reflectedEvents: ticks.reduce((a, t) => a + (t.reflected?.length || 0), 0),
  }
}

export function writeWav(file, { L, R }) {
  const n = L.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24); buf.writeUInt32LE(SAMPLE_RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const events = script === 'replay' ? JSON.parse(fs.readFileSync(opt('events'), 'utf8')).events : undefined
  const flood = Number(opt('flood') || 0)
  const r = renderOffline({ script, seconds, events, volume, flood })
  if (out) writeWav(out, r)
  console.log(JSON.stringify({ script, out: out ?? null, ...analyze(r) }, null, 2))
}
