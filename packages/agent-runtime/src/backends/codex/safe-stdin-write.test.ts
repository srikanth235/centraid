import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { isIgnorableStdinError, safeStdinWrite } from './safe-stdin-write.js';

class FakeStdin extends EventEmitter {
  writable = true;
  writes: string[] = [];
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.writes.push(chunk);
    if (cb) queueMicrotask(() => cb(null));
    return true;
  }
}

describe('safeStdinWrite', () => {
  test('writes the line when stdin is writable', async () => {
    const stdin = new FakeStdin();
    safeStdinWrite(stdin as never, '{"jsonrpc":"2.0"}\n');
    expect(stdin.writes).toEqual(['{"jsonrpc":"2.0"}\n']);
  });

  test('no-ops when stdin is missing or not writable', () => {
    expect(() => safeStdinWrite(undefined, 'x\n')).not.toThrow();
    const closed = new FakeStdin();
    closed.writable = false;
    safeStdinWrite(closed as never, 'x\n');
    expect(closed.writes).toEqual([]);
  });

  test('swallows EPIPE delivered via the write callback without throwing', async () => {
    const stdin = new FakeStdin();
    stdin.write = (chunk: string, cb?: (err?: Error | null) => void) => {
      stdin.writes.push(chunk);
      const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      if (cb) queueMicrotask(() => cb(err));
      return true;
    };
    expect(() => safeStdinWrite(stdin as never, 'msg\n')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  test('swallows EPIPE emitted on the stream error event (the Vitest failure mode)', async () => {
    const stdin = new FakeStdin();
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    try {
      safeStdinWrite(stdin as never, 'msg\n');
      // Simulate Node's async EPIPE after the child dies mid-write.
      stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await new Promise((r) => setTimeout(r, 10));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  test('isIgnorableStdinError recognizes closed-pipe codes', () => {
    expect(isIgnorableStdinError({ code: 'EPIPE' })).toBe(true);
    expect(isIgnorableStdinError({ code: 'ERR_STREAM_DESTROYED' })).toBe(true);
    expect(isIgnorableStdinError({ code: 'EACCES' })).toBe(false);
    expect(isIgnorableStdinError(null)).toBe(false);
  });
});
