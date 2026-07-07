import { describe, expect, it } from 'vitest';
import { authDeadError, ConnectionLimiter, delay } from './connection-limiter.js';

describe('authDeadError', () => {
  it('is a plain Error stamped with the AuthDeadError name', () => {
    const err = authDeadError('no refresh token');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AuthDeadError');
    expect(err.message).toBe('no refresh token');
  });
});

describe('delay', () => {
  it('resolves after roughly the requested interval', async () => {
    const start = Date.now();
    await delay(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe('ConnectionLimiter', () => {
  it('runs a task and returns its value', async () => {
    const limiter = new ConnectionLimiter(2, 0);
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('caps concurrency — a second task waits for the first to finish', async () => {
    const limiter = new ConnectionLimiter(1, 0);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = limiter.run(async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
    });
    const second = limiter.run(async () => {
      order.push('second-start');
    });
    // Let both microtasks settle: the second must be queued, not started.
    await delay(10);
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('spaces successive starts by at least minIntervalMs', async () => {
    const limiter = new ConnectionLimiter(1, 40);
    const starts: number[] = [];
    const base = Date.now();
    await limiter.run(async () => {
      starts.push(Date.now() - base);
    });
    await limiter.run(async () => {
      starts.push(Date.now() - base);
    });
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(30);
  });

  it('propagates a task rejection and still frees the slot', async () => {
    const limiter = new ConnectionLimiter(1, 0);
    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The slot was released in the finally, so the next task runs.
    await expect(limiter.run(async () => 'after')).resolves.toBe('after');
  });
});
