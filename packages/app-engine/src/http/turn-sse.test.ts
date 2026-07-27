/**
 * Direct unit tests for the SSE turn driver helpers (issue #545 B4).
 * Pure attachment parsing / lock serialization — no live HTTP or runner.
 */

import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { ConversationHistoryStore } from '../conversation/history.js';
import type { ConversationRunner, ConversationTurnInput } from '../conversation/runner.js';
import { makeJournalDbProvider } from '../stores/gateway-db.js';
import {
  driveTurnOverSse,
  parseTurnAttachmentRefs,
  resolveTurnAttachments,
  validateTurnAttachmentRefs,
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

  it('maps only real, size-matched CAS refs through conversationStore.blobPathFor', async () => {
    const dir = await tempDir('centraid-turn-attachments-');
    await fs.writeFile(path.join(dir, HASH), 'png');
    await fs.writeFile(path.join(dir, 'cd'.repeat(32)), 'text');
    const store = {
      blobPathFor: (_appId: string, hash: string) => path.join(dir, hash),
    };
    const refs = [
      { hash: HASH, mime: 'image/png', filename: 'p.png', sizeBytes: 3 },
      { hash: 'cd'.repeat(32), mime: 'text/plain', sizeBytes: 4 },
      { hash: 'ef'.repeat(32), mime: 'text/plain', sizeBytes: 1 },
      { hash: HASH, mime: 'image/png', filename: 'wrong.png', sizeBytes: 99 },
    ];
    expect(validateTurnAttachmentRefs(store as never, 'notes', refs)).toEqual(refs.slice(0, 2));
    const out = resolveTurnAttachments(store as never, 'notes', refs);
    expect(out).toEqual([
      { path: path.join(dir, HASH), mime: 'image/png', filename: 'p.png' },
      { path: path.join(dir, 'cd'.repeat(32)), mime: 'text/plain' },
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

describe('driveTurnOverSse recovery hydration', () => {
  it('includes the sequence-zero turn when an existing runner handle self-heals', async () => {
    const dir = await tempDir('centraid-turn-recovery-');
    const appsDir = path.join(dir, 'apps');
    const appDir = path.join(appsDir, 'notes');
    const journalDbFile = path.join(dir, 'journal.db');
    const runnerSessionDir = path.join(dir, 'runner-sessions');
    await fs.mkdir(appDir, { recursive: true });
    const journal = makeJournalDbProvider(journalDbFile);
    const history = new ConversationHistoryStore(() => ({
      vaultId: 'vault-test',
      ownerPartyId: 'owner',
      appsDir,
      journal,
      journalDbFile,
      runnerSessionDir,
    }));
    const conversation = history.createSession('notes');
    history.recordTurn('notes', {
      conversationId: conversation.id,
      userMessage: 'sequence-zero question',
      startedAt: 1,
      endedAt: 2,
      ok: true,
      finalText: 'sequence-zero answer',
      nodes: [
        {
          kind: 'step',
          text: 'sequence-zero answer',
          startedAt: 1,
          endedAt: 2,
        },
      ],
      adapter: { kind: 'codex', sessionId: 'codex-session' },
    });

    let captured: ConversationTurnInput | undefined;
    const runner: ConversationRunner = {
      async run(input) {
        captured = input;
        input.onEvent({ type: 'final', text: 'next answer' });
        return { adapterKind: 'codex', adapterSessionId: 'codex-session' };
      },
    };
    const requestListeners = new Map<string, (...args: unknown[]) => void>();
    const req = {
      on(event: string, listener: (...args: unknown[]) => void) {
        requestListeners.set(event, listener);
        return this;
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        if (requestListeners.get(event) === listener) requestListeners.delete(event);
        return this;
      },
    } as unknown as IncomingMessage;
    const res = {
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end(this: { writableEnded: boolean }) {
        this.writableEnded = true;
        return this;
      },
    } as unknown as ServerResponse;

    await driveTurnOverSse({
      req,
      res,
      appId: 'notes',
      conversationId: conversation.id,
      message: 'next question',
      dataDir: appDir,
      extraSystemPrompt: 'app context',
      runner,
      runnerKind: 'codex',
      conversationStore: history,
      conversationRunnerSessionDir: runnerSessionDir,
      conversationLocks: new Map(),
      banner: 'test',
    });

    expect(captured?.hydrationContext).toBeUndefined();
    expect(captured?.recoveryHydrationContext).toMatchObject({ includedTurns: 1 });
    expect(captured?.recoveryHydrationContext?.prompt).toContain('sequence-zero question');
    expect(captured?.recoveryHydrationContext?.prompt).toContain('sequence-zero answer');
  });
});
