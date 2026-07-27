import { describe, expect, it } from 'vitest';
import type { AutomationTurnStreamEvent } from '@centraid/app-engine';
import { RunEventBus } from './run-event-bus.js';

describe(RunEventBus, () => {
  it('fans an event out only to subscribers of the matching runId', () => {
    const bus = new RunEventBus();
    const a: AutomationTurnStreamEvent[] = [];
    const b: AutomationTurnStreamEvent[] = [];
    bus.subscribe('run-a', (ev) => a.push(ev));
    bus.subscribe('run-b', (ev) => b.push(ev));

    bus.publish('run-a', { type: 'turn.start', turnId: 'run-a' });
    bus.publish('run-b', { type: 'turn.end', turnId: 'run-b', ok: true });

    expect(a).toStrictEqual([{ type: 'turn.start', turnId: 'run-a' }]);
    expect(b).toStrictEqual([{ type: 'turn.end', turnId: 'run-b', ok: true }]);
  });

  it('publishing to a run with no subscribers is a no-op (events are ephemeral)', () => {
    const bus = new RunEventBus();
    expect(() =>
      bus.publish('nobody', { type: 'turn.end', turnId: 'nobody', ok: true }),
    ).not.toThrow();
    expect(bus.subscriberCount('nobody')).toBe(0);
  });

  it('unsubscribe stops delivery and drops the empty channel', () => {
    const bus = new RunEventBus();
    const seen: AutomationTurnStreamEvent[] = [];
    const unsub = bus.subscribe('r', (ev) => seen.push(ev));
    bus.publish('r', { type: 'turn.start', turnId: 'r' });
    expect(bus.subscriberCount('r')).toBe(1);
    unsub();
    expect(bus.subscriberCount('r')).toBe(0);
    bus.publish('r', { type: 'turn.end', turnId: 'r', ok: true });
    expect(seen).toHaveLength(1);
    // Idempotent.
    expect(() => unsub()).not.toThrow();
  });

  it('a throwing subscriber does not break the fanout to others', () => {
    const bus = new RunEventBus();
    const ok: AutomationTurnStreamEvent[] = [];
    bus.subscribe('r', () => {
      throw new Error('wedged subscriber');
    });
    bus.subscribe('r', (ev) => ok.push(ev));
    expect(() => bus.publish('r', { type: 'turn.start', turnId: 'r' })).not.toThrow();
    expect(ok).toHaveLength(1);
  });

  it('a subscriber that unsubscribes itself mid-fanout is handled (snapshot)', () => {
    const bus = new RunEventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe('r', (ev) => {
      seen.push(`first:${ev.type}`);
      unsub();
    });
    bus.subscribe('r', (ev) => seen.push(`second:${ev.type}`));
    bus.publish('r', { type: 'turn.start', turnId: 'r' });
    expect(seen).toStrictEqual(['first:turn.start', 'second:turn.start']);
    expect(bus.subscriberCount('r')).toBe(1);
  });
});
