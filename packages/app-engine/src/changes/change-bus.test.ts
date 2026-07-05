import { describe, expect, it } from 'vitest';
import { ChangeBus, type AppChange } from './change-bus.js';

describe('ChangeBus', () => {
  it('delivers emits to matching-app subscribers in subscription order', () => {
    const bus = new ChangeBus();
    const seen: string[] = [];
    bus.subscribe('app1', (c) => seen.push(`a:${c.tables.join(',')}`));
    bus.subscribe('app1', (c) => seen.push(`b:${c.tables.join(',')}`));
    bus.emit({ appId: 'app1', tables: ['todos'], ts: 1, source: 'handler' });
    expect(seen).toEqual(['a:todos', 'b:todos']);
  });

  it('does not deliver to subscribers of other apps', () => {
    const bus = new ChangeBus();
    let app1Count = 0;
    let app2Count = 0;
    bus.subscribe('app1', () => app1Count++);
    bus.subscribe('app2', () => app2Count++);
    bus.emit({ appId: 'app1', tables: ['todos'], ts: 1, source: 'handler' });
    bus.emit({ appId: 'app1', tables: ['users'], ts: 2, source: 'handler' });
    bus.emit({ appId: 'app2', tables: ['notes'], ts: 3, source: 'handler' });
    expect(app1Count).toBe(2);
    expect(app2Count).toBe(1);
  });

  it('delivers emits with empty table lists ("the app acted", #286)', () => {
    const bus = new ChangeBus();
    let count = 0;
    bus.subscribe('app1', () => count++);
    bus.emit({ appId: 'app1', tables: [], ts: 1, source: 'handler' });
    expect(count).toBe(1);
  });

  it('unsubscribe stops delivery and removes the listener', () => {
    const bus = new ChangeBus();
    let count = 0;
    const unsub = bus.subscribe('app1', () => count++);
    bus.emit({ appId: 'app1', tables: ['t'], ts: 1, source: 'handler' });
    expect(count).toBe(1);
    unsub();
    bus.emit({ appId: 'app1', tables: ['t'], ts: 2, source: 'handler' });
    expect(count).toBe(1);
    expect(bus.listenerCount('app1')).toBe(0);
  });

  it('isolates a listener that throws from other listeners and from the emitter', () => {
    const warnings: string[] = [];
    const bus = new ChangeBus({
      logger: {
        info: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });
    let goodAfter = false;
    bus.subscribe('app1', () => {
      throw new Error('boom');
    });
    bus.subscribe('app1', () => {
      goodAfter = true;
    });
    // Emit must not propagate the throw.
    expect(() =>
      bus.emit({ appId: 'app1', tables: ['t'], ts: 1, source: 'handler' }),
    ).not.toThrow();
    expect(goodAfter).toBe(true);
    expect(warnings.some((w) => w.includes('boom'))).toBeTruthy();
  });

  it('listener that unsubscribes itself during dispatch does not break iteration', () => {
    const bus = new ChangeBus();
    const order: string[] = [];
    let unsubA: () => void;
    unsubA = bus.subscribe('app1', () => {
      order.push('a');
      unsubA();
    });
    bus.subscribe('app1', () => order.push('b'));
    bus.emit({ appId: 'app1', tables: ['t'], ts: 1, source: 'handler' });
    bus.emit({ appId: 'app1', tables: ['t'], ts: 2, source: 'handler' });
    // First emit: a, b. Second emit: only b (a unsubscribed itself).
    expect(order).toEqual(['a', 'b', 'b']);
  });

  it('exposes listenerCount for diagnostics', () => {
    const bus = new ChangeBus();
    expect(bus.listenerCount('app1')).toBe(0);
    const u1 = bus.subscribe('app1', () => {});
    const u2 = bus.subscribe('app1', () => {});
    expect(bus.listenerCount('app1')).toBe(2);
    u1();
    expect(bus.listenerCount('app1')).toBe(1);
    u2();
    expect(bus.listenerCount('app1')).toBe(0);
  });

  it('emit passes through the full AppChange shape including ts', () => {
    const bus = new ChangeBus();
    const captured: AppChange[] = [];
    bus.subscribe('app1', (c) => captured.push(c));
    bus.emit({ appId: 'app1', tables: ['a', 'b'], ts: 12345, source: 'handler' });
    expect(captured.length).toBe(1);
    expect(captured[0]).toEqual({
      appId: 'app1',
      tables: ['a', 'b'],
      ts: 12345,
      source: 'handler',
    });
  });
});
