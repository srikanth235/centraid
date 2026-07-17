import { describe, expect, it, vi } from 'vitest';
import { activeAttemptOf, hydrateMessages, msgToDTO, type AsstMsg } from './assistantTranscript.js';

// The renderer pulls in the auth-aware resolver; stub it as assistantRich's own
// test does (the codec under test never calls it).
vi.mock('../../../gateway-client.js', () => ({ resolveAssistantRefs: vi.fn() }));

describe('hydrateMessages', () => {
  it('carries createdAt + turn identity onto reconstructed answers', () => {
    const msgs = hydrateMessages([
      { payload: { kind: 'user', text: 'hi' }, createdAt: 100 },
      { payload: { kind: 'ai', text: 'yo', turnId: 't1', feedback: 'up' }, createdAt: 200 },
    ]);
    expect(msgs[0]).toMatchObject({ kind: 'user', text: 'hi', createdAt: 100 });
    expect(msgs[1]).toMatchObject({
      kind: 'ai',
      text: 'yo',
      turnId: 't1',
      feedback: 'up',
      createdAt: 200,
    });
  });

  it('expands a retry payload into attempts with the latest active', () => {
    const msgs = hydrateMessages([
      { payload: { kind: 'user', text: 'why' }, createdAt: 1 },
      {
        payload: {
          kind: 'ai',
          text: 'B',
          turnId: 't2',
          feedback: null,
          retry: {
            index: 2,
            count: 2,
            attempts: [
              { turnId: 't1', text: 'A', feedback: 'down' },
              { turnId: 't2', text: 'B', feedback: null },
            ],
          },
        },
        createdAt: 2,
      },
    ]);
    const ai = msgs[1] as Extract<AsstMsg, { kind: 'ai' }>;
    expect(ai.attempts?.length).toBe(2);
    expect(ai.activeAttempt).toBe(1);
    expect(activeAttemptOf(ai)?.turnId).toBe('t2');
  });

  it('groups consecutive tool rows into one tools message', () => {
    const msgs = hydrateMessages([
      { payload: { kind: 'tool', id: 'x', tool: 'vault_sql', state: 'ok' }, createdAt: 1 },
      { payload: { kind: 'tool', id: 'y', tool: 'vault_sql', state: 'error' }, createdAt: 2 },
    ]);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({ kind: 'tools' });
    expect((msgs[0] as Extract<AsstMsg, { kind: 'tools' }>).calls.length).toBe(2);
  });

  it('prepends a from-the-archive notice and marks rehydrated answers (issue #438)', () => {
    const msgs = hydrateMessages(
      [{ payload: { kind: 'ai', text: 'old', turnId: 't1', fromArchive: true }, createdAt: 1 }],
      { hasArchivedHistory: true },
    );
    expect(msgs[0]).toMatchObject({ kind: 'notice', level: 'info' });
    expect(msgs[1]).toMatchObject({ kind: 'ai', text: 'old', fromArchive: true });
  });

  it('prepends a warn notice when archived history is unavailable (issue #438)', () => {
    const msgs = hydrateMessages([], { hasArchivedHistory: true, archiveUnavailable: true });
    expect(msgs[0]).toMatchObject({ kind: 'notice', level: 'warn' });
  });
});

describe('msgToDTO', () => {
  it('renders the active attempt + a pager position for a retried answer', () => {
    const msg: AsstMsg = {
      kind: 'ai',
      text: 'B',
      turnId: 't2',
      feedback: null,
      attempts: [
        { turnId: 't1', text: 'A', feedback: 'down' },
        { turnId: 't2', text: 'B', feedback: null },
      ],
      activeAttempt: 0,
    };
    const dto = msgToDTO(msg, true);
    expect(dto).toMatchObject({ kind: 'ai', streaming: false });
    if (dto.kind === 'ai' && dto.streaming === false) {
      // activeAttempt 0 → attempt A shown, pager reads 1/2, feedback from A.
      expect(dto.copyText).toBe('A');
      expect(dto.turnId).toBe('t1');
      expect(dto.feedback).toBe('down');
      expect(dto.retry).toEqual({ index: 1, count: 2 });
      expect(dto.html).toContain('A');
    }
  });

  it('flags canRegenerate only on the last answer that has a turn id', () => {
    const answer: AsstMsg = { kind: 'ai', text: 'done', turnId: 't1', feedback: null };
    const asLast = msgToDTO(answer, true);
    const notLast = msgToDTO(answer, false);
    expect(asLast.kind === 'ai' && asLast.streaming === false && asLast.canRegenerate).toBe(true);
    expect(
      notLast.kind === 'ai' && notLast.streaming === false && notLast.canRegenerate,
    ).toBeFalsy();
  });

  it('flags canRetry on an error bubble that remembers its failed text', () => {
    const errored: AsstMsg = { kind: 'ai', text: 'network down', error: true, failedText: 'q' };
    const dto = msgToDTO(errored, false);
    expect(dto.kind === 'ai' && dto.streaming === false && dto.error).toBe(true);
    expect(dto.kind === 'ai' && dto.streaming === false && dto.canRetry).toBe(true);
  });

  it('suppresses feedback + regenerate on read-only archived answers (issue #438)', () => {
    const archived: AsstMsg = {
      kind: 'ai',
      text: 'sealed',
      turnId: 't1',
      feedback: 'up',
      fromArchive: true,
    };
    const dto = msgToDTO(archived, true);
    if (dto.kind === 'ai' && dto.streaming === false) {
      // No turnId ⇒ the surface renders no feedback/regenerate control the
      // server would reject on a pruned (gone) turn.
      expect(dto.turnId).toBeUndefined();
      expect(dto.canRegenerate).toBeFalsy();
      expect(dto.copyText).toBe('sealed');
    }
  });
});
