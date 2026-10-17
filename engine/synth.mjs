// CODE ORCHESTRA synth: one polyphonic engine, rendered block by block on a
// single sample clock. Pure JS, no dependencies.

export const SAMPLE_RATE = 48000
const TAU = Math.PI * 2
const MAX_VOICES = 40

const mtof = midi => 440 * Math.pow(2, (midi - 69) / 12)

// Deterministic noise so offline renders are reproducible.
function makeNoise(seed = 0x1234567) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return (s / 0xffffffff) * 2 - 1
  }
}

class OnePole {
  constructor() { this.z = 0 }
  lp(x, a) { this.z += a * (x - this.z); return this.z }
}

const coef = hz => 1 - Math.exp(-TAU * hz / SAMPLE_RATE)

// --- voices -------------------------------------------------------------

function padVoice(midi, vel, durSec, ctx) {
  const f = mtof(midi)
  const det = [0.996, 1, 1.0045]
  const ph = det.map((_, i) => (i * 0.31) % 1)
  const lp = [new OnePole(), new OnePole()]
  const attack = 0.5, release = 1.4
  const total = durSec + release
  const pan = ((midi % 7) / 6) * 0.8 - 0.4
  let t = 0
  return {
    part: 'pad', done: false,
    render(L, R, n) {
      const cutoff = coef(500 + 1600 * ctx.brightness)
      const g = vel * 0.06
      for (let i = 0; i < n; i++) {
        let env
        if (t < attack) env = t / attack
        else if (t < durSec) env = 1
        else env = Math.max(0, 1 - (t - durSec) / release)
        let s = 0
        for (let k = 0; k < 3; k++) {
          ph[k] += f * det[k] / SAMPLE_RATE
          if (ph[k] >= 1) ph[k] -= 1
          // triangle + soft saw mix
          const tri = 1 - 4 * Math.abs(ph[k] - 0.5)
          s += tri * 0.7 + (ph[k] * 2 - 1) * 0.3
        }
        s = lp[1].lp(lp[0].lp(s, cutoff), cutoff) * env * g
        L[i] += s * (1 - pan); R[i] += s * (1 + pan)
        t += 1 / SAMPLE_RATE
      }
      if (t >= total) this.done = true
    },
  }
}

function bassVoice(midi, vel, durSec) {
  const f = mtof(midi)
  let ph = 0, t = 0
  const lp = new OnePole()
  const rel = 0.08
  return {
    part: 'bass', done: false,
    render(L, R, n) {
      for (let i = 0; i < n; i++) {
        ph += f / SAMPLE_RATE; if (ph >= 1) ph -= 1
        const env = Math.min(1, t / 0.004) * (t < durSec ? Math.exp(-t * 2.2) : Math.exp(-durSec * 2.2) * Math.max(0, 1 - (t - durSec) / rel))
        const raw = Math.sin(TAU * ph) + 0.35 * (ph * 2 - 1)
        const s = lp.lp(raw, coef(420 + 900 * env)) * env * vel * 0.32
        L[i] += s; R[i] += s
        t += 1 / SAMPLE_RATE
      }
      if (t >= durSec + rel) this.done = true
    },
  }
}

function leadVoice(midi, vel, durSec, ctx) {
  const f = mtof(midi)
  let ph = 0, ph2 = 0, t = 0
  const lp = new OnePole()
  const len = Math.max(0.25, durSec) + 0.5
  const pan = ((midi % 5) / 4) * 0.6 - 0.3
  return {
    part: 'melody', done: false, send: 0.45,
    render(L, R, n, SL, SR) {
      for (let i = 0; i < n; i++) {
        ph += f / SAMPLE_RATE; if (ph >= 1) ph -= 1
        ph2 += f * 2.003 / SAMPLE_RATE; if (ph2 >= 1) ph2 -= 1
        const env = Math.min(1, t / 0.006) * Math.exp(-t * 4.5)
        const sq = ph < 0.5 ? 1 : -1
        const raw = sq * 0.45 + Math.sin(TAU * ph2) * 0.35 + Math.sin(TAU * ph) * 0.4
        const s = lp.lp(raw, coef(1800 + 3000 * ctx.brightness * env)) * env * vel * 0.13
        L[i] += s * (1 - pan); R[i] += s * (1 + pan)
        SL[i] += s * this.send; SR[i] += s * this.send
        t += 1 / SAMPLE_RATE
      }
      if (t >= len) this.done = true
    },
  }
}

function bellVoice(midi, vel) {
  const f = mtof(midi)
  let pc = 0, pm = 0, t = 0
  const pan = (midi % 2 ? 0.35 : -0.35)
  return {
    part: 'arp', done: false, send: 0.35,
    render(L, R, n, SL, SR) {
      for (let i = 0; i < n; i++) {
        pm += f * 3.5 / SAMPLE_RATE; if (pm >= 1) pm -= 1
        const idx = 2.2 * Math.exp(-t * 9)
        pc += f / SAMPLE_RATE; if (pc >= 1) pc -= 1
        const env = Math.min(1, t / 0.002) * Math.exp(-t * 6)
        const s = Math.sin(TAU * pc + idx * Math.sin(TAU * pm)) * env * vel * 0.07
        L[i] += s * (1 - pan); R[i] += s * (1 + pan)
        SL[i] += s * this.send; SR[i] += s * this.send
        t += 1 / SAMPLE_RATE
      }
      if (t >= 0.9) this.done = true
    },
  }
}

function drumVoice(kind, vel, noise) {
  let t = 0, ph = 0
  const hp = new OnePole(), bp = new OnePole(), bp2 = new OnePole()
  const len = { kick: 0.45, snare: 0.25, hat: 0.07, clap: 0.3, crash: 1.6 }[kind] ?? 0.2
  return {
    part: 'drums', drum: kind, done: false,
    render(L, R, n, SL, SR) {
      for (let i = 0; i < n; i++) {
        let s = 0
        if (kind === 'kick') {
          const f = 45 + 110 * Math.exp(-t * 28)
          ph += f / SAMPLE_RATE
          s = Math.sin(TAU * ph) * Math.exp(-t * 7.5) * 0.85 + (t < 0.003 ? noise() * 0.15 : 0)
        } else if (kind === 'snare') {
          ph += 185 / SAMPLE_RATE
          const nz = noise()
          const hi = nz - hp.lp(nz, coef(1200))
          s = (hi * 0.5 * Math.exp(-t * 16) + Math.sin(TAU * ph) * 0.35 * Math.exp(-t * 25)) * 0.6
          SL[i] += s * 0.25; SR[i] += s * 0.25
        } else if (kind === 'hat') {
          const nz = noise()
          s = (nz - hp.lp(nz, coef(6500))) * Math.exp(-t * 55) * 0.22
        } else if (kind === 'clap') {
          const nz = noise()
          const band = bp2.lp(nz - bp.lp(nz, coef(900)), coef(3000))
          const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 === 0 ? 1 : 0.4) : Math.exp(-(t - 0.03) * 14)
          s = band * burst * 0.55
          SL[i] += s * 0.4; SR[i] += s * 0.4
        } else if (kind === 'crash') {
          const nz = noise()
          s = (nz - hp.lp(nz, coef(4500))) * Math.exp(-t * 2.2) * 0.12
          SL[i] += s * 0.5; SR[i] += s * 0.5
        }
        s *= vel
        const w = kind === 'hat' ? 0.25 : 0
        L[i] += s * (1 - w); R[i] += s * (1 + w)
        t += 1 / SAMPLE_RATE
      }
      if (t >= len) this.done = true
    },
  }
}

// --- engine -------------------------------------------------------------

export function createSynth({ seed = 7 } = {}) {
  const noise = makeNoise(seed)
  const ctx = { brightness: 0.5 }
  let voices = []
  // ping-pong delay (dotted eighth at 112 bpm) + small diffusion reverb
  const dLen = Math.round(SAMPLE_RATE * (60 / 112) * 0.75)
  const dL = new Float32Array(dLen), dR = new Float32Array(dLen)
  let dPos = 0
  const combLens = [1557, 1617, 1491, 1422].map(x => Math.round(x * SAMPLE_RATE / 44100))
  const combs = combLens.map(len => ({ buf: new Float32Array(len), pos: 0, z: 0 }))
  const combsR = combLens.map(len => ({ buf: new Float32Array(len + 23), pos: 0, z: 0 }))
  let gain = 0, targetGain = 0, gainRate = 0
  let duck = 1
  const peak = { value: 0 }

  function trigger(note, durSec = 0.25) {
    const vel = Math.max(0, Math.min(1, note.vel ?? 0.7))
    let v
    if (note.part === 'pad') v = padVoice(note.midi, vel, durSec, ctx)
    else if (note.part === 'bass') v = bassVoice(note.midi, vel, durSec)
    else if (note.part === 'melody') v = leadVoice(note.midi, vel, durSec, ctx)
    else if (note.part === 'arp') v = bellVoice(note.midi, vel)
    else if (note.part === 'drums') { v = drumVoice(note.drum, vel, noise); if (note.drum === 'kick') duck = 0.55 }
    if (!v) return
    // Same pad pitch retriggered: let the old one release quickly.
    voices.push(v)
    if (voices.length > MAX_VOICES) {
      const oldest = voices.findIndex(x => x.part === 'pad') >= 0 && voices.length > MAX_VOICES
        ? voices.findIndex(x => x.part === 'pad') : 0
      voices.splice(oldest, 1)
    }
  }

  function comb(c, x, fb, damp) {
    const out = c.buf[c.pos]
    c.z += damp * (out - c.z)
    c.buf[c.pos] = x + c.z * fb
    c.pos = (c.pos + 1) % c.buf.length
    return out
  }

  // Renders n frames, returns { L, R } Float32Arrays already mastered.
  function render(n) {
    const L = new Float32Array(n), R = new Float32Array(n)
    const SL = new Float32Array(n), SR = new Float32Array(n)
    const padL = new Float32Array(n), padR = new Float32Array(n)
    for (const v of voices) {
      if (v.part === 'pad') v.render(padL, padR, n, SL, SR)
      else v.render(L, R, n, SL, SR)
    }
    voices = voices.filter(v => !v.done)
    for (let i = 0; i < n; i++) {
      // sidechain-ish duck on pad from kick, recovering smoothly
      duck += (1 - duck) * 0.00025
      L[i] += padL[i] * duck; R[i] += padR[i] * duck
      SL[i] += padL[i] * 0.5; SR[i] += padR[i] * 0.5
      // delay
      const yl = dL[dPos], yr = dR[dPos]
      dL[dPos] = SL[i] * 0.6 + yr * 0.38
      dR[dPos] = SR[i] * 0.6 + yl * 0.38
      dPos = (dPos + 1) % dLen
      // reverb
      const inL = SL[i] * 0.3 + yl * 0.2, inR = SR[i] * 0.3 + yr * 0.2
      let rl = 0, rr = 0
      for (let k = 0; k < 4; k++) { rl += comb(combs[k], inL, 0.8, 0.35); rr += comb(combsR[k], inR, 0.8, 0.35) }
      let l = L[i] + yl * 0.45 + rl * 0.18
      let r = R[i] + yr * 0.45 + rr * 0.18
      // master gain ramp
      if (gain !== targetGain) {
        gain += gainRate
        if ((gainRate > 0 && gain > targetGain) || (gainRate < 0 && gain < targetGain)) gain = targetGain
      }
      l = Math.tanh(l * 1.1) * gain
      r = Math.tanh(r * 1.1) * gain
      const a = Math.max(Math.abs(l), Math.abs(r))
      if (a > peak.value) peak.value = a
      L[i] = l; R[i] = r
    }
    return { L, R }
  }

  return {
    trigger,
    render,
    setBrightness(b) { ctx.brightness = Math.max(0, Math.min(1, b)) },
    // Ramp master gain to `value` over `seconds`.
    fadeTo(value, seconds) {
      targetGain = Math.max(0, Math.min(1, value))
      const frames = Math.max(1, Math.round(seconds * SAMPLE_RATE))
      gainRate = (targetGain - gain) / frames
    },
    get gain() { return gain },
    get voiceCount() { return voices.length },
    takePeak() { const p = peak.value; peak.value = 0; return p },
    allOff() { voices = [] },
  }
}

// Interleaved s16le PCM from rendered blocks.
export function toPcm16({ L, R }) {
  const out = Buffer.alloc(L.length * 4)
  for (let i = 0; i < L.length; i++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), i * 4)
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), i * 4 + 2)
  }
  return out
}
