/**
 * Names sqlite-worker.ts (issue #545 B8). The module is a web-worker entry
 * that binds message handlers on load; we assert it registers a listener
 * without opening a database, and that unopened ops fail closed.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

const listeners: Array<(ev: MessageEvent) => void> = [];
const posts: unknown[] = [];

describe('sqlite-worker', () => {
  beforeAll(async () => {
    // Install a worker-like global before the module evaluates.
    const g = globalThis as unknown as {
      addEventListener: (type: string, fn: (ev: MessageEvent) => void) => void;
      postMessage: (msg: unknown) => void;
      close: () => void;
    };
    g.addEventListener = (type, fn) => {
      if (type === 'message') listeners.push(fn);
    };
    g.postMessage = (msg) => {
      posts.push(msg);
    };
    g.close = () => undefined;

    await import('./sqlite-worker.js');
  });

  function send(request: { id: number; op: string; payload?: unknown }): Promise<unknown> {
    return new Promise((resolve) => {
      const before = posts.length;
      for (const fn of listeners) {
        fn({ data: request } as MessageEvent);
      }
      const poll = () => {
        if (posts.length > before) {
          resolve(posts[posts.length - 1]);
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    });
  }

  describe('sqlite-worker entry', () => {
    it('registers a message listener on import', () => {
      expect(listeners.length).toBeGreaterThanOrEqual(1);
    });

    it('status / read before open fails closed with a serialized error', async () => {
      const res = (await send({ id: 1, op: 'status' })) as {
        id: number;
        ok: boolean;
        error?: { message: string };
      };
      expect(res.id).toBe(1);
      expect(res.ok).toBe(false);
      expect(res.error?.message).toMatch(/not been opened|not initialized/i);
    });
  });
});

// silence unused in case import path changes
void vi;
