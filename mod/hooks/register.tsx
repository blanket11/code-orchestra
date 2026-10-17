// CODE ORCHESTRA — Claude Code's live work, played as music in a pane.
//
// Observes tool calls / prompts / turns (never blocks or rewrites them),
// forwards only the event *kind* to a local synth engine (engine/main.mjs,
// over a Unix socket), and draws the engine's heard beat ticks as a light show.

import { atom, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { OrchestraUi } from '../types'
import { KIND_LABEL, kindAtEnd, kindAtStart, type Kind } from './classify'
import { advance, createViz, draw, onTick, toCells, type Tick } from './stage'

type $T = EngineInterface

const PANE = 'code-orchestra'
const TITLE = 'CODE ORCHESTRA'
const FRAME_MS = 66

const INITIAL: OrchestraUi = {
  engine: 'off', running: false, volume: 0.35, mode: 'LIVE',
  remixName: 'GLOW', remixPending: false, bar: 0, beat: 0, chord: '—', mood: 'calm',
  energy: 0, layers: { pad: 0, drums: 0, bass: 0, melody: 0, arp: 0 },
  reflected: [], liveEvents: 0, progress: null, message: '',
}
const ui = atom({ plugin: 'code-orchestra', key: 'ui' } as const, INITIAL)

// Module-level runtime (a hot reload starts these over; the engine child of
// the old module is killed with it, so nothing doubles).
type EngineRef = { sock: string; ready: boolean }
let engine: EngineRef | null = null
let lastEngineError = ''
let frameTimer: { cancel(): void } | null = null
let lastFrameAt = 0
let blitLogged = false
let mounted: { columns: number; rows: number } | null = null
const viz = createViz()
let lastMode = 'LIVE'
let lastRemix = 0
let recording: { startedAt: number; events: { atMs: number; kind: Kind }[] } = { startedAt: 0, events: [] }
let saveTimer: { cancel(): void } | null = null

const patch = ($: $T, p: Partial<OrchestraUi>) => update($, ui, v => ({ ...(v ?? INITIAL), ...p }))

function randomId(): string {
  const b = new Uint8Array(5)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

// --- engine process -----------------------------------------------------

async function post($: $T, path: string, body: unknown): Promise<unknown> {
  const ref = engine
  if (!ref?.ready) return undefined
  const res = await $.http.fetch(`http://orchestra${path}`, {
    method: 'POST', socketPath: ref.sock,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try { return JSON.parse(res.text) } catch { return undefined }
}

async function ensureEngine($: $T): Promise<boolean> {
  if (engine?.ready) return true
  if (!engine) {
    const home = (await $.env.get('HOME')) ?? '/tmp'
    const node = (await $.env.get('CODE_ORCHESTRA_NODE')) || 'node'
    const ffplay = await $.env.get('CODE_ORCHESTRA_FFPLAY')
    const me: EngineRef = { sock: `${home}/.code-orchestra/run/${randomId()}.sock`, ready: false }
    engine = me
    await patch($, { engine: 'starting', message: 'starting engine…' })
    const root = $.plugin.root
    // The engine sits beside the mod: <code-orchestra>/engine/main.mjs (no `..`, so
    // scripts/stop.sh can match the process by its exact path).
    const base = root.replace(/\/+$/, '').replace(/\/mod$/, '')
    const argv = [node, `${base}/engine/main.mjs`, '--sock', me.sock, ...(ffplay ? ['--ffplay', ffplay] : [])]
    void (async () => {
      let buf = ''
      let why = ''
      try {
        for await (const chunk of $.process.spawn({ argv, cwd: root })) {
          if (engine !== me) break
          if (chunk.stream === 'stderr') { why = chunk.text.slice(-200); continue }
          buf += chunk.text
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            onLine($, me, line)
          }
          if (buf.length > 200_000) buf = ''
        }
      } catch (err) {
        why = String(err).slice(0, 200)
      }
      if (why) lastEngineError = why
      if (engine === me) {
        engine = null
        stopFrames()
        void patch($, { engine: why ? 'error' : 'off', running: false, message: why ? `engine stopped: ${why}` : 'engine stopped' }).catch(() => {})
      }
    })()
  }
  for (let i = 0; i < 50 && engine && !engine.ready; i++) await $.clock.sleep(100)
  return engine?.ready === true
}

function onLine($: $T, me: EngineRef, line: string) {
  let msg: Record<string, unknown>
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === 'ready') {
    me.ready = true
    void patch($, { engine: 'ready', message: '' }).catch(() => {})
  } else if (msg.type === 'state') {
    const running = msg.running === true
    viz.running = running
    if (running) startFrames($)
    void patch($, {
      running, volume: Number(msg.volume ?? 0.35), mode: (msg.mode as OrchestraUi['mode']) ?? 'LIVE',
      message: typeof msg.error === 'string' ? msg.error : typeof msg.reason === 'string' ? msg.reason : '',
    }).catch(() => {})
    if (!running) $.clock.after(1200, () => { if (!viz.running) stopFrames() })
  } else if (msg.type === 'tick') {
    const t = msg as unknown as Tick
    onTick(viz, t)
    const reflected = (t.reflected ?? []).map(r => `${KIND_LABEL[r.kind as Kind] ?? r.kind}${r.count > 1 ? ` ×${r.count}` : ''}`)
    const modeChanged = t.mode !== lastMode
    const remixChanged = t.remix !== lastRemix
    lastMode = t.mode ?? lastMode
    lastRemix = t.remix ?? lastRemix
    if (t.step % 4 === 0 || reflected.length || modeChanged || remixChanged) {
      void update($, ui, v => {
        const cur = v ?? INITIAL
        return {
          ...cur,
          bar: t.bar, beat: Math.floor(t.step / 4), chord: t.chord ?? cur.chord,
          remixName: t.remixName ?? cur.remixName, remixPending: remixChanged ? false : cur.remixPending,
          mood: t.mood ?? cur.mood, energy: t.energy ?? cur.energy, layers: t.layers ?? cur.layers,
          mode: (t.mode as OrchestraUi['mode']) ?? cur.mode, progress: t.progress ?? null,
          reflected: reflected.length ? [...reflected.map(r => `bar ${t.bar + 1}.${Math.floor(t.step / 4) + 1}  ${r}`), ...cur.reflected].slice(0, 4) : cur.reflected,
        }
      }).catch(() => {})
    }
  }
}

// --- frames -------------------------------------------------------------

function startFrames($: $T) {
  if (frameTimer) return
  lastFrameAt = Date.now()
  frameTimer = $.clock.every(FRAME_MS, () => {
    const now = Date.now()
    advance(viz, now - lastFrameAt)
    lastFrameAt = now
    const m = mounted
    if (!m) return
    void $.ui.blit({ requestId: PANE, key: 'stage', cells: toCells(draw(viz, m.columns, m.rows, now)) })
      .then(r => {
        const denied = r && 'deny' in r && r.deny ? String(r.deny) : ''
        if (denied) mounted = null
        if (!blitLogged) { blitLogged = true; $.ui.log(denied ? `stage blit refused: ${denied}` : 'stage blit ok', { to: 'debug' }) }
      })
      .catch(err => {
        mounted = null
        if (!blitLogged) { blitLogged = true; $.ui.log(`stage blit failed: ${String(err).slice(0, 120)}`, { to: 'debug' }) }
      })
  })
}

function stopFrames() {
  frameTimer?.cancel()
  frameTimer = null
}

// --- live events --------------------------------------------------------

function emit($: $T, kind: Kind) {
  const now = Date.now()
  if (recording.startedAt === 0) recording.startedAt = now
  recording.events.push({ atMs: now - recording.startedAt, kind })
  if (recording.events.length > 600) recording.events.splice(0, recording.events.length - 600)
  void update($, ui, v => ({ ...(v ?? INITIAL), liveEvents: (v?.liveEvents ?? 0) + 1 })).catch(() => {})
  if (engine?.ready) void post($, '/event', { kind }).catch(() => {})
  scheduleSave($)
}

function scheduleSave($: $T) {
  if (saveTimer) return
  saveTimer = $.clock.after(4000, () => {
    saveTimer = null
    void saveRecording($).catch(() => {})
  })
}

// Kinds and timings only — no paths, commands or file contents.
async function saveRecording($: $T) {
  if (recording.events.length === 0) return
  const file = `${$.plugin.root.replace(/\/+$/, '').replace(/\/mod$/, '')}/recordings/live-latest.json`
  await $.fs.write(file, JSON.stringify({
    format: 'code-orchestra/recording@1',
    note: 'Real Claude Code CLI events captured by the mod (kind + relative time only).',
    recordedAt: new Date(recording.startedAt).toISOString(),
    events: recording.events,
  }, null, 1))
}

// --- controls -----------------------------------------------------------

async function control($: $T, cmd: string, extra: Record<string, unknown> = {}) {
  if (!(await ensureEngine($))) {
    await patch($, { engine: 'error', message: `engine did not start: ${lastEngineError || 'no reply in 5 s'} (see README)` })
    return
  }
  await post($, '/control', { cmd, ...extra })
}

async function toggle($: $T) {
  const { value } = await $.state.get({ plugin: 'code-orchestra', key: 'ui' })
  await control($, value?.running ? 'stop' : 'start')
}

async function replay($: $T) {
  const base = $.plugin.root.replace(/\/+$/, '').replace(/\/mod$/, '')
  let text: string | undefined
  for (const name of ['replay.json', 'live-latest.json']) {
    text = await $.fs.read(`${base}/recordings/${name}`).catch(() => undefined)
    if (text) break
  }
  if (!text) { await patch($, { message: 'no recording yet (recordings/replay.json)' }); return }
  let events: unknown
  try { events = JSON.parse(text).events } catch { events = undefined }
  if (!Array.isArray(events) || events.length === 0) { await patch($, { message: 'recording is empty' }); return }
  await control($, 'replay', { events })
}

async function volume($: $T, delta: number) {
  const { value } = await $.state.get({ plugin: 'code-orchestra', key: 'ui' })
  const v = Math.round(Math.max(0, Math.min(1, (value?.volume ?? 0.35) + delta)) * 100) / 100
  await patch($, { volume: v })
  if (engine?.ready) await post($, '/control', { cmd: 'volume', value: v })
}

async function remix($: $T) {
  await patch($, { remixPending: true })
  await control($, 'remix')
}

// --- drawing helpers ----------------------------------------------------

const meter = (v: number, n = 5) => {
  const k = Math.round(Math.max(0, Math.min(1, v)) * n)
  return '█'.repeat(k) + '░'.repeat(n - k)
}

const MODE_COLOR: Record<string, string> = { LIVE: 'green', DEMO: 'magenta', REPLAY: 'cyan' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'orchestra', description: 'Open the CODE ORCHESTRA pane' })
    // A fresh module owns no engine yet: show that, keep volume.
    await patch($, { engine: 'off', running: false, mode: 'LIVE', remixPending: false, progress: null, message: '' })
    void $.ui.open({ id: PANE, title: TITLE, rows: 20 }).catch(() => {})
    return started
  })

  on('command.run', { command: 'orchestra' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, rows: 20, focus: true })
    return { text: 'CODE ORCHESTRA: s Start/Stop · r Remix · d Demo · p Replay · l Live · j/k Volume · Esc back to the prompt' }
  })

  // Observe only: never deny, never rewrite, never call the tool twice.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool
    const startKind = kindAtStart(tool)
    if (startKind) emit($, startKind)
    const ran = await next(e)
    try {
      const r = ran as { deny?: string; isError?: boolean; text?: string }
      const command = tool === 'Bash' ? String((e as unknown as { command?: unknown }).command ?? '') : undefined
      const endKind = kindAtEnd(tool, command, { isError: r.isError === true, denied: r.deny !== undefined, text: r.text ?? '' })
      if (endKind) emit($, endKind)
    } catch {}
    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', ($, e, next) => {
    emit($, 'prompt')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    emit($, 'turn_end')
    void saveRecording($).catch(() => {})
    return done
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      mounted = null
      if (engine?.ready) void post($, '/control', { cmd: 'stop', reason: 'pane closed' }).catch(() => {})
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (engine?.ready) await post($, '/control', { cmd: 'quit' }).catch(() => {})
    await saveRecording($).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value } = await $.state.get({ plugin: 'code-orchestra', key: 'ui' })
    const s = value ?? INITIAL
    const columns = Math.max(16, Math.min(160, e.props.bodyColumns))
    const bodyRows = e.props.scroll?.bodyRows ?? 20
    const rows = Math.max(4, Math.min(16, bodyRows - 8))
    // The stage is a terminal Raster; other surfaces get the text parts only.
    let stage: RenderElement = <Text dimColor>(the light stage draws in the terminal)</Text>
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      mounted = { columns, rows }
      stage = <Raster key="stage" columns={columns} rows={rows} cells={toCells(draw(viz, columns, rows, Date.now()))} />
    } else {
      mounted = null
    }
    const wide = columns >= 64
    const L = s.layers
    const status = s.engine === 'starting' ? 'starting…'
      : s.engine === 'error' ? 'engine error'
      : s.running ? '♪ playing' : 'stopped'
    const modeLabel = s.mode === 'LIVE' ? 'LIVE · real CLI events'
      : s.mode === 'REPLAY' ? 'REPLAY · recorded real events'
      : 'DEMO · scripted events'
    const progress = s.progress != null && s.mode !== 'LIVE' ? ` ${Math.round(s.progress * 100)}%` : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text bold color="magentaBright">CODE ORCHESTRA </Text>
          <Text bold color={MODE_COLOR[s.mode] ?? 'green'}>[{s.mode}]</Text>
          <Text dimColor> {wide ? modeLabel : ''}{progress}  </Text>
          <Text>{status}  </Text>
          <Text color="yellow">bar {s.bar + 1}.{s.beat + 1}  {s.chord}  </Text>
          <Text color="cyan">remix {s.remixName}{s.remixPending ? ' (next bar…)' : ''}  </Text>
          <Text dimColor>vol {Math.round(s.volume * 100)}%</Text>
        </Box>
        {stage}
        <Box flexDirection="row" flexWrap="wrap">
          <Text color="blueBright">PAD {meter(L.pad)} </Text>
          <Text color="redBright">BEAT {meter(L.drums)} </Text>
          <Text color="magenta">BASS {meter(L.bass)} </Text>
          <Text color="yellowBright">MELODY {meter(L.melody)} </Text>
          <Text color="cyanBright">ARP {meter(L.arp)} </Text>
          <Text dimColor>energy {meter(s.energy, 8)} · {s.liveEvents} live events</Text>
        </Box>
        <Box flexDirection="column">
          {s.reflected.length === 0
            ? <Text dimColor>Claude reads → melody · edits → beat & bass · bash → arp · tests → lift</Text>
            : s.reflected.slice(0, 2).map(line => <Text color="greenBright">✓ {line}</Text>)}
          {s.message ? <Text color="yellow">{s.message}</Text> : null}
        </Box>
        <Box flexDirection="row" flexWrap="wrap">
          <Button key="toggle" hotkey="s" variant="primary" label={s.running ? 'Stop' : 'Start'} onPress={() => toggle($)} />
          <Button key="remix" hotkey="r" label="Remix" onPress={() => remix($)} />
          <Button key="demo" hotkey="d" label="Demo" onPress={() => control($, 'demo')} />
          <Button key="replay" hotkey="p" label="Replay" onPress={() => replay($)} />
          <Button key="live" hotkey="l" label="Live" onPress={() => control($, 'live')} />
          <Button key="voldown" hotkey="j" label="Vol−" onPress={() => volume($, -0.1)} />
          <Button key="volup" hotkey="k" label="Vol+" onPress={() => volume($, 0.1)} />
        </Box>
      </Box>
    )
  })

}
