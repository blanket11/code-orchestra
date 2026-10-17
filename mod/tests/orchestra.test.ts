import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { isTestCommand, kindAtEnd, kindAtStart, kindsForShell } from '../hooks/classify'
import { advance, createViz, draw, onTick } from '../hooks/stage'

const PANE = 'code-orchestra'

function mountPane($: Engine, bodyColumns: number) {
  const props = { title: 'CODE ORCHESTRA', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 22 } } as any
  return $.ui.mount({ plugin: 'code-orchestra', surface: 'terminal', component: 'Pane', props, requestId: PANE })
}

// Sleeps return at once; timers are refused (no frame loop / save timer in tests).
function quietClock(on: On) {
  on('clock.sleep', async () => ({ value: undefined }) as any)
  on('clock.after', async () => ({ deny: 'test' }) as any)
  on('clock.every', async () => ({ deny: 'test' }) as any)
  on('fs.write', async () => ({ value: undefined }) as any)
}

// A fake engine: answers $.process.spawn with ready/state lines and records
// what the mod POSTs over the socket.
function fakeEngine(on: On) {
  const posts: { path: string; body: any }[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  const spawned: string[][] = []
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: '{"type":"ready","running":false,"volume":0.35,"mode":"LIVE"}\n' }
    await gate
    yield { stream: 'stdout' as const, text: '{"type":"state","running":true,"volume":0.35,"mode":"LIVE"}\n' }
    return { value: { code: 0, signal: null } } as any
  })
  on('http.fetch', async (_$, e) => {
    const url = new URL(e.url)
    const body = JSON.parse(String(e.init?.body ?? '{}'))
    posts.push({ path: url.pathname, body })
    if (url.pathname === '/control' && body.cmd === 'start') release()
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } } as any
  })
  return { posts, spawned }
}

test('classifies tool calls; a zero exit code alone is never a test pass', () => {
  expect(kindAtStart('Read')).toBe('read')
  expect(kindAtStart('Grep')).toBe('search')
  expect(kindAtStart('Bash')).toBe('bash')
  expect(kindAtStart('Edit')).toBe(null)
  expect(kindAtEnd('Edit', undefined, { isError: false, denied: false, text: '' })).toBe('edit')
  expect(kindAtEnd('Write', undefined, { isError: true, denied: false, text: '' })).toBe('error')
  expect(kindAtEnd('Edit', undefined, { isError: false, denied: true, text: '' })).toBe(null)
  expect(kindAtEnd('Bash', 'ls -la', { isError: false, denied: false, text: 'ok' })).toBe(null)
  expect(kindAtEnd('Bash', 'npm test', { isError: false, denied: false, text: 'done' })).toBe(null)
  expect(kindAtEnd('Bash', 'npm test', { isError: false, denied: false, text: 'Tests: 12 passed, 12 total' })).toBe('test_pass')
  expect(kindAtEnd('Bash', 'node --test test/', { isError: false, denied: false, text: '# pass 5\n# fail 0' })).toBe('test_pass')
  expect(kindAtEnd('Bash', 'node --test test/', { isError: false, denied: false, text: '# pass 4\n# fail 1' })).toBe('test_fail')
  expect(kindAtEnd('Bash', 'pytest -q', { isError: true, denied: false, text: '1 failed, 3 passed' })).toBe('test_fail')
  expect(kindAtEnd('Bash', 'node --test test/scale.test.mjs', { isError: false, denied: false, text: '✔ a (1ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0' })).toBe('test_pass')
  expect(kindAtEnd('Bash', 'node --test t.mjs', { isError: true, denied: false, text: 'ℹ tests 2\nℹ pass 1\nℹ fail 1' })).toBe('test_fail')
  expect(isTestCommand('echo hello')).toBe(false)
})

test('shell commands sing by what they do: reads/searches → melody, edits → beat', () => {
  expect(kindsForShell('ls; cat package.json; cat scale.mjs; ls test* 2>/dev/null')).toEqual(['search', 'read', 'read', 'search'])
  expect(kindsForShell('node --test test/scale.test.mjs 2>&1 | tail -5')).toEqual(['bash', 'read'])
  expect(kindsForShell("sed -i '' 's/a/b/' scale.mjs && node --test t.mjs")).toEqual(['edit', 'bash'])
  expect(kindsForShell("cat >> scale.mjs <<'EOF'\nexport function x() {}\nEOF")).toEqual(['edit'])
  expect(kindsForShell('echo hi > notes.txt')).toEqual(['edit'])
  expect(kindsForShell('npm run build > /dev/null 2>&1')).toEqual(['bash'])
  expect(kindsForShell('git status && git log --oneline -5')).toEqual(['search', 'search'])
  expect(kindsForShell('FOO=1 rg TODO src')).toEqual(['search'])
  expect(kindsForShell('a; b; c; d; e; f; g; h').length).toBe(6)
  expect(kindsForShell('')).toEqual(['bash'])
})

test('observes a tool call without changing it or running it twice', async ($, on) => {
  let runs = 0
  on('tool.call', async () => {
    runs++
    return { result: { ok: true }, text: '3 passed' } as any
  })
  quietClock(on)
  const ran = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as any)
  expect(runs).toBe(1)
  expect((ran as any).text).toBe('3 passed')
  const ui = await mountPane($, 100)
  expect(await ui.find({ type: 'Text', text: /1 live events/ })).toBeDefined()
  await ui.unmount()
})

test('a failing tool still reaches the model once, unchanged', async ($, on) => {
  let runs = 0
  on('tool.call', async () => {
    runs++
    return { isError: true, result: 'boom', text: 'boom' } as any
  })
  quietClock(on)
  const ran = await $.tool.call({ tool: 'Edit', file_path: 'a.md', old_string: 'a', new_string: 'b' } as any)
  expect(runs).toBe(1)
  expect((ran as any).isError).toBe(true)
})

test('Start spawns one engine, sends start, and live events follow', async ($, on) => {
  quietClock(on)
  mock.env(on, { HOME: '/Users/test', CODE_ORCHESTRA_NODE: '/usr/local/bin/node' })
  const engine = fakeEngine(on)
  const ui = await mountPane($, 80)
  await ui.press({ key: 'toggle' })
  expect(engine.spawned.length).toBe(1)
  expect(engine.spawned[0]![0]).toBe('/usr/local/bin/node')
  expect(engine.spawned[0]![1]).toMatch(/code-orchestra\/engine\/main\.mjs$/)
  expect(engine.spawned[0]![1]).not.toContain('..')
  expect(engine.spawned[0]![3]).toMatch(/^\/Users\/test\/\.code-orchestra\/run\/[0-9a-f]+\.sock$/)
  expect(engine.posts.some(p => p.path === '/control' && p.body.cmd === 'start')).toBe(true)
  await ui.unmount()
})

test('the stage follows the pane width and stays one block glyph per cell', async ($) => {
  for (const columns of [24, 80, 140]) {
    const ui = await mountPane($, columns)
    const raster = await ui.find({ type: 'Raster', key: 'stage' })
    expect(raster?.props.columns).toBe(columns)
    expect(await ui.find({ key: 'remix' })).toBeDefined()
    expect(await ui.find({ key: 'demo' })).toBeDefined()
    await ui.unmount()
  }
})

test('stage drawing reacts to notes and keeps color pairs bounded', () => {
  const viz = createViz()
  viz.running = true
  onTick(viz, {
    bar: 0, step: 0, chord: 'Fmaj7', energy: 0.8,
    layers: { pad: 1, drums: 1, bass: 1, melody: 1, arp: 1 },
    notes: [
      { part: 'melody', midi: 79, vel: 0.9 }, { part: 'arp', midi: 84, vel: 0.6 },
      { part: 'bass', midi: 29, vel: 0.8 }, { part: 'drums', drum: 'kick', vel: 0.9 },
      { part: 'drums', drum: 'snare', vel: 0.7 }, { part: 'drums', drum: 'hat', vel: 0.4 },
    ],
    fx: { lift: true },
  })
  expect(viz.stars.length).toBe(1)
  expect(viz.kick).toBeGreaterThan(0.5)
  const words = draw(viz, 96, 14, 1000)
  expect(words.length).toBe(96 * 14 * 3)
  const pairs = new Set<string>()
  for (let i = 0; i < words.length; i += 3) {
    expect(words[i]).toBe(0x2580)
    pairs.add(`${words[i + 1]}:${words[i + 2]}`)
  }
  expect(pairs.size).toBeLessThan(1024)
  for (let i = 0; i < 100; i++) advance(viz, 100)
  expect(viz.stars.length).toBe(0)
  expect(viz.kick).toBeLessThan(0.01)
})
