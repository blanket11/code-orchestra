// Musical scale helpers for a tiny sample app.
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function noteName(midi) {
  return NOTE_NAMES[midi % 12] + Math.floor(midi / 12)
}

export function majorScale(rootMidi) {
  const steps = [2, 2, 1, 2, 2, 2]
  const out = [rootMidi]
  for (const s of steps) out.push(out[out.length - 1] + s)
  return out
}
