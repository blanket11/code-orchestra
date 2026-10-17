// Integration: the realtime engine as the Mod drives it, with the PCM going
// to a file-writing stand-in for ffplay (nothing is heard).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))
const MAIN = path.join(HERE, 'engine', 'main.mjs')
const SINK = path.join(HERE, 'scripts', 'test-sink.sh')
const RUN = path.join(os.homedir(), '.code-orchestra', 'run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function startEngine(name) {
  const sock = path.join(RUN, `t-${process.pid}-${name}.sock`)
  const pcm = path.join(os.tmpdir(), `co-${process.pid}-${name}.pcm`)
  const child = spawn(process.execPath, [MAIN, '--sock', sock, '--ffplay', SINK], { env: { ...process.env, SINK_OUT: pcm }, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = []
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
  })
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: p, method, headers: { 'content-type': 'application/json' } }, res => {
      let t = ''
      res.on('data', c => { t += c })
      res.on('end', () => resolve(JSON.parse(t)))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
  const waitFor = async (pred, ms = 4000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const hit = lines.find(pred); if (hit) return hit; await sleep(20) }
    throw new Error('timed out; lines: ' + JSON.stringify(lines.slice(-3)))
  }
  const exited = new Promise(r => child.on('exit', r))
  return { child, sock, pcm, lines, call, waitFor, exited }
}

test('engine announces ready, plays, reflects events on the beat, stops and cleans up', async () => {
  const e = startEngine('a')
  const ready = await e.waitFor(l => l.type === 'ready')
  assert.equal(ready.running, false)
  assert.equal((fs.statSync(e.sock).mode & 0o777), 0o600)
  assert.deepEqual(await e.call('POST', '/event', { kind: 'nope' }), { ok: false, error: 'unknown kind' })
  await e.call('POST', '/control', { cmd: 'start' })
  await e.waitFor(l => l.type === 'state' && l.running === true)
  await e.waitFor(l => l.type === 'tick')
  const r = await e.call('POST', '/event', { kind: 'read' })
  assert.equal(r.accepted, true)
  const reflected = await e.waitFor(l => l.type === 'tick' && l.reflected?.some(x => x.kind === 'read'))
  assert.equal(reflected.step % 2, 0, 'a read lands on an eighth-note step')
  assert.ok(reflected.notes.some(n => n.part === 'melody'))
  // a burst of 500 events stays bounded
  await Promise.all(Array.from({ length: 500 }, (_, i) => e.call('POST', '/event', { kind: ['read', 'edit', 'bash'][i % 3] })))
  const st = await e.call('GET', '/state')
  assert.ok(st.snapshot.queueLength <= 32)
  await sleep(600)
  for (const t of e.lines.filter(l => l.type === 'tick')) assert.ok(t.notes.length <= 8)
  await e.call('POST', '/control', { cmd: 'stop' })
  await e.waitFor(l => l.type === 'state' && l.running === false)
  const size = fs.statSync(e.pcm).size
  assert.ok(size > 48000 * 4 * 0.5, `pcm written: ${size}`)
  await e.call('POST', '/control', { cmd: 'quit' })
  await e.exited
  assert.equal(fs.existsSync(e.sock), false, 'socket removed')
  fs.rmSync(e.pcm, { force: true })
})

test('a second engine that starts playing stops the first (one sound at a time)', async () => {
  const a = startEngine('b1'), b = startEngine('b2')
  await a.waitFor(l => l.type === 'ready'); await b.waitFor(l => l.type === 'ready')
  await a.call('POST', '/control', { cmd: 'start' })
  await a.waitFor(l => l.type === 'state' && l.running === true)
  await b.call('POST', '/control', { cmd: 'start' })
  await a.waitFor(l => l.type === 'state' && l.running === false && /another session/.test(l.reason ?? ''))
  await b.call('POST', '/control', { cmd: 'quit' }); await a.call('POST', '/control', { cmd: 'quit' })
  await Promise.all([a.exited, b.exited])
  for (const e of [a, b]) fs.rmSync(e.pcm, { force: true })
})

test('demo mode runs the scripted show and is labelled DEMO', async () => {
  const e = startEngine('c')
  await e.waitFor(l => l.type === 'ready')
  await e.call('POST', '/control', { cmd: 'demo' })
  const t = await e.waitFor(l => l.type === 'tick' && l.mode === 'DEMO')
  assert.equal(typeof t.progress, 'number')
  await e.call('POST', '/control', { cmd: 'quit' })
  await e.exited
  fs.rmSync(e.pcm, { force: true })
})
