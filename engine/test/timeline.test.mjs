import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_KINDS, createConductor } from '../conductor.mjs';
import { buildDemoScript, compressTimeline, createPlayer } from '../timeline.mjs';

test('compression sorts, removes unknown kinds, bounds gaps and leaves input untouched', () => {
  const events = [
    { atMs: 100000, kind: 'edit' },
    { atMs: 10, kind: 'search' },
    { atMs: 5, kind: 'unknown' },
    { atMs: 0, kind: 'prompt' },
    { atMs: 100001, kind: 'write' },
    { atMs: 1, kind: 'remix' },
  ];
  const copy = structuredClone(events);
  const result = compressTimeline(events);
  assert.deepEqual(result, [
    { atMs: 0, kind: 'prompt' }, { atMs: 120, kind: 'search' },
    { atMs: 2620, kind: 'edit' }, { atMs: 2740, kind: 'write' },
  ]);
  assert.deepEqual(events, copy);
  assert.notEqual(result, events);
  result[0].kind = 'error';
  assert.deepEqual(events, copy);
});

test('custom gap bounds include duplicate timestamps and preserve stable ordering', () => {
  const result = compressTimeline([
    { atMs: 50, kind: 'read' }, { atMs: 50, kind: 'search' },
    { atMs: 70, kind: 'edit' }, { atMs: 9000, kind: 'bash' },
  ], { minGapMs: 200, maxGapMs: 1000, targetMs: 10000 });
  assert.deepEqual(result.map((event) => event.atMs), [50, 250, 450, 1450]);
  assert.deepEqual(result.map((event) => event.kind), ['read', 'search', 'edit', 'bash']);
});

test('target fitting proportionally shrinks all times, taking precedence over minGap', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({ atMs: index * 10000, kind: 'read' }));
  const unscaled = compressTimeline(events, { targetMs: 100000, minGapMs: 120, maxGapMs: 2500 });
  const result = compressTimeline(events, { targetMs: 600, minGapMs: 120, maxGapMs: 2500 });
  const factor = 600 / unscaled.at(-1).atMs;
  assert.equal(result.at(-1).atMs, 600);
  assert.ok(result[1].atMs - result[0].atMs < 120);
  result.forEach((event, index) => assert.ok(Math.abs(event.atMs - unscaled[index].atMs * factor) < 1e-9));
});

test('default target caps a long recording at 52 seconds', () => {
  const events = Array.from({ length: 100 }, (_, index) => ({ atMs: index * 50000, kind: 'read' }));
  const result = compressTimeline(events);
  assert.ok(result.at(-1).atMs <= 52000);
  assert.equal(result.length, events.length);
});

test('empty, invalid, negative, single-event and zero-target inputs are safe', () => {
  assert.deepEqual(compressTimeline([]), []);
  assert.deepEqual(compressTimeline([{ kind: 'read', atMs: Infinity }, { kind: 'edit', atMs: NaN }, null]), []);
  assert.deepEqual(compressTimeline([{ atMs: -5, kind: 'read' }]), [{ atMs: 0, kind: 'read' }]);
  assert.deepEqual(compressTimeline([{ atMs: 90000, kind: 'read' }]), [{ atMs: 52000, kind: 'read' }]);
  assert.deepEqual(compressTimeline([{ atMs: 0, kind: 'read' }, { atMs: 10, kind: 'edit' }], { targetMs: 0 }), [
    { atMs: 0, kind: 'read' }, { atMs: 0, kind: 'edit' },
  ]);
});

test('demo lasts about 52 seconds and follows the requested musical phases', () => {
  const demo = buildDemoScript();
  assert.ok(demo.at(-1).atMs >= 45000 && demo.at(-1).atMs <= 56000);
  assert.ok(demo.every((event, index) => index === 0 || event.atMs >= demo[index - 1].atMs));
  assert.ok(demo.every((event) => EVENT_KINDS.includes(event.kind) || event.kind === 'remix'));
  assert.deepEqual(demo.filter((event) => event.atMs < 8000), [{ atMs: 300, kind: 'prompt' }]);
  const melody = demo.filter((event) => event.atMs >= 8000 && event.atMs < 20000);
  assert.ok(melody.length >= 8 && melody.every((event) => ['read', 'search'].includes(event.kind)));
  for (const kind of ['edit', 'write']) assert.ok(demo.some((event) => event.atMs >= 20000 && event.atMs < 32000 && event.kind === kind));
  assert.deepEqual(demo.filter((event) => event.kind === 'remix'), [{ atMs: 32000, kind: 'remix' }]);
  for (const kind of ['bash', 'test_pass']) assert.ok(demo.some((event) => event.atMs >= 36000 && event.atMs < 44000 && event.kind === kind));
  assert.ok(demo.filter((event) => event.atMs >= 44000).every((event) => event.kind === 'turn_end'));
  assert.equal(demo.at(-1).kind, 'turn_end');
  demo[0].kind = 'error';
  assert.equal(buildDemoScript()[0].kind, 'prompt');
});

test('player returns all arrivals once, including equal timestamps and demo remix', () => {
  const events = [
    { atMs: 100, kind: 'read' }, { atMs: 0, kind: 'prompt' },
    { atMs: 100, kind: 'search' }, { atMs: 250, kind: 'remix' },
    { atMs: 400, kind: 'turn_end' },
  ];
  const original = structuredClone(events);
  const player = createPlayer(events);
  assert.deepEqual(player.due(-1), []);
  assert.deepEqual(player.due(0), [{ atMs: 0, kind: 'prompt' }]);
  assert.deepEqual(player.due(0), []);
  assert.deepEqual(player.due(99), []);
  assert.deepEqual(player.due(100), [{ atMs: 100, kind: 'read' }, { atMs: 100, kind: 'search' }]);
  assert.deepEqual(player.due(50), []);
  assert.equal(player.done(399), false);
  assert.equal(player.done(400), true);
  assert.deepEqual(player.due(1000), [{ atMs: 250, kind: 'remix' }, { atMs: 400, kind: 'turn_end' }]);
  assert.deepEqual(player.due(1000), []);
  assert.deepEqual(events, original);
  player.reset();
  assert.deepEqual(player.due(1000), [...events].sort((a, b) => a.atMs - b.atMs));
});

test('player owns its input and outputs; invalid kinds/times are ignored', () => {
  const events = [{ atMs: 0, kind: 'prompt' }, { atMs: 500, kind: 'read' }];
  const player = createPlayer(events);
  events[1].atMs = 0;
  events[1].kind = 'error';
  events.push({ atMs: 1, kind: 'bash' });
  const first = player.due(0);
  first[0].kind = 'edit';
  assert.deepEqual(player.due(0), []);
  assert.deepEqual(player.due(NaN), []);
  assert.deepEqual(player.due(Infinity), []);
  assert.deepEqual(player.due(500), [{ atMs: 500, kind: 'read' }]);
  player.reset();
  assert.deepEqual(player.due(0), [{ atMs: 0, kind: 'prompt' }]);
  const empty = createPlayer([{ atMs: 0, kind: 'unknown' }, { atMs: NaN, kind: 'read' }]);
  assert.deepEqual(empty.due(1000), []);
  assert.equal(empty.done(0), true);
});

test('complete demo playback dispatches remix and exercises conductor without losing events', () => {
  const demo = buildDemoScript();
  const player = createPlayer(demo);
  const conductor = createConductor({ seed: 8 });
  const received = [];
  const plans = [];
  const stepMs = 60000 / 112 / 4;
  for (let elapsedMs = 0; elapsedMs <= 56000; elapsedMs += stepMs) {
    for (const event of player.due(elapsedMs)) {
      received.push(event);
      if (event.kind === 'remix') conductor.requestRemix();
      else assert.equal(conductor.pushEvent(event.kind, event.atMs), true);
    }
    plans.push(conductor.advanceStep());
  }
  assert.deepEqual(received, demo);
  assert.equal(player.done(56000), true);
  assert.deepEqual(player.due(56000), []);
  assert.ok(plans.some((plan) => plan.remix === 1));
  assert.ok(plans.some((plan) => plan.fx.lift));
  assert.ok(plans.some((plan) => plan.notes.some((note) => note.part === 'melody')));
  assert.ok(plans.some((plan) => plan.notes.some((note) => note.part === 'bass')));
  assert.equal(conductor.snapshot().totalEvents, demo.length - 1);
  assert.equal(plans.flatMap((plan) => plan.reflected).reduce((count, event) => count + event.count, 0), demo.length - 1);
});
