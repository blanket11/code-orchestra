#!/usr/bin/env node
// CODE ORCHESTRA realtime engine.
// One process, one sample clock: synthesizes PCM and streams it to a single
// ffplay child. Control arrives over an HTTP server on a Unix socket (mode
// 0600 inside a 0700 directory — no TCP port). Beat ticks go to stdout as JSON
// lines, emitted when the audio for that step is heard, so the Mod's visuals
// follow the sound.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createPerformer } from './performer.mjs'
import { toPcm16, SAMPLE_RATE } from './synth.mjs'
import { EVENT_KINDS } from './conductor.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
  return acc
}, []))

const SOCK = args.sock
if (!SOCK) { console.error('usage: main.mjs --sock <path>'); process.exit(2) }
const FFPLAY = args.ffplay || process.env.CODE_ORCHESTRA_FFPLAY || '/opt/homebrew/bin/ffplay'
const LATENCY_MS = Number(args.latency || process.env.CODE_ORCHESTRA_LATENCY_MS || 140)
const AHEAD_FRAMES = Math.round(SAMPLE_RATE * 0.2)
const BLOCK = 480
const RUN_DIR = path.dirname(SOCK)
const LOCK = path.join(RUN_DIR, 'active.json')

fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
try { fs.chmodSync(RUN_DIR, 0o700) } catch {}

const performer = createPerformer({ seed: 1 })
let volume = Math.max(0, Math.min(1, Number(args.volume || 0.35)))
let running = false
let ffplay = null
let startWall = 0
let written = 0
let pendingTicks = []
let stopTimer = null
let loopTimer = null

function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch { shutdown(0) }
}
process.stdout.on('error', () => shutdown(0))

function stateMsg(extra = {}) {
  return { type: 'state', running, volume, mode: performer.mode, ...extra }
}

// --- single active player across sessions (our own engines only) --------

function isOurEngine(pid) {
  try {
    process.kill(pid, 0)
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return cmd.includes('code-orchestra') && cmd.includes('engine/main.mjs')
  } catch { return false }
}

function claimActive() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
    if (held.pid !== process.pid && held.sock && isOurEngine(held.pid)) {
      const req = http.request({ socketPath: held.sock, path: '/control', method: 'POST', headers: { 'content-type': 'application/json' } })
      req.on('error', () => {})
      req.end(JSON.stringify({ cmd: 'stop', reason: 'another session started playing' }))
    }
  } catch {}
  try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, sock: SOCK }), { mode: 0o600 }) } catch {}
}

function releaseActive() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
    if (held.pid === process.pid) fs.unlinkSync(LOCK)
  } catch {}
}

// --- audio --------------------------------------------------------------

function startAudio() {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
  if (running && ffplay) { performer.fadeTo(volume, 0.4); emit(stateMsg()); return }
  claimActive()
  ffplay = spawn(FFPLAY, [
    '-nodisp', '-autoexit', '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'stereo', '-i', 'pipe:0',
  ], { stdio: ['pipe', 'ignore', 'pipe'] })
  const child = ffplay
  child.stdin.on('error', () => {})
  child.stderr.on('data', d => emit({ type: 'log', text: String(d).slice(0, 300) }))
  child.on('exit', code => {
    if (ffplay === child) {
      ffplay = null
      if (running) { running = false; emit(stateMsg({ error: `audio output ended (${code})` })) }
    }
  })
  child.on('error', err => { emit(stateMsg({ error: `ffplay: ${err.message}` })); running = false; ffplay = null })
  running = true
  startWall = performance.now()
  written = 0
  pendingTicks = []
  performer.fadeTo(volume, 1.5)
  emit(stateMsg())
  if (!loopTimer) loopTimer = setInterval(pump, 5)
}

function stopAudio(reason) {
  if (!running) { emit(stateMsg({ reason })); return }
  performer.fadeTo(0, 0.8)
  if (stopTimer) clearTimeout(stopTimer)
  stopTimer = setTimeout(() => {
    stopTimer = null
    running = false
    const child = ffplay
    ffplay = null
    if (child) {
      try { child.stdin.end() } catch {}
      setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, 400)
    }
    pendingTicks = []
    releaseActive()
    emit(stateMsg({ reason }))
  }, 900)
}

function pump() {
  const now = performance.now()
  if (running && ffplay) {
    const target = ((now - startWall) / 1000) * SAMPLE_RATE + AHEAD_FRAMES
    let guard = 0
    while (written < target && guard++ < 64) {
      const block = performer.render(BLOCK)
      for (const t of block.ticks) {
        t.type = 'tick'
        t.heardAt = startWall + ((written + t.offset) / SAMPLE_RATE) * 1000 + LATENCY_MS
        pendingTicks.push(t)
      }
      try { ffplay.stdin.write(toPcm16(block)) } catch {}
      written += BLOCK
    }
    if (pendingTicks.length > 64) pendingTicks = pendingTicks.slice(-64)
  }
  while (pendingTicks.length && pendingTicks[0].heardAt <= now) {
    const t = pendingTicks.shift()
    delete t.offset; delete t.heardAt
    t.voices = performer.voices
    t.gain = Math.round(performer.gain * 100) / 100
    emit(t)
  }
  if (!running && !stopTimer && loopTimer && pendingTicks.length === 0) { clearInterval(loopTimer); loopTimer = null }
}

// --- control server -----------------------------------------------------

function handle(cmd, body) {
  switch (cmd) {
    case 'start': startAudio(); break
    case 'stop': stopAudio(body.reason); break
    case 'toggle': running && !stopTimer ? stopAudio() : startAudio(); break
    case 'volume':
      volume = Math.max(0, Math.min(1, Number(body.value)))
      if (running && !stopTimer) performer.fadeTo(volume, 0.25)
      emit(stateMsg()); break
    case 'remix': performer.remix(); emit({ type: 'ack', cmd }); break
    case 'demo': performer.startDemo(); if (!running) startAudio(); emit(stateMsg()); break
    case 'replay':
      if (!Array.isArray(body.events) || body.events.length === 0) return { ok: false, error: 'no events' }
      performer.startReplay(body.events.slice(0, 2000)); if (!running) startAudio(); emit(stateMsg()); break
    case 'live': performer.goLive(); emit(stateMsg()); break
    case 'quit': stopAudio('quit'); setTimeout(() => shutdown(0), 1500); break
    default: return { ok: false, error: 'unknown cmd' }
  }
  return { ok: true }
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c; if (raw.length > 512 * 1024) req.destroy() })
  req.on('end', () => {
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch {}
    let out = { ok: false, error: 'not found' }
    if (req.method === 'POST' && req.url === '/event') {
      const kind = String(body.kind || '')
      if (!EVENT_KINDS.includes(kind)) out = { ok: false, error: 'unknown kind' }
      else out = { ok: true, accepted: running && !stopTimer ? performer.pushLive(kind) : false }
    } else if (req.method === 'POST' && req.url === '/control') {
      out = handle(String(body.cmd || ''), body)
    } else if (req.method === 'GET' && req.url === '/state') {
      out = { ok: true, ...stateMsg(), snapshot: performer.snapshot(), pid: process.pid }
    }
    res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
})

function listen() {
  if (fs.existsSync(SOCK)) {
    // A socket left by a crashed engine; refuse to steal a live one.
    const probe = http.request({ socketPath: SOCK, path: '/state' }, () => { console.error('socket in use'); process.exit(3) })
    probe.on('error', () => { try { fs.unlinkSync(SOCK) } catch {}; bind() })
    probe.end()
  } else bind()
}
function bind() {
  server.on('error', err => { emit({ type: 'state', running: false, error: `engine socket: ${err.code || err.message}` }); shutdown(4) })
  server.listen(SOCK, () => {
    try { fs.chmodSync(SOCK, 0o600) } catch {}
    emit({ ...stateMsg(), type: 'ready', pid: process.pid, sock: SOCK })
  })
}

let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  try { ffplay?.kill('SIGTERM') } catch {}
  try { server.close() } catch {}
  try { fs.unlinkSync(SOCK) } catch {}
  releaseActive()
  process.exit(code)
}
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
process.on('SIGHUP', () => shutdown(0))
// Orphan watchdog: the Mod's spawn loop is our parent; if it is gone, so are we.
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent || process.ppid === 1) shutdown(0) }, 1000).unref()

void os
listen()
