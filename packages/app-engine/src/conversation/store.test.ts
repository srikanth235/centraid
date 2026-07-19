import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { makeJournalDbProvider, type DatabaseProvider } from '../stores/gateway-db.js';
import { ConversationStore } from './store.js';

function newProvider(): DatabaseProvider {
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-conv-store-'));
  return makeJournalDbProvider(path.join(dir, 'journal.db'));
}

function newStore(): ConversationStore {
  return new ConversationStore(newProvider());
}

/** Seed one automation turn in its stable conversation. */
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

describe('ConversationStore — conversations', () => {
  it('creates + round-trips a conversation (kind/app/automation/title)', () => {
    const store = newStore();
    const conv = store.createConversation({
      kind: 'chat',
      userId: 'u1',
      appId: 'app',
      title: 'Hi',
    });
    const got = store.getConversation(conv.id);
    expect(got?.kind).toBe('chat');
    expect(got?.userId).toBe('u1');
    expect(got?.appId).toBe('app');
    expect(got?.title).toBe('Hi');
    expect(got?.turnCount).toBe(0);
    store.close();
  });

  it('ensureAutomationConversation reuses one conversation and refreshes its name', () => {
    const store = newStore();
    const first = store.ensureAutomationConversation('app/digest', 'app', 'Digest');
    const second = store.ensureAutomationConversation('app/digest', 'app', 'Morning digest');
    const a = store.getConversation('app/digest');
    expect(a?.kind).toBe('automation');
    expect(a?.automationId).toBe('app/digest');
    expect(a?.appId).toBe('app');
    expect(a?.title).toBe('Morning digest');
    expect(first).toBe('app/digest');
    expect(second).toBe(first);
    store.close();
  });

  it('listConversationsMeta returns chat/build threads with a transcript count', () => {
    const provider = newProvider();
    const store = new ConversationStore(provider);
    const c = store.createConversation({ kind: 'chat', userId: 'u1', appId: 'app' });
    store.ensureAutomationConversation('app/auto'); // automation — excluded from chat list
    store.insertTurn({
      turnId: 't1',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    store.insertMessageIn({ turnId: 't1', role: 'user', text: 'hello', startedAt: 1 });
    const list = store.listConversationsMeta('u1');
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(c.id);
    expect(list[0]?.messageCount).toBe(1);

    store.insertItem({
      itemId: 'i2',
      turnId: 't1',
      ordinal: 1,
      kind: 'step',
      ok: true,
      startedAt: 2,
      endedAt: 3,
      durationMs: 1,
    });
    expect(store.listConversationsMeta('u1')[0]?.messageCount).toBe(2);

    provider().prepare(`DELETE FROM items WHERE id = ?`).run('i2');
    expect(store.listConversationsMeta('u1')[0]?.messageCount).toBe(1);
    store.close();
  });
});

describe('ConversationStore — search / pin / archive (issue #420)', () => {
  let clock = 1000;
  /** Seed a chat conversation with one user message + a distinct updated_at. */
  function seedChat(
    store: ConversationStore,
    userId: string,
    title: string,
    userText: string,
  ): string {
    const c = store.createConversation({ kind: 'chat', userId, appId: '_assistant', title });
    store.insertTurn({
      turnId: `${c.id}-t`,
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    store.insertMessageIn({ turnId: `${c.id}-t`, role: 'user', text: userText, startedAt: 1 });
    // Distinct, increasing updated_at so newest-first ordering is deterministic
    // (real turns bump this; the test seeds it explicitly).
    store.touchConversation(c.id, userId, ++clock);
    return c.id;
  }

  it('searchConversations matches on title and on inbound message text with a snippet', () => {
    const store = newStore();
    const budgetId = seedChat(store, 'u1', 'Budget review', 'help me plan the quarterly budget');
    seedChat(store, 'u1', 'Trip ideas', 'where should we travel next summer');
    const byBody = store.searchConversations('u1', 'quarterly');
    expect(byBody.map((h) => h.id)).toEqual([budgetId]);
    expect(byBody[0]?.snippet).toContain('⟦');
    const byTitle = store.searchConversations('u1', 'budget');
    expect(byTitle.map((h) => h.id)).toEqual([budgetId]);
    store.close();
  });

  it('search is prefix-based, user-scoped, and skips archived threads', () => {
    const store = newStore();
    const mine = seedChat(store, 'u1', 'Travel plans', 'planning a trip');
    seedChat(store, 'u2', 'Other travel', 'their trip');
    expect(store.searchConversations('u1', 'trav').map((h) => h.id)).toEqual([mine]);
    store.setConversationArchived(mine, 'u1', true);
    expect(store.searchConversations('u1', 'trav')).toEqual([]);
    store.close();
  });

  it('search reflects a renamed title and a blank query returns nothing', () => {
    const store = newStore();
    const id = seedChat(store, 'u1', 'Untitled', 'the body text here');
    store.renameConversation(id, 'u1', 'Groceries list');
    expect(store.searchConversations('u1', 'groceries').map((h) => h.id)).toEqual([id]);
    expect(store.searchConversations('u1', '   ')).toEqual([]);
    store.close();
  });

  it('pin sorts pinned-first; archive orders archived last; both are user-scoped', () => {
    const store = newStore();
    const a = seedChat(store, 'u1', 'Alpha', 'a');
    const b = seedChat(store, 'u1', 'Beta', 'b');
    const c = seedChat(store, 'u1', 'Gamma', 'g');
    // Newest-first by default: c, b, a.
    expect(store.listConversationsMeta('u1').map((m) => m.id)).toEqual([c, b, a]);
    expect(store.setConversationPinned(a, 'u1', true)).toBe(true);
    expect(store.setConversationArchived(c, 'u1', true)).toBe(true);
    // Pinned a first, then unpinned b, then archived c last.
    expect(store.listConversationsMeta('u1').map((m) => m.id)).toEqual([a, b, c]);
    const metaA = store.getConversationMeta(a, 'u1');
    expect(metaA?.pinned).toBe(true);
    expect(store.getConversationMeta(c, 'u1')?.archived).toBe(true);
    expect(store.setConversationPinned(a, 'other', true)).toBe(false);
    store.close();
  });

  it('the FTS index survives a store reopen and backfills pre-existing rows', () => {
    const provider = newProvider();
    const s1 = new ConversationStore(provider);
    const id = seedChat(s1, 'u1', 'Reopen test', 'searchable needle body');
    s1.close();
    const s2 = new ConversationStore(provider);
    expect(s2.searchConversations('u1', 'needle').map((h) => h.id)).toEqual([id]);
    s2.close();
  });
});

describe('ConversationStore — turns', () => {
  it('insertTurn assigns sequential seq; finishTurn records outcome', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't0',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    store.insertTurn({
      turnId: 't1',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 2,
    });
    expect(store.getTurn('t0')?.seq).toBe(0);
    expect(store.getTurn('t1')?.seq).toBe(1);
    store.finishTurn({ turnId: 't1', endedAt: 3, ok: false, error: 'boom', summary: 's' });
    const t = store.getTurn('t1');
    expect(t?.ok).toBe(false);
    expect(t?.error).toBe('boom');
    expect(t?.summary).toBe('s');
    store.close();
  });

  it('finishTurn rolls up step/agent tokens + step/tool counts', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'automation', userId: '', automationId: 'app/a' });
    store.insertTurn({ turnId: 'r', conversationId: c.id, triggerKind: 'manual', startedAt: 1 });
    store.openItem({
      turnId: 'r',
      itemId: 'i1',
      ordinal: 0,
      kind: 'agent',
      name: 'agent',
      startedAt: 1,
    });
    store.closeItem({
      itemId: 'i1',
      ok: true,
      endedAt: 9,
      durationMs: 8,
      model: 'm',
      inputTokens: 100,
      outputTokens: 20,
    });
    store.insertItem({
      itemId: 'i2',
      turnId: 'r',
      ordinal: 1,
      kind: 'tool',
      name: 't',
      ok: true,
      startedAt: 2,
      endedAt: 3,
      durationMs: 1,
    });
    store.finishTurn({ turnId: 'r', endedAt: 10, ok: true });
    const t = store.getTurn('r');
    expect(t?.totalInputTokens).toBe(100);
    expect(t?.totalOutputTokens).toBe(20);
    expect(t?.stepCount).toBe(0);
    expect(t?.toolCount).toBe(1);
    store.close();
  });

  it('listTurnsFiltered supports status/since/limit and newest-first order', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    for (let i = 0; i < 5; i++) {
      const id = `r${i}`;
      store.insertTurn({
        turnId: id,
        conversationId: c.id,
        triggerKind: 'scheduled',
        startedAt: 100 + i,
      });
      store.finishTurn({ turnId: id, endedAt: 200 + i, ok: i !== 1 });
    }
    expect(store.listTurnsFiltered(c.id).length).toBe(5);
    expect(store.listTurnsFiltered(c.id, { status: 'ok' }).length).toBe(4);
    expect(store.listTurnsFiltered(c.id, { status: 'error' }).length).toBe(1);
    expect(store.listTurnsFiltered(c.id, { since: 103 }).length).toBe(2);
    expect(store.listTurnsFiltered(c.id, { limit: 2 }).map((t) => t.turnId)).toEqual(['r4', 'r3']);
    store.close();
  });
});

describe('ConversationStore — items + message_in', () => {
  it('insertMessageIn lands ordinal 0; listItems is ordinal-ordered', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    store.insertMessageIn({ turnId: 't', role: 'user', text: 'hi there', startedAt: 1 });
    store.insertItem({
      itemId: 's1',
      turnId: 't',
      ordinal: 1,
      kind: 'step',
      outputJson: JSON.stringify({ text: 'reply' }),
      ok: true,
      startedAt: 2,
      endedAt: 3,
      durationMs: 1,
    });
    const items = store.listItems('t');
    expect(items.map((i) => [i.kind, i.ordinal])).toEqual([
      ['message_in', 0],
      ['step', 1],
    ]);
    expect(items[0]?.text).toBe('hi there');
    expect(items[0]?.role).toBe('user');
    expect(store.messageInText('t')).toBe('hi there');
    store.close();
  });

  it('openItem lands an in-flight row; closeItem settles outcome + duration', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 0,
    });
    store.openItem({
      turnId: 't',
      itemId: 'n1',
      ordinal: 0,
      kind: 'tool',
      name: 'x',
      argsJson: '{"q":1}',
      startedAt: 10,
    });
    let [n] = store.listItems('t');
    expect(n?.endedAt).toBe(undefined);
    expect(n?.ok).toBe(true);
    store.closeItem({
      itemId: 'n1',
      ok: false,
      error: 'rate limited',
      endedAt: 35,
      durationMs: 25,
    });
    [n] = store.listItems('t');
    expect(store.listItems('t').length).toBe(1);
    expect(n?.ok).toBe(false);
    expect(n?.error).toBe('rate limited');
    expect(n?.argsJson).toBe('{"q":1}');
    store.close();
  });
});

describe('ConversationStore — attachments', () => {
  it('insertAttachment FKs to a message_in item; lists by item + turn; referencedHashes', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    const itemId = store.insertMessageIn({
      turnId: 't',
      role: 'user',
      text: 'see file',
      startedAt: 1,
    });
    store.insertAttachment({
      itemId,
      hash: 'a'.repeat(64),
      mime: 'image/png',
      sizeBytes: 12,
      source: 'upload',
      filename: 'pic.png',
    });
    const byItem = store.listAttachmentsForItem(itemId);
    expect(byItem.length).toBe(1);
    expect(byItem[0]?.mime).toBe('image/png');
    expect(byItem[0]?.filename).toBe('pic.png');
    expect(store.listAttachmentsForTurn('t').length).toBe(1);
    expect([...store.referencedHashes()]).toEqual(['a'.repeat(64)]);
    store.close();
  });
});

describe('ConversationStore — automation state', () => {
  it('get/set round-trips across reopens and is scoped per automation', () => {
    const provider = newProvider();
    const s1 = new ConversationStore(provider);
    s1.stateSet('auto-foo', 'cursor', JSON.stringify({ since: 42 }), 1000);
    s1.stateSet('auto-bar', 'cursor', JSON.stringify('B'), 1);
    s1.close();
    const s2 = new ConversationStore(provider);
    expect(s2.stateGet('auto-foo', 'cursor')?.valueJson).toBe(JSON.stringify({ since: 42 }));
    expect(s2.stateGet('auto-bar', 'cursor')?.valueJson).toBe(JSON.stringify('B'));
    s2.stateDelete('auto-foo', 'cursor');
    expect(s2.stateGet('auto-foo', 'cursor')).toBe(undefined);
    s2.close();
  });
});

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
    expect(remaining).toEqual(['r0', 'r4', 'r5']);
    expect(store.listItems('r1').length).toBe(0);
    expect(store.listItems('r5').length).toBe(1);
    store.close();
  });

  it('pruneAutomation errorsOnly drops successful fires; all=true is a no-op', () => {
    const store = newStore();
    for (let i = 0; i < 4; i++) seedFire(store, i, i % 2 === 0);
    store.pruneAutomation('app/foo', { errorsOnly: true });
    const remaining = store.listAutomationTurns('app/foo', { limit: 100 });
    expect(remaining.length).toBe(2);
    for (const t of remaining) expect(t.ok).toBe(false);
    store.pruneAutomation('app/foo', { all: true });
    expect(store.listAutomationTurns('app/foo', { limit: 100 }).length).toBe(2);
    store.close();
  });

  it('deleteAutomationData drops the stable conversation (cascade) + state, leaving others', () => {
    const store = newStore();
    seedAutomationTurn(store, 'app/a', 'a1', 1);
    seedAutomationTurn(store, 'app/b', 'b1', 1);
    store.insertMessageIn({ turnId: 'a1', role: 'user', text: 'x', startedAt: 1 });
    store.stateSet('app/a', 'k', JSON.stringify('v'), 1);
    store.stateSet('app/b', 'k', JSON.stringify('v'), 1);
    store.deleteAutomationData('app/a');
    expect(store.listAutomationTurns('app/a').length).toBe(0);
    expect(store.listItems('a1').length).toBe(0);
    expect(store.stateGet('app/a', 'k')).toBe(undefined);
    expect(store.listAutomationTurns('app/b').length).toBe(1);
    expect(store.stateGet('app/b', 'k')).toBeTruthy();
    store.close();
  });

  it('deleteConversation (chat) is user-scoped and cascades items + attachments', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    const itemId = store.insertMessageIn({ turnId: 't', role: 'user', text: 'hi', startedAt: 1 });
    store.insertAttachment({ itemId, hash: 'b'.repeat(64), mime: 'image/png', sizeBytes: 1 });
    expect(store.deleteConversation(c.id, 'other-user')).toBe(false);
    expect(store.deleteConversation(c.id, 'u1')).toBe(true);
    expect(store.listItems('t').length).toBe(0);
    expect(store.referencedHashes().size).toBe(0);
    store.close();
  });
});
