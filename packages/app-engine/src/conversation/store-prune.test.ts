import path from 'node:path';

import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';

import { makeJournalDbProvider } from '../stores/gateway-db.js';
import { ConversationStore } from './store.js';

function newStore(): ConversationStore {
  const dir = tempDirSync('centraid-conv-store-prune-');
  return new ConversationStore(makeJournalDbProvider(path.join(dir, 'journal.db')));
}

function seedAutomationTurn(
  store: ConversationStore,
  automationRef: string,
  turnId: string,
  startedAt: number,
  ok = true,
): void {
  const conversationId = store.ensureAutomationConversation(
    automationRef,
    automationRef.split('/')[0],
  );
  store.insertTurn({
    turnId,
    conversationId,
    triggerKind: 'scheduled',
    startedAt,
  });
  store.finishTurn({ turnId, endedAt: startedAt + 1, ok });
}

describe('ConversationStore — prune + delete', () => {
  /** Seed one fire turn + a tool item in the stable conversation. */
  function seedFire(store: ConversationStore, i: number, ok = true): void {
    const id = `r${i}`;
    const conversationId = store.ensureAutomationConversation('app/foo', 'app');
    store.insertTurn({
      turnId: id,
      conversationId,
      triggerKind: 'scheduled',
      startedAt: 100 + i,
    });
    store.finishTurn({ turnId: id, endedAt: 200 + i, ok });
    store.insertItem({
      itemId: `n-${i}`,
      turnId: id,
      ordinal: 0,
      kind: 'tool',
      name: 'a',
      ok: true,
      startedAt: 150 + i,
      endedAt: 151 + i,
      durationMs: 1,
    });
  }

  it('pruneAutomation by count keeps newest N fires and cascades; pinned survives', () => {
    const store = newStore();
    for (let i = 0; i < 6; i++) seedFire(store, i);
    store.setTurnPinned('r0', true);
    store.pruneAutomation('app/foo', { count: 2 });
    const remaining = store
      .listAutomationTurns('app/foo', { limit: 100 })
      .map((t) => t.turnId)
      .sort();
    expect(remaining).toStrictEqual(['r0', 'r4', 'r5']);
    expect(store.listItems('r1')).toHaveLength(0);
    expect(store.listItems('r5')).toHaveLength(1);
    store.close();
  });

  it('pruneAutomation errorsOnly drops successful fires; all=true is a no-op', () => {
    const store = newStore();
    for (let i = 0; i < 4; i++) seedFire(store, i, i % 2 === 0);
    store.pruneAutomation('app/foo', { errorsOnly: true });
    const remaining = store.listAutomationTurns('app/foo', { limit: 100 });
    expect(remaining).toHaveLength(2);
    for (const turn of remaining) expect(turn.ok).toBe(false);
    store.pruneAutomation('app/foo', { all: true });
    expect(store.listAutomationTurns('app/foo', { limit: 100 })).toHaveLength(2);
    store.close();
  });

  it('deleteAutomationData drops the stable conversation (cascade) + state, leaving others', () => {
    const store = newStore();
    seedAutomationTurn(store, 'app/a', 'a1', 1);
    seedAutomationTurn(store, 'app/b', 'b1', 1);
    store.insertMessageIn({
      turnId: 'a1',
      role: 'user',
      text: 'x',
      startedAt: 1,
    });
    store.stateSet('app/a', 'k', JSON.stringify('v'), 1);
    store.stateSet('app/b', 'k', JSON.stringify('v'), 1);
    store.deleteAutomationData('app/a');
    expect(store.listAutomationTurns('app/a')).toHaveLength(0);
    expect(store.listItems('a1')).toHaveLength(0);
    expect(store.stateGet('app/a', 'k')).toBeUndefined();
    expect(store.listAutomationTurns('app/b')).toHaveLength(1);
    expect(store.stateGet('app/b', 'k')).toBeTruthy();
    store.close();
  });

  it('deleteConversation (chat) is user-scoped and cascades items + attachments', () => {
    const store = newStore();
    const conversation = store.createConversation({
      kind: 'chat',
      userId: 'u1',
    });
    store.insertTurn({
      turnId: 't',
      conversationId: conversation.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    const itemId = store.insertMessageIn({
      turnId: 't',
      role: 'user',
      text: 'hi',
      startedAt: 1,
    });
    store.insertAttachment({
      itemId,
      hash: 'b'.repeat(64),
      mime: 'image/png',
      sizeBytes: 1,
    });
    expect(store.deleteConversation(conversation.id, 'other-user')).toBe(false);
    expect(store.deleteConversation(conversation.id, 'u1')).toBe(true);
    expect(store.listItems('t')).toHaveLength(0);
    expect(store.referencedHashes().size).toBe(0);
    store.close();
  });
});
