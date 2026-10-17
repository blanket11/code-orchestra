export const STEPS_PER_BAR = 16;
export const BPM = 112;
export const EVENT_KINDS = Object.freeze([
  'read', 'search', 'edit', 'write', 'bash', 'test_pass', 'test_fail',
  'error', 'prompt', 'agent', 'turn_end',
]);

const KNOWN_KINDS = new Set(EVENT_KINDS);
const MELODY_KINDS = new Set(['read', 'search', 'agent']);
const BAR_KINDS = new Set([
  'edit', 'write', 'test_pass', 'test_fail', 'error', 'prompt', 'turn_end',
]);
const BASH_KINDS = new Set(['bash']);
const MAX_QUEUE = 32;
const PENTATONIC = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93];
const CHORDS = {
  Fmaj7: { name: 'Fmaj7', root: 29, tones: [53, 57, 60, 64] },
  G6: { name: 'G6', root: 31, tones: [55, 59, 62, 64] },
  Em7: { name: 'Em7', root: 28, tones: [52, 55, 59, 62] },
  Am9: { name: 'Am9', root: 33, tones: [57, 60, 64, 67, 71] },
  'C(add9)': { name: 'C(add9)', root: 36, tones: [48, 55, 60, 62, 64] },
};
const PROG_A = ['Fmaj7', 'G6', 'Em7', 'Am9'];
const PROG_B = ['Am9', 'Fmaj7', 'C(add9)', 'G6'];
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const cloneChord = (chord) => ({ ...chord, tones: [...chord.tones] });

// Mulberry32: all entropy belongs to the instance and is restored by reset().
function createRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A step-driven conductor. The caller owns the clock (60_000 / bpm / 4 ms).
 * atMs is receipt metadata; call order, rather than a wall clock, determines
 * eligibility. snapshot().step is -1 until the first advanceStep().
 */
export function createConductor(options = {}) {
  const initialSeed = Number.isFinite(options.seed) ? options.seed >>> 0 : 1;
  let random, queue, bar, step, remix, pendingRemix, baseEnergy, layers;
  let lift, shadow, lastMelody, melodyDir = 1, melodyCount, totalEvents, countsByKind, chord;

  function reset() {
    random = createRandom(initialSeed);
    queue = [];
    bar = 0;
    step = -1;
    remix = 0;
    pendingRemix = null;
    baseEnergy = 0.15;
    layers = { pad: 0.55, drums: 0, bass: 0, melody: 0, arp: 0 };
    lift = false;
    shadow = false;
    lastMelody = 76;
    melodyCount = 0;
    melodyDir = 1;
    totalEvents = 0;
    countsByKind = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0]));
    chord = cloneChord(CHORDS.Fmaj7);
  }

  function pushEvent(kind, atMs) {
    if (!KNOWN_KINDS.has(kind)) return false;
    totalEvents += 1;
    countsByKind[kind] += 1;
    const event = { kind, atMs: Number.isFinite(atMs) ? atMs : 0, count: 1 };
    if (queue.length < MAX_QUEUE) {
      queue.push(event);
      return true;
    }

    // Compact only on overflow, preserving each kind's first position.
    // Counts for melodic events are still consumed one note at a time.
    const compacted = [];
    const byKind = new Map();
    for (const entry of [...queue, event]) {
      const existing = byKind.get(entry.kind);
      if (existing) existing.count += entry.count;
      else {
        const copy = { ...entry };
        byKind.set(entry.kind, copy);
        compacted.push(copy);
      }
    }
    queue = compacted.slice(-MAX_QUEUE);
    return true;
  }

  function takeAll(kinds) {
    const taken = [];
    const remaining = [];
    for (const entry of queue) {
      if (kinds.has(entry.kind)) taken.push(entry);
      else remaining.push(entry);
    }
    queue = remaining;
    return taken;
  }

  function takeMelody() {
    const index = queue.findIndex((entry) => MELODY_KINDS.has(entry.kind));
    if (index < 0) return null;
    const event = { kind: queue[index].kind, count: 1 };
    queue[index].count -= 1;
    if (queue[index].count === 0) queue.splice(index, 1);
    return event;
  }

  function energy() {
    // Lift is a one-bar addition, never accumulated into persistent energy.
    return clamp(baseEnergy + (lift ? 0.3 : 0));
  }

  function mood() {
    if (shadow) return 'shadow';
    if (lift || energy() >= 0.7) return 'lift';
    if (energy() >= 0.2 || layers.drums >= 0.15 || layers.pad >= 0.8) return 'groove';
    return 'calm';
  }

  function beginBar() {
    if (pendingRemix !== null) remix = pendingRemix;
    pendingRemix = null;
    lift = false;
    shadow = false;
    melodyCount = 0;
    baseEnergy *= 0.85;
    for (const part of Object.keys(layers)) layers[part] *= 0.85;
    layers.pad = Math.max(0.35, layers.pad);

    const events = takeAll(BAR_KINDS);
    for (const { kind, count } of events) {
      switch (kind) {
        case 'edit':
        case 'write':
          layers.drums = clamp(layers.drums + 0.3 * count);
          layers.bass = clamp(layers.bass + 0.25 * count);
          baseEnergy = clamp(baseEnergy + 0.12 * count);
          break;
        case 'test_pass':
          lift = true;
          break;
        case 'test_fail':
        case 'error':
          shadow = true;
          break;
        case 'prompt':
          layers.pad = 1;
          baseEnergy = clamp(baseEnergy + 0.1 * count);
          break;
        case 'turn_end':
          baseEnergy = clamp(baseEnergy - 0.15 * count);
          break;
      }
    }
    const progression = remix === 3 ? PROG_B : PROG_A;
    // Diatonic minor substitutes keep failures musical, with no alert tones.
    const chordName = shadow ? (bar % 2 === 0 ? 'Am9' : 'Em7') : progression[bar % 4];
    chord = cloneChord(CHORDS[chordName]);
    return events;
  }

  function chooseMelody(kind) {
    const maxLeap = random() < 0.08 ? 7 : 5;
    let candidates = PENTATONIC.filter((midi) => Math.abs(midi - lastMelody) <= maxLeap);
    if (step % 4 === 0) {
      const chordCandidates = candidates.filter((midi) =>
        chord.tones.some((tone) => tone % 12 === midi % 12));
      if (chordCandidates.length) candidates = chordCandidates;
    }
    // Phrase contour: drift in one direction, turn at the edges or now and then.
    if (lastMelody >= 84) melodyDir = -1;
    else if (lastMelody <= 74) melodyDir = 1;
    else if (random() < 0.22) melodyDir = -melodyDir;
    if (kind === 'search') melodyDir = 1;
    const directed = candidates.filter((midi) => (midi - lastMelody) * melodyDir > 0);
    if (directed.length && random() < 0.8) candidates = directed;
    else if (candidates.length > 1 && random() < 0.7) candidates = candidates.filter((midi) => midi !== lastMelody);
    // Prefer small steps: pick among the nearest few.
    candidates = candidates.slice().sort((a, b) => Math.abs(a - lastMelody) - Math.abs(b - lastMelody));
    const index = Math.floor(random() * Math.min(candidates.length, 2));
    lastMelody = candidates[index];
    return lastMelody;
  }

  function arpPitch() {
    const span = chord.tones.length * 2 - 2;
    const position = (bar * STEPS_PER_BAR + step) % span;
    const index = position < chord.tones.length ? position : span - position;
    return chord.tones[index] + 12;
  }

  function drumHits() {
    const hits = [];
    const strength = layers.drums;
    const high = strength >= 0.65;
    const medium = strength >= 0.15;
    const kicks = remix === 1 ? [0, 11] : high ? [0, 6, 8, 10] : medium ? [0, 8, 10] : [0, 8];
    if (kicks.includes(step) && (!shadow || step === 0)) {
      hits.push({ drum: 'kick', vel: 0.22 + strength * 0.6 });
    }
    if (medium && (remix === 1 ? step === 8 : step === 4 || step === 12)) {
      hits.push({ drum: 'snare', vel: 0.25 + strength * 0.45 });
    }
    if (high && remix !== 1 && step === 12) hits.push({ drum: 'clap', vel: 0.4 });
    if (high || step % 2 === 0) {
      hits.push({ drum: 'hat', vel: 0.07 + strength * (step % 2 === 0 ? 0.22 : 0.1) });
    }
    return hits;
  }

  function advanceStep() {
    step += 1;
    if (step === STEPS_PER_BAR) {
      step = 0;
      bar += 1;
    }
    const reflected = [];
    const reflect = ({ kind, count }) => {
      const existing = reflected.find((event) => event.kind === kind);
      if (existing) existing.count += count;
      else reflected.push({ kind, count });
    };
    if (step === 0) beginBar().forEach(reflect);

    const bashEvents = step % 4 === 0 ? takeAll(BASH_KINDS) : [];
    for (const event of bashEvents) {
      layers.arp = clamp(layers.arp + 0.3 * event.count);
      reflect(event);
    }
    const melodicEvent = step % 2 === 0 && melodyCount < 8 ? takeMelody() : null;
    if (melodicEvent) {
      layers.melody = clamp(layers.melody + 0.25);
      melodyCount += 1;
      reflect(melodicEvent);
    }

    const notes = [];
    const add = (note) => {
      if (notes.length >= 8) return;
      notes.push({ ...note, vel: clamp(note.vel * (shadow ? 0.72 : 1)), dur: Math.max(1, note.dur) });
    };
    if (step === 0) {
      // Three voices reserve room for melody, bass, arp, crash and kick even
      // when every event family lands together. chord.tones retains the full
      // voicing for the synth/UI. Keep the root, third and highest extension.
      const voices = [chord.tones[0], chord.tones[1], chord.tones.at(-1)];
      for (let midi of voices) {
        if (lift && midi < 60) midi += 12;
        add({ part: 'pad', midi, vel: 0.2 + layers.pad * 0.3 + (lift ? 0.06 : 0), dur: 16 });
      }
    }
    let melodyMidi;
    if (melodicEvent) {
      melodyMidi = chooseMelody(melodicEvent.kind);
      add({ part: 'melody', midi: melodyMidi, vel: 0.35 + layers.melody * 0.4 + random() * 0.06, dur: 2 });
    }
    const shouldArp = bashEvents.length > 0 || remix === 2 ||
      (layers.arp > 0.05 && step % (layers.arp >= 0.65 ? 2 : 4) === 0);
    if (melodicEvent?.kind === 'agent') {
      const harmony = PENTATONIC.filter((midi) => midi !== melodyMidi &&
        Math.abs(midi - melodyMidi) <= 7 && chord.tones.some((tone) => tone % 12 === midi % 12));
      const midi = harmony.sort((a, b) => Math.abs(a - melodyMidi) - Math.abs(b - melodyMidi))[0] ?? arpPitch();
      add({ part: 'arp', midi, vel: 0.32 + layers.arp * 0.3, dur: 2 });
    } else if (!melodicEvent && layers.melody > 0.2 && step % 4 === 2 && random() < layers.melody * 0.6) {
      // Call and response: the bell answers the last melody note a chord tone below.
      const answer = PENTATONIC.filter((midi) => midi < lastMelody && lastMelody - midi <= 9 &&
        chord.tones.some((tone) => tone % 12 === midi % 12));
      add({ part: 'arp', midi: answer.at(-1) ?? arpPitch(), vel: 0.18 + layers.melody * 0.25, dur: 2 });
    } else if (shouldArp) {
      add({ part: 'arp', midi: arpPitch(), vel: 0.16 + layers.arp * 0.45, dur: 1 });
    }

    const bassSteps = layers.bass >= 0.65 ? [0, 3, 6, 8, 11, 14] : layers.bass >= 0.3 ? [0, 8] : [0];
    if (layers.bass > 0.05 && (remix === 3 ? step % 2 === 0 : bassSteps.includes(step))) {
      // Roots stay in MIDI 28..43; Night Drive alternates their upper octave.
      const octave = remix === 3 && step % 4 === 2 ? 12 : 0;
      add({ part: 'bass', midi: chord.root + octave, vel: 0.3 + layers.bass * 0.45, dur: remix === 3 ? 1 : 2 });
    }
    if (step === 0 && lift) add({ part: 'drums', drum: 'crash', vel: 0.75, dur: 4 });
    for (const hit of drumHits()) add({ part: 'drums', ...hit, dur: 1 });

    return {
      bar, step, isBarStart: step === 0, chord: cloneChord(chord), remix,
      layers: { ...layers }, energy: energy(), mood: mood(), notes, reflected,
      fx: { lift, shadow },
    };
  }

  function snapshot() {
    return {
      bar, step, remix, pendingRemix, energy: energy(), layers: { ...layers },
      mood: mood(), queueLength: queue.length, totalEvents, countsByKind: { ...countsByKind },
    };
  }

  reset();
  return {
    pushEvent,
    requestRemix() { pendingRemix = (remix + 1) % 4; },
    setRemix(n) { pendingRemix = Number.isFinite(n) ? clamp(Math.trunc(n), 0, 3) : 0; },
    reset,
    advanceStep,
    snapshot,
  };
}
