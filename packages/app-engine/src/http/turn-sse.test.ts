/**
 * Direct unit tests for the SSE turn driver helpers (issue #545 B4).
 * Pure attachment parsing / lock serialization — no live HTTP or runner.
 */

import { describe, expect, it } from 'vitest';
import {
  parseTurnAttachmentRefs,
  resolveTurnAttachments,
  withConversationLock,
} from './turn-sse.js';

const HASH = 'ab'.repeat(32);

describe('parseTurnAttachmentRefs', () => {
  it('returns [] for non-arrays and drops malformed entries', () => {
    expect(parseTurnAttachmentRefs(undefined)).toEqual([]);
    expect(parseTurnAttachmentRefs(null)).toEqual([]);
    expect(parseTurnAttachmentRefs('x')).toEqual([]);
    expect(parseTurnAttachmentRefs([{ hash: 'short', mime: 'image/png' }])).toEqual([]);
    expect(parseTurnAttachmentRefs([{ hash: HASH }])).toEqual([]); // missing mime
    expect(parseTurnAttachmentRefs([null, 1, {}])).toEqual([]);
  });

  it('keeps only 64-hex hash + mime (filename/size optional passthrough shape)', () => {
    const refs = parseTurnAttachmentRefs([
      { hash: HASH, mime: 'image/png', filename: 'a.png', sizeBytes: 12 },
      { hash: 'cd'.repeat(32), mime: 'text/plain' },
      { hash: HASH.toUpperCase(), mime: 'image/png' }, // uppercase rejected
    ]);
    expect(refs).toEqual([
      { hash: HASH, mime: 'image/png', filename: 'a.png', sizeBytes: 12 },
      { hash: 'cd'.repeat(32), mime: 'text/plain' },
    ]);
  });
});

describe('resolveTurnAttachments', () => {
  it('returns [] when store missing or refs empty', () => {
    expect(resolveTurnAttachments(undefined, 'app', [{ hash: HASH, mime: 'x' }])).toEqual([]);
    expect(resolveTurnAttachments({ blobPathFor: () => '/never' } as never, 'app', [])).toEqual([]);
  });

  it('maps each ref through conversationStore.blobPathFor', () => {
    const store = {
      blobPathFor: (appId: string, hash: string) => `/blobs/${appId}/${hash}`,
    };
    const out = resolveTurnAttachments(store as never, 'notes', [
      { hash: HASH, mime: 'image/png', filename: 'p.png' },
      { hash: 'cd'.repeat(32), mime: 'text/plain' },
    ]);
    expect(out).toEqual([
      { path: `/blobs/notes/${HASH}`, mime: 'image/png', filename: 'p.png' },
      { path: `/blobs/notes/${'cd'.repeat(32)}`, mime: 'text/plain' },
    ]);
  });
});

describe('withConversationLock', () => {
  it('serializes work on the same (appId, conversationId) key', async () => {
    const locks = new Map<string, Promise<void>>();
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });

    const p1 = withConversationLock(locks, 'app', 'c1', async () => {
      order.push(1);
      await firstGate;
      order.push(2);
      return 'a';
    });
    const p2 = withConversationLock(locks, 'app', 'c1', async () => {
      order.push(3);
      return 'b';
    });
    // Same conversation — p2 must wait until p1 finishes.
    await Promise.resolve();
    expect(order).toEqual([1]);
    releaseFirst();
    await expect(Promise.all([p1, p2])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual([1, 2, 3]);
    // Lock entry is cleared once both settle.
    expect(locks.size).toBe(0);
  });

  it('does not block distinct conversation keys', async () => {
    const locks = new Map<string, Promise<void>>();
    const started: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = () => resolve();
    });

    const a = withConversationLock(locks, 'app', 'cA', async () => {
      started.push('a');
      await gateA;
      return 1;
    });
    const b = withConversationLock(locks, 'app', 'cB', async () => {
      started.push('b');
      return 2;
    });
    await Promise.resolve();
    expect(started.sort()).toEqual(['a', 'b']);
    releaseA();
    await expect(Promise.all([a, b])).resolves.toEqual([1, 2]);
  });
});
