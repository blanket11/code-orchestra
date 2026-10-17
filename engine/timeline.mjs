import { EVENT_KINDS } from './conductor.mjs';

const KNOWN_KINDS = new Set(EVENT_KINDS);

function sortedEvents(events, allowRemix = false) {
  return events
    .filter((event) => event && Number.isFinite(event.atMs) &&
      (KNOWN_KINDS.has(event.kind) || (allowRemix && event.kind === 'remix')))
    .map(({ atMs, kind }) => ({ atMs: Math.max(0, atMs), kind }))
    .sort((a, b) => a.atMs - b.atMs);
}

/** Gap bounds apply before the final proportional fit, which can reduce minGapMs. */
export function compressTimeline(events, { targetMs = 52000, maxGapMs = 2500, minGapMs = 120 } = {}) {
  const sorted = sortedEvents(events);
  if (!sorted.length) return [];
  const target = Number.isFinite(targetMs) ? Math.max(0, targetMs) : 52000;
  const minGap = Number.isFinite(minGapMs) ? Math.max(0, minGapMs) : 120;
  const maxGap = Math.max(minGap, Number.isFinite(maxGapMs) ? maxGapMs : 2500);
  const result = [{ ...sorted[0] }];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = Math.max(minGap, Math.min(maxGap, sorted[index].atMs - sorted[index - 1].atMs));
    result.push({ atMs: result[index - 1].atMs + gap, kind: sorted[index].kind });
  }
  const duration = result.at(-1).atMs;
  if (duration > target) {
    const scale = target / duration;
    for (const event of result) event.atMs = Math.min(target, event.atMs * scale);
    result.at(-1).atMs = target;
  }
  return result;
}

/** A fixed score makes the demo repeatable without a clock or random source. */
export function buildDemoScript() {
  const events = [{ atMs: 300, kind: 'prompt' }];
  for (let atMs = 8500, index = 0; atMs < 20000; atMs += index < 5 ? 1400 : 700, index += 1) {
    events.push({ atMs, kind: index % 3 === 1 ? 'search' : 'read' });
  }
  for (let atMs = 20200, index = 0; atMs < 32000; atMs += 950, index += 1) {
    events.push({ atMs, kind: index % 3 === 0 ? 'write' : 'edit' });
    events.push({ atMs: atMs + 350, kind: index % 4 === 0 ? 'agent' : 'read' });
  }
  events.push({ atMs: 32000, kind: 'remix' });
  for (let atMs = 32600; atMs < 44000; atMs += 900) {
    events.push({ atMs, kind: atMs >= 36000 ? 'bash' : 'search' });
    events.push({ atMs: atMs + 300, kind: 'read' });
  }
  events.push(
    { atMs: 39000, kind: 'test_pass' },
    { atMs: 42300, kind: 'test_pass' },
    { atMs: 45000, kind: 'turn_end' },
    { atMs: 48500, kind: 'turn_end' },
    { atMs: 52000, kind: 'turn_end' },
  );
  return sortedEvents(events, true);
}

export function createPlayer(events) {
  // Own a sorted copy so neither mutations nor due() results affect replay.
  const script = sortedEvents(events, true);
  let cursor = 0;
  return {
    due(elapsedMs) {
      if (!Number.isFinite(elapsedMs)) return [];
      const due = [];
      while (cursor < script.length && script[cursor].atMs <= elapsedMs) {
        due.push({ ...script[cursor] });
        cursor += 1;
      }
      return due;
    },
    // Completion is defined by score time; it does not consume events.
    done(elapsedMs) {
      return script.length === 0 || (Number.isFinite(elapsedMs) && elapsedMs >= script.at(-1).atMs);
    },
    reset() { cursor = 0; },
  };
}
