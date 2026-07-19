import { describe, expect, test } from 'vitest';
import { isIgnorableStdinError, safeStdinWrite } from './safe-stdin-write.js';

type ErrorListener = (err: Error) => void;

/** Minimal Writable stand-in with on/emit so we do not pull in EventEmitter. */
function makeFakeStdin(opts?: {
  writable?: boolean;
  writeImpl?: (chunk: string, cb?: (err?: Error | null) => void) => boolean;
}) {
  const listeners = new Set<ErrorListener>();
  const writes: string[] = [];
  const stdin = {
    writable: opts?.writable ?? true,
    writes,
    write(chunk: string, cb?: (err?: Error | null) => void): boolean {
      if (opts?.writeImpl) return opts.writeImpl(chunk, cb);
      writes.push(chunk);
      if (cb) queueMicrotask(() => cb(null));
      return true;
    },
    on(event: string, listener: ErrorListener): typeof stdin {
      if (event === 'error') listeners.add(listener);
      return stdin;
    },
    emit(event: string, err: Error): void {
      if (event !== 'error') return;
      for (const listener of listeners) listener(err);
    },
  };
  return stdin;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('safeStdinWrite', () => {
  test('writes the line when stdin is writable', () => {
    const stdin = makeFakeStdin();
    safeStdinWrite(stdin as never, '{"jsonrpc":"2.0"}\n');
    expect(stdin.writes).toEqual(['{"jsonrpc":"2.0"}\n']);
  });

  test('no-ops when stdin is missing or not writable', () => {
    expect(() => safeStdinWrite(undefined, 'x\n')).not.toThrow();
    const closed = makeFakeStdin({ writable: false });
    safeStdinWrite(closed as never, 'x\n');
    expect(closed.writes).toEqual([]);
  });

  test('swallows EPIPE delivered via the write callback without throwing', async () => {
    const writes: string[] = [];
    const stdin = makeFakeStdin({
      writeImpl: (chunk, cb) => {
        writes.push(chunk);
        const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        if (cb) queueMicrotask(() => cb(err));
        return true;
      },
    });
    expect(() => safeStdinWrite(stdin as never, 'msg\n')).not.toThrow();
    await delay(10);
    expect(writes).toEqual(['msg\n']);
  });

  test('swallows EPIPE emitted on the stream error event (the Vitest failure mode)', async () => {
    const stdin = makeFakeStdin();
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    try {
      safeStdinWrite(stdin as never, 'msg\n');
      // Simulate Node's async EPIPE after the child dies mid-write.
      stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await delay(10);
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
