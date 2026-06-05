import { describe, expect, it } from 'vitest';
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

    expect(a).toEqual([{ type: 'run.start', runId: 'run-a' }]);
    expect(b).toEqual([{ type: 'run.end', ok: true }]);
  });

  it('publishing to a run with no subscribers is a no-op (events are ephemeral)', () => {
    const bus = new RunEventBus();
    expect(() => bus.publish('nobody', { type: 'run.end', ok: true })).not.toThrow();
    expect(bus.subscriberCount('nobody')).toBe(0);
  });

  it('unsubscribe stops delivery and drops the empty channel', () => {
    const bus = new RunEventBus();
    const seen: RunStreamEvent[] = [];
    const unsub = bus.subscribe('r', (ev) => seen.push(ev));
    bus.publish('r', { type: 'run.start', runId: 'r' });
    expect(bus.subscriberCount('r')).toBe(1);
    unsub();
    expect(bus.subscriberCount('r')).toBe(0);
    bus.publish('r', { type: 'run.end', ok: true });
    expect(seen.length).toBe(1);
    // Idempotent.
    expect(() => unsub()).not.toThrow();
  });

  it('a throwing subscriber does not break the fanout to others', () => {
    const bus = new RunEventBus();
    const ok: RunStreamEvent[] = [];
    bus.subscribe('r', () => {
      throw new Error('wedged subscriber');
    });
    bus.subscribe('r', (ev) => ok.push(ev));
    expect(() => bus.publish('r', { type: 'run.start', runId: 'r' })).not.toThrow();
    expect(ok.length).toBe(1);
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
    expect(seen).toEqual(['first:run.start', 'second:run.start']);
    expect(bus.subscriberCount('r')).toBe(1);
  });
});
