import { expect, test } from 'vitest';
import { buildReplayEvents } from './turn-replay.ts';
import { TurnLimiter } from './turn-limiter.ts';

test('buildReplayEvents replays a completed turn as start → delta → usage → final (#420)', () => {
  const events = buildReplayEvents({
    turnId: 't1',
    ok: true,
    finalText: 'hello world',
    usage: { model: 'tier:fast', inputTokens: 10, outputTokens: 3 },
  });
  expect(events.map((e) => e.type)).toEqual([
    'assistant.start',
    'assistant.delta',
    'usage',
    'final',
  ]);
  const delta = events.find((e) => e.type === 'assistant.delta');
  expect(delta).toMatchObject({ delta: 'hello world' });
  const final = events.find((e) => e.type === 'final');
  expect(final).toMatchObject({ text: 'hello world' });
});

test('buildReplayEvents omits the delta for an empty answer but still emits final (#420)', () => {
  const events = buildReplayEvents({ turnId: 't', ok: true, finalText: '' });
  expect(events.map((e) => e.type)).toEqual(['assistant.start', 'final']);
});

test('buildReplayEvents replays an errored turn as a single error event (#420)', () => {
  const events = buildReplayEvents({ turnId: 't', ok: false, error: 'kaboom' });
  expect(events).toEqual([{ type: 'error', message: 'kaboom' }]);
});

test('TurnLimiter admits up to max, then refuses; release frees a slot (#420)', () => {
  const limiter = new TurnLimiter(2);
  const a = limiter.tryAcquire();
  const b = limiter.tryAcquire();
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect(limiter.atCapacity()).toBe(true);
  expect(limiter.tryAcquire()).toBeUndefined();
  a?.();
  expect(limiter.atCapacity()).toBe(false);
  expect(limiter.count()).toBe(1);
  const c = limiter.tryAcquire();
  expect(c).toBeDefined();
  // Double-release is a no-op — the count can't go negative or leak a slot.
  a?.();
  expect(limiter.count()).toBe(2);
});
