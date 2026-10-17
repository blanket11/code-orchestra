import test from 'node:test';
import assert from 'node:assert/strict';
import { BPM, EVENT_KINDS, STEPS_PER_BAR, createConductor } from '../conductor.mjs';

const advance = (conductor, count) => Array.from({ length: count }, () => conductor.advanceStep());
const part = (plan, name) => plan.notes.filter((note) => note.part === name);
const reflectedCount = (plan, kind) => plan.reflected.find((event) => event.kind === kind)?.count ?? 0;

function checkPlan(plan) {
  assert.ok(plan.notes.length <= 8);
  assert.ok(plan.energy >= 0 && plan.energy <= 1);
  assert.ok(part(plan, 'melody').length <= 1);
  assert.equal(plan.isBarStart, plan.step === 0);
  assert.ok(plan.step >= 0 && plan.step < 16);
  assert.ok(plan.chord.root >= 28 && plan.chord.root <= 43);
  assert.ok(plan.chord.tones.every((midi) => midi >= 48 && midi <= 72));
  for (const value of Object.values(plan.layers)) assert.ok(value >= 0 && value <= 1);
  for (const note of plan.notes) {
    assert.ok(note.vel >= 0 && note.vel <= 1);
    assert.ok(note.dur >= 1);
    if (note.part === 'drums') {
      assert.ok(['kick', 'snare', 'hat', 'clap', 'crash'].includes(note.drum));
      assert.equal(note.midi, undefined);
    } else {
      assert.ok(Number.isInteger(note.midi));
      assert.equal(note.drum, undefined);
    }
  }
}

test('public constants, first step and serializable initial state', () => {
  assert.equal(BPM, 112);
  assert.equal(STEPS_PER_BAR, 16);
  assert.deepEqual(EVENT_KINDS, ['read', 'search', 'edit', 'write', 'bash', 'test_pass', 'test_fail', 'error', 'prompt', 'agent', 'turn_end']);
  const conductor = createConductor({ seed: 0, bpm: 112 });
  assert.deepEqual(JSON.parse(JSON.stringify(conductor.snapshot())), conductor.snapshot());
  const first = conductor.advanceStep();
  assert.equal(first.bar, 0);
  assert.equal(first.step, 0);
  checkPlan(first);
});

test('read received after step 3 sounds once at step 4', () => {
  const conductor = createConductor();
  const before = advance(conductor, 4);
  assert.equal(before.at(-1).step, 3);
  assert.ok(before.every((plan) => part(plan, 'melody').length === 0));
  conductor.pushEvent('read', 12);
  const plan = conductor.advanceStep();
  assert.equal(plan.step, 4);
  assert.equal(part(plan, 'melody').length, 1);
  assert.deepEqual(plan.reflected, [{ kind: 'read', count: 1 }]);
  assert.equal(conductor.snapshot().queueLength, 0);
  assert.ok(advance(conductor, 4).every((entry) => !part(entry, 'melody').length));
});

test('read received before step 3 waits through step 3 until step 4', () => {
  const conductor = createConductor();
  advance(conductor, 3);
  conductor.pushEvent('read', 0);
  const odd = conductor.advanceStep();
  assert.equal(odd.step, 3);
  assert.deepEqual(odd.reflected, []);
  assert.equal(part(odd, 'melody').length, 0);
  assert.equal(part(conductor.advanceStep(), 'melody').length, 1);
});

test('read, search and agent drain one event per eighth note', () => {
  const conductor = createConductor();
  for (const kind of ['read', 'search', 'agent']) conductor.pushEvent(kind, 0);
  const plans = advance(conductor, 6);
  assert.deepEqual(plans.flatMap((plan) => plan.reflected), [
    { kind: 'read', count: 1 }, { kind: 'search', count: 1 }, { kind: 'agent', count: 1 },
  ]);
  for (const step of [0, 2, 4]) assert.equal(part(plans[step], 'melody').length, 1);
  assert.equal(part(plans[4], 'arp').length, 1);
  assert.equal(plans[4].layers.melody, 0.75);
});

test('edit and write wait for the next bar and then activate drums and bass', () => {
  const conductor = createConductor();
  advance(conductor, 6);
  conductor.pushEvent('edit', 10);
  conductor.pushEvent('write', 11);
  const waiting = advance(conductor, 10);
  assert.ok(waiting.every((plan) => plan.reflected.length === 0));
  assert.ok(waiting.every((plan) => plan.layers.drums === 0 && plan.layers.bass === 0));
  const next = conductor.advanceStep();
  assert.equal(next.bar, 1);
  assert.equal(next.step, 0);
  assert.deepEqual(next.reflected, [{ kind: 'edit', count: 1 }, { kind: 'write', count: 1 }]);
  assert.equal(next.layers.drums, 0.6);
  assert.equal(next.layers.bass, 0.5);
  assert.ok(next.energy > waiting.at(-1).energy);
  assert.equal(part(next, 'bass').length, 1);
});

test('bash waits for the next quarter note', () => {
  const conductor = createConductor();
  advance(conductor, 6);
  conductor.pushEvent('bash', 0);
  const waiting = advance(conductor, 2);
  assert.ok(waiting.every((plan) => plan.reflected.length === 0 && part(plan, 'arp').length === 0));
  const plan = conductor.advanceStep();
  assert.equal(plan.step, 8);
  assert.equal(reflectedCount(plan, 'bash'), 1);
  assert.equal(plan.layers.arp, 0.3);
  assert.equal(part(plan, 'arp').length, 1);
});

test('unknown kinds have no side effects; pushEvent only records receipt', () => {
  const conductor = createConductor();
  const initial = conductor.snapshot();
  assert.equal(conductor.pushEvent('remix', 0), false);
  assert.equal(conductor.pushEvent('__proto__', 0), false);
  assert.deepEqual(conductor.snapshot(), initial);
  assert.equal(conductor.pushEvent('edit', 0), true);
  const queued = conductor.snapshot();
  assert.deepEqual(queued.layers, initial.layers);
  assert.equal(queued.energy, initial.energy);
  assert.equal(queued.totalEvents, 1);
  assert.equal(queued.countsByKind.edit, 1);
  assert.equal(queued.queueLength, 1);
});

test('1000 mixed events keep queue, voices, velocity and melody density bounded', () => {
  const conductor = createConductor({ seed: 123 });
  for (let index = 0; index < 1000; index += 1) {
    conductor.pushEvent(EVENT_KINDS[index % EVENT_KINDS.length], index);
    assert.ok(conductor.snapshot().queueLength <= 32);
  }
  assert.equal(conductor.snapshot().totalEvents, 1000);
  assert.equal(Object.values(conductor.snapshot().countsByKind).reduce((a, b) => a + b, 0), 1000);
  const melodies = new Map();
  const reflected = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0]));
  for (let index = 0; index < 16 * 36; index += 1) {
    const plan = conductor.advanceStep();
    checkPlan(plan);
    assert.ok(conductor.snapshot().queueLength <= 32);
    melodies.set(plan.bar, (melodies.get(plan.bar) ?? 0) + part(plan, 'melody').length);
    for (const event of plan.reflected) reflected[event.kind] += event.count;
  }
  assert.ok([...melodies.values()].every((count) => count <= 8));
  assert.deepEqual(reflected, conductor.snapshot().countsByKind);
  assert.equal(conductor.snapshot().queueLength, 0);
});

test('overflow aggregation preserves every read and consumes counts one at a time', () => {
  const conductor = createConductor();
  for (let index = 0; index < 1000; index += 1) conductor.pushEvent('read', index);
  let count = 0;
  for (const plan of advance(conductor, 2000)) {
    assert.ok(plan.notes.length <= 8);
    const reflected = reflectedCount(plan, 'read');
    assert.ok(reflected <= 1);
    count += reflected;
  }
  assert.equal(count, 1000);
  assert.equal(conductor.snapshot().queueLength, 0);
});

test('a saturated downbeat retains pad, event melody/harmony, bass, crash and kick within eight notes', () => {
  const conductor = createConductor();
  for (let index = 0; index < 10; index += 1) conductor.pushEvent('edit', 0);
  conductor.pushEvent('agent', 0);
  conductor.pushEvent('bash', 0);
  conductor.pushEvent('test_pass', 0);
  const plan = conductor.advanceStep();
  checkPlan(plan);
  assert.equal(plan.notes.length, 8);
  assert.equal(part(plan, 'pad').length, 3);
  assert.equal(part(plan, 'melody').length, 1);
  assert.equal(part(plan, 'arp').length, 1);
  assert.equal(part(plan, 'bass').length, 1);
  assert.ok(plan.notes.some((note) => note.drum === 'crash'));
  assert.ok(plan.notes.some((note) => note.drum === 'kick'));
  assert.equal(reflectedCount(plan, 'edit'), 10);
  assert.equal(reflectedCount(plan, 'agent'), 1);
  assert.equal(reflectedCount(plan, 'bash'), 1);
  assert.equal(reflectedCount(plan, 'test_pass'), 1);
});

test('no input still plays a sustained pad chord at every bar for eight bars', () => {
  const conductor = createConductor();
  for (const plan of advance(conductor, 16 * 8)) {
    checkPlan(plan);
    assert.ok(plan.layers.pad >= 0.35);
    if (plan.isBarStart) {
      assert.ok(part(plan, 'pad').length >= 3);
      assert.ok(part(plan, 'pad').every((note) => note.dur === 16 && note.vel > 0));
    }
  }
});

test('requestRemix is idempotent until the next bar and cycles modulo four', () => {
  const conductor = createConductor();
  advance(conductor, 5);
  conductor.requestRemix();
  conductor.requestRemix();
  conductor.requestRemix();
  assert.equal(conductor.snapshot().pendingRemix, 1);
  assert.ok(advance(conductor, 11).every((plan) => plan.remix === 0));
  assert.equal(conductor.advanceStep().remix, 1);
  assert.equal(conductor.snapshot().pendingRemix, null);
  for (const expected of [2, 3, 0]) {
    conductor.requestRemix();
    assert.ok(advance(conductor, 15).every((plan) => plan.remix === (expected + 3) % 4));
    assert.equal(conductor.advanceStep().remix, expected);
  }
});

test('setRemix clamps and only applies at bar boundaries', () => {
  const conductor = createConductor();
  conductor.setRemix(99);
  assert.equal(conductor.snapshot().remix, 0);
  assert.equal(conductor.advanceStep().remix, 3);
  conductor.setRemix(-8);
  assert.ok(advance(conductor, 15).every((plan) => plan.remix === 3));
  assert.equal(conductor.advanceStep().remix, 0);
  conductor.setRemix(2.8);
  advance(conductor, 15);
  assert.equal(conductor.advanceStep().remix, 2);
  conductor.setRemix(Number.NaN);
  advance(conductor, 15);
  assert.equal(conductor.advanceStep().remix, 0);
});

test('progressions loop every four bars and Night Drive selects PROG_B', () => {
  for (const [remix, expected] of [
    [0, ['Fmaj7', 'G6', 'Em7', 'Am9']],
    [3, ['Am9', 'Fmaj7', 'C(add9)', 'G6']],
  ]) {
    const conductor = createConductor();
    conductor.setRemix(remix);
    const starts = advance(conductor, 16 * 8).filter((plan) => plan.isBarStart);
    assert.deepEqual(starts.map((plan) => plan.chord.name), [...expected, ...expected]);
  }
});

test('seeded execution, including reset, reproduces complete plans', () => {
  function perform(conductor) {
    const plans = [];
    for (let index = 0; index < 160; index += 1) {
      if (index % 3 === 0) conductor.pushEvent(EVENT_KINDS[index % EVENT_KINDS.length], index * 50);
      if (index % 7 === 0) conductor.pushEvent('read', index * 50);
      if (index === 18 || index === 50) conductor.requestRemix();
      if (index === 104) conductor.setRemix(3);
      plans.push(conductor.advanceStep());
    }
    return plans;
  }
  const conductor = createConductor({ seed: 42 });
  const first = perform(conductor);
  assert.deepEqual(perform(createConductor({ seed: 42 })), first);
  assert.notDeepEqual(perform(createConductor({ seed: 43 })), first);
  conductor.reset();
  assert.equal(conductor.snapshot().totalEvents, 0);
  assert.equal(conductor.snapshot().pendingRemix, null);
  assert.deepEqual(perform(conductor), first);
});

test('test_pass creates one lift bar with a crash and temporary energy', () => {
  const conductor = createConductor();
  const control = createConductor();
  advance(conductor, 6);
  advance(control, 6);
  conductor.pushEvent('test_pass', 0);
  assert.ok(advance(conductor, 10).every((plan) => !plan.fx.lift));
  advance(control, 10);
  const lifted = conductor.advanceStep();
  const normal = control.advanceStep();
  assert.equal(lifted.fx.lift, true);
  assert.equal(lifted.mood, 'lift');
  assert.equal(reflectedCount(lifted, 'test_pass'), 1);
  assert.ok(Math.abs(lifted.energy - normal.energy - 0.3) < 1e-12);
  assert.ok(lifted.notes.some((note) => note.drum === 'crash'));
  assert.ok(advance(conductor, 15).every((plan) => plan.fx.lift));
  advance(control, 15);
  const after = conductor.advanceStep();
  assert.equal(after.fx.lift, false);
  assert.equal(after.energy, control.advanceStep().energy);
});

for (const kind of ['test_fail', 'error']) {
  test(`${kind} creates one gentle shadow bar with a minor substitute and fewer kicks`, () => {
    const conductor = createConductor();
    for (let index = 0; index < 20; index += 1) conductor.pushEvent('edit', 0);
    conductor.pushEvent(kind, 0);
    const plans = advance(conductor, 16);
    assert.ok(plans.every((plan) => plan.fx.shadow && plan.mood === 'shadow'));
    assert.equal(plans[0].chord.name, 'Am9');
    assert.equal(reflectedCount(plans[0], kind), 1);
    assert.ok(plans.flatMap((plan) => plan.notes).every((note) => note.vel <= 0.65));
    assert.deepEqual(plans.filter((plan) => plan.notes.some((note) => note.drum === 'kick')).map((plan) => plan.step), [0]);
    assert.equal(conductor.advanceStep().fx.shadow, false);
  });
}

test('prompt and turn_end apply at the bar; layers decay thereafter', () => {
  const conductor = createConductor();
  conductor.pushEvent('prompt', 0);
  conductor.pushEvent('edit', 0);
  const first = conductor.advanceStep();
  assert.equal(first.layers.pad, 1);
  assert.equal(first.mood, 'groove');
  conductor.pushEvent('turn_end', 0);
  advance(conductor, 15);
  const next = conductor.advanceStep();
  assert.ok(Math.abs(next.energy - Math.max(0, first.energy * 0.85 - 0.15)) < 1e-12);
  assert.equal(next.layers.pad, 0.85);
  assert.equal(next.layers.drums, 0.255);
  assert.equal(next.layers.bass, 0.2125);
});

test('melodies stay pentatonic, favor chord tones on strong beats and limit leaps', () => {
  const conductor = createConductor({ seed: 64 });
  const pitchClasses = [0, 2, 4, 7, 9];
  let previous = 76;
  let count = 0;
  for (let index = 0; index < 16 * 64; index += 1) {
    if (index % 2 === 0) conductor.pushEvent(index % 4 === 0 ? 'search' : 'read', index);
    const plan = conductor.advanceStep();
    for (const note of part(plan, 'melody')) {
      assert.ok(note.midi >= 72 && note.midi <= 93);
      assert.ok(pitchClasses.includes(note.midi % 12));
      assert.ok(Math.abs(note.midi - previous) <= 7);
      if (plan.step % 4 === 0) assert.ok(plan.chord.tones.some((midi) => midi % 12 === note.midi % 12));
      previous = note.midi;
      count += 1;
    }
  }
  assert.equal(count, 512);
});

test('drum density and bass patterns respond to layer strength', () => {
  for (const [edits, kicks, snares, bass] of [
    [0, [0, 8], [], []],
    [1, [0, 8, 10], [4, 12], [0]],
    [2, [0, 8, 10], [4, 12], [0, 8]],
    [3, [0, 6, 8, 10], [4, 12], [0, 3, 6, 8, 11, 14]],
  ]) {
    const conductor = createConductor();
    for (let index = 0; index < edits; index += 1) conductor.pushEvent('edit', 0);
    const plans = advance(conductor, 16);
    const drumSteps = (drum) => plans.filter((plan) => plan.notes.some((note) => note.drum === drum)).map((plan) => plan.step);
    assert.deepEqual(drumSteps('kick'), kicks);
    assert.deepEqual(drumSteps('snare'), snares);
    assert.deepEqual(plans.filter((plan) => part(plan, 'bass').length).map((plan) => plan.step), bass);
    assert.equal(drumSteps('hat').length, edits === 3 ? 16 : 8);
    if (edits === 3) assert.deepEqual(drumSteps('clap'), [12]);
  }
});

test('Halftime changes drums, Arp Storm runs every step, Night Drive alternates bass octaves', () => {
  const half = createConductor();
  half.setRemix(1);
  half.pushEvent('edit', 0);
  const plans = advance(half, 16);
  assert.deepEqual(plans.filter((plan) => plan.notes.some((note) => note.drum === 'kick')).map((plan) => plan.step), [0, 11]);
  assert.deepEqual(plans.filter((plan) => plan.notes.some((note) => note.drum === 'snare')).map((plan) => plan.step), [8]);
  const storm = createConductor();
  storm.setRemix(2);
  for (const plan of advance(storm, 16)) {
    assert.equal(part(plan, 'arp').length, 1);
    assert.ok(plan.chord.tones.some((midi) => midi % 12 === part(plan, 'arp')[0].midi % 12));
  }
  const night = createConductor();
  night.setRemix(3);
  night.pushEvent('edit', 0);
  const nightPlans = advance(night, 16);
  const bass = nightPlans.flatMap((plan) => part(plan, 'bass'));
  assert.equal(bass.length, 8);
  assert.deepEqual(bass.map((note) => note.midi), [33, 45, 33, 45, 33, 45, 33, 45]);
});

test('returned plans and snapshots cannot mutate conductor state or earlier plans', () => {
  const conductor = createConductor();
  conductor.pushEvent('read', 0);
  const plan = conductor.advanceStep();
  const snapshot = conductor.snapshot();
  const saved = structuredClone(plan);
  snapshot.layers.pad = 0;
  snapshot.countsByKind.read = -1;
  assert.notEqual(conductor.snapshot().layers.pad, 0);
  assert.equal(conductor.snapshot().countsByKind.read, 1);
  conductor.advanceStep();
  assert.deepEqual(plan, saved);
  plan.chord.tones[0] = -999;
  plan.layers.pad = -999;
  assert.ok(conductor.advanceStep().chord.tones.every((midi) => midi > 0));
  assert.ok(conductor.snapshot().layers.pad > 0);
});
