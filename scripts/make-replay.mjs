#!/usr/bin/env node
// Joins real captures (recordings/capture-*.json, written by the mod) into
// recordings/replay.json for REPLAY mode. Only kinds and relative times are
// kept; nothing is invented — the gaps between sessions are just spacing.
//   node scripts/make-replay.mjs recordings/capture-1-fix-bug.json recordings/capture-2-add-feature.json
import fs from 'node:fs'
import path from 'node:path'
const here = path.dirname(path.dirname(new URL(import.meta.url).pathname))
const files = process.argv.slice(2)
if (!files.length) { console.error('usage: make-replay.mjs <capture.json>...'); process.exit(2) }
const LEAD_IN_MS = 3000, BETWEEN_MS = 3000
let offset = LEAD_IN_MS
const events = [], sessions = []
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'))
  const evs = rec.events.map(e => ({ atMs: e.atMs, kind: String(e.kind) }))
  const start = Math.min(...evs.map(e => e.atMs))
  for (const e of evs) events.push({ atMs: offset + e.atMs - start, kind: e.kind })
  sessions.push({ file: path.basename(f), recordedAt: rec.recordedAt, events: evs.length })
  offset = events.at(-1).atMs + BETWEEN_MS
}
const out = {
  format: 'code-orchestra/recording@1',
  note: 'REPLAY source: real Claude Code CLI events captured by the mod on the bundled sample app (kind + relative time only, no paths or content). Sessions joined in order.',
  sessions,
  events,
}
fs.writeFileSync(path.join(here, 'recordings/replay.json'), JSON.stringify(out, null, 1))
console.log(`wrote recordings/replay.json: ${events.length} events from ${sessions.length} session(s)`)
