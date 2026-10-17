// Ties the conductor (arrangement) to the synth on one sample clock.
// Used by the realtime engine (main.mjs) and the offline renderer alike.

import { createConductor, BPM, STEPS_PER_BAR } from './conductor.mjs'
import { compressTimeline, buildDemoScript, createPlayer } from './timeline.mjs'
import { createSynth, SAMPLE_RATE } from './synth.mjs'

export const SAMPLES_PER_STEP = Math.round(SAMPLE_RATE * 60 / BPM / 4)
export const STEP_MS = (SAMPLES_PER_STEP / SAMPLE_RATE) * 1000
const REMIX_NAMES = ['GLOW', 'HALFTIME', 'ARP STORM', 'NIGHT DRIVE']

export function createPerformer({ seed = 1 } = {}) {
  const conductor = createConductor({ seed, bpm: BPM })
  const synth = createSynth({ seed: 7 })
  let sample = 0              // global sample clock
  let toNextStep = 0          // samples until the next step boundary
  let mode = 'LIVE'
  let player = null
  let modeStartSample = 0
  let tailBars = -1           // bars left before a finished script returns to LIVE
  let liveWhileScripted = 0
  let scriptMs = 56000

  function setMode(next, events) {
    conductor.reset()
    synth.allOff()
    mode = next
    player = events ? createPlayer(events) : null
    scriptMs = events && events.length ? events.at(-1).atMs + 2 * 16 * STEP_MS + 1 : 56000
    modeStartSample = sample
    tailBars = -1
  }

  function doStep(ticks, offset) {
    if (player) {
      const elapsed = ((sample + offset - modeStartSample) / SAMPLE_RATE) * 1000
      for (const ev of player.due(elapsed)) {
        if (ev.kind === 'remix') conductor.requestRemix()
        else conductor.pushEvent(ev.kind, elapsed)
      }
    }
    const plan = conductor.advanceStep()
    const stepSec = SAMPLES_PER_STEP / SAMPLE_RATE
    for (const note of plan.notes) synth.trigger(note, (note.dur ?? 1) * stepSec)
    const bright = 0.25 + plan.energy * 0.6 + (plan.fx?.lift ? 0.3 : 0) - (plan.fx?.shadow ? 0.25 : 0)
    synth.setBrightness(bright)

    if (player && plan.isBarStart) {
      const elapsed = ((sample + offset - modeStartSample) / SAMPLE_RATE) * 1000
      if (tailBars < 0 && player.done(elapsed)) tailBars = 2
      else if (tailBars > 0) tailBars--
      else if (tailBars === 0) { player = null; mode = 'LIVE'; tailBars = -1 }
    }
    ticks.push({
      offset,
      bar: plan.bar, step: plan.step,
      chord: plan.chord?.name, remix: plan.remix, remixName: REMIX_NAMES[plan.remix] ?? '',
      mood: plan.mood, energy: plan.energy, layers: plan.layers,
      notes: plan.notes.map(n => n.part === 'drums'
        ? { part: 'drums', drum: n.drum, vel: n.vel }
        : { part: n.part, midi: n.midi, vel: n.vel }),
      reflected: plan.reflected, fx: plan.fx, mode,
      progress: player ? Math.min(1, ((sample + offset - modeStartSample) / SAMPLE_RATE) * 1000 / scriptMs) : null,
    })
  }

  return {
    // Renders `n` frames; returns the audio and the step ticks inside it
    // (`offset` = frame index within this block where the step starts).
    render(n) {
      const ticks = []
      const L = new Float32Array(n), R = new Float32Array(n)
      let done = 0
      while (done < n) {
        if (toNextStep === 0) { doStep(ticks, done); toNextStep = SAMPLES_PER_STEP }
        const chunk = Math.min(n - done, toNextStep)
        const out = synth.render(chunk)
        L.set(out.L, done); R.set(out.R, done)
        done += chunk; toNextStep -= chunk; sample += chunk
      }
      return { L, R, ticks }
    },
    pushLive(kind) {
      if (mode !== 'LIVE') { liveWhileScripted++; return false }
      return conductor.pushEvent(kind, (sample / SAMPLE_RATE) * 1000)
    },
    remix() { conductor.requestRemix() },
    startDemo() { setMode('DEMO', buildDemoScript()) },
    startReplay(events) { setMode('REPLAY', compressTimeline(events, { targetMs: 50000, maxGapMs: 3200 })) },
    goLive() { setMode('LIVE', null) },
    fadeTo: (v, s) => synth.fadeTo(v, s),
    get gain() { return synth.gain },
    get mode() { return mode },
    get sample() { return sample },
    get voices() { return synth.voiceCount },
    takePeak: () => synth.takePeak(),
    snapshot: () => ({ ...conductor.snapshot(), mode, liveWhileScripted }),
    STEPS_PER_BAR,
  }
}
