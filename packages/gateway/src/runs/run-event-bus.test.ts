import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { RunStreamEvent } from '@centraid/app-engine';
import { RunEventBus } from './run-event-bus.js';

describe('RunEventBus', () => {
  it('fans an event out only to subscribers of the matching runId', () => {
    const bus = new RunEventBus();
    const a: RunStreamEvent[] = [];
    const b: RunStreamEvent[] = [];
    bus.subscribe('run-a', (ev) => a.push(ev));
    bus.subscribe('run-b', (ev) => b.push(ev));

    bus.publish('run-a', { type: 'run.start', runId: 'run-a' });
    bus.publish('run-b', { type: 'run.end', ok: true });

    assert.deepEqual(a, [{ type: 'run.start', runId: 'run-a' }]);
    assert.deepEqual(b, [{ type: 'run.end', ok: true }]);
  });

  it('publishing to a run with no subscribers is a no-op (events are ephemeral)', () => {
    const bus = new RunEventBus();
    assert.doesNotThrow(() => bus.publish('nobody', { type: 'run.end', ok: true }));
    assert.equal(bus.subscriberCount('nobody'), 0);
  });

  it('unsubscribe stops delivery and drops the empty channel', () => {
    const bus = new RunEventBus();
    const seen: RunStreamEvent[] = [];
    const unsub = bus.subscribe('r', (ev) => seen.push(ev));
    bus.publish('r', { type: 'run.start', runId: 'r' });
    assert.equal(bus.subscriberCount('r'), 1);
    unsub();
    assert.equal(bus.subscriberCount('r'), 0);
    bus.publish('r', { type: 'run.end', ok: true });
    assert.equal(seen.length, 1, 'no events after unsubscribe');
    // Idempotent.
    assert.doesNotThrow(() => unsub());
  });

  it('a throwing subscriber does not break the fanout to others', () => {
    const bus = new RunEventBus();
    const ok: RunStreamEvent[] = [];
    bus.subscribe('r', () => {
      throw new Error('wedged subscriber');
    });
    bus.subscribe('r', (ev) => ok.push(ev));
    assert.doesNotThrow(() => bus.publish('r', { type: 'run.start', runId: 'r' }));
    assert.equal(ok.length, 1);
  });

  it('a subscriber that unsubscribes itself mid-fanout is handled (snapshot)', () => {
    const bus = new RunEventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe('r', (ev) => {
      seen.push(`first:${ev.type}`);
      unsub();
    });
    bus.subscribe('r', (ev) => seen.push(`second:${ev.type}`));
    bus.publish('r', { type: 'run.start', runId: 'r' });
    assert.deepEqual(seen, ['first:run.start', 'second:run.start']);
    assert.equal(bus.subscriberCount('r'), 1);
  });
});
