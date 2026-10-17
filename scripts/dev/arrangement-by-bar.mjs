import { renderOffline } from '../../engine/render.mjs'
const r = renderOffline({ script: 'demo', seconds: 62 })
const bars = {}
for (const t of r.ticks) {
  const b = bars[t.bar] ??= { chord: t.chord, remix: t.remix, mood: t.mood, e: t.energy, mode: t.mode, c: {}, mel: [], fx: '' }
  for (const n of t.notes) { const k = n.drum ?? n.part; b.c[k] = (b.c[k] ?? 0) + 1; if (n.part === 'melody') b.mel.push(n.midi) }
  if (t.fx?.lift) b.fx = 'LIFT'; if (t.fx?.shadow) b.fx = 'SHADOW'
}
for (const [k, b] of Object.entries(bars)) console.log(k.padStart(2), b.mode, b.chord.padEnd(8), 'rx' + b.remix, b.mood.padEnd(6), b.e.toFixed(2), b.fx.padEnd(6), JSON.stringify(b.c), b.mel.join(','))
