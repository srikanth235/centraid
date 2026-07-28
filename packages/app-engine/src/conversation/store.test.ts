// Conversation rows, turn rows, and the search / pin / archive surface. Item,
// message_in, and attachment rows live in store-items.test.ts; retention
// pruning in store-prune.test.ts. Shared fixtures in store-test-fixtures.ts.

import { describe, expect, it } from 'vitest';
import { ConversationStore } from './store.js';
import { newProvider, newStore } from './store-test-fixtures.js';

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

  it('persists cumulative ACP usage beside the resume handle', () => {
    const store = newStore();
    const conv = store.createConversation({ kind: 'chat', userId: 'u1', appId: 'app' });
    expect(
      store.noteTurn(conv.id, 'u1', {
        kind: 'codex',
        sessionId: 'session-1',
        usageSnapshot: {
          inputTokens: 120,
          outputTokens: 30,
          cost: { amount: 0.4, currency: 'USD' },
        },
      }),
    ).toBe(true);
    expect(store.getConversation(conv.id)).toMatchObject({
      adapterKind: 'codex',
      adapterSessionId: 'session-1',
      adapterUsageSnapshot: {
        inputTokens: 120,
        outputTokens: 30,
        cost: { amount: 0.4, currency: 'USD' },
      },
    });
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

  it('keeps one durable conversation when an automation switches harness', () => {
    const store = newStore();
    const codex = store.ensureAutomationConversation('app/digest', 'app', 'Digest', 'codex');
    const claude = store.ensureAutomationConversation('app/digest', 'app', 'Digest', 'claude-code');
    expect(codex).toBe(claude);
    expect(store.getConversation(codex)).toMatchObject({
      automationId: 'app/digest',
      adapterKind: 'codex',
    });
    // Ensuring a new target does not claim it before a turn succeeds; the
    // ledger's post-turn adapter update is the binding commit point.
    expect(store.getConversation(claude)?.adapterKind).toBe('codex');
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

  it('deleteTurn removes an unfinished turn but refuses a finished one', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'automation', userId: '', automationId: 'app/a' });
    store.insertTurn({ turnId: 'r0', conversationId: c.id, triggerKind: 'manual', startedAt: 1 });
    store.finishTurn({ turnId: 'r0', endedAt: 2, ok: true });
    store.insertTurn({ turnId: 'r1', conversationId: c.id, triggerKind: 'manual', startedAt: 3 });

    // A finished turn is durable history: deleting it would hand its `seq` to
    // the next insert and alias the archive's seq_from/seq_to ranges.
    expect(store.deleteTurn('r0')).toBe(false);
    expect(store.getTurn('r0')).toBeDefined();

    // The interrupted newest turn is the retry path — its seq is recycled on
    // purpose, and nothing archived can be covering it.
    expect(store.deleteTurn('r1')).toBe(true);
    expect(store.getTurn('r1')).toBeUndefined();
    store.insertTurn({ turnId: 'r1', conversationId: c.id, triggerKind: 'manual', startedAt: 4 });
    expect(store.getTurn('r1')?.seq).toBe(1);
    store.close();
  });

  it('deleteTurn confines itself to the given owner when one is supplied', () => {
    const store = newStore();
    const mine = store.createConversation({ kind: 'chat', userId: 'u1' });
    const theirs = store.createConversation({ kind: 'chat', userId: 'u2' });
    store.insertTurn({
      turnId: 'a',
      conversationId: mine.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    store.insertTurn({
      turnId: 'b',
      conversationId: theirs.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });

    // A stray id must not reach across users.
    expect(store.deleteTurn('b', 'u1')).toBe(false);
    expect(store.getTurn('b')).toBeDefined();
    expect(store.deleteTurn('a', 'u1')).toBe(true);
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

  it('renews a turn-lock lease only for its current owner', () => {
    const store = newStore();
    const conversation = store.createConversation({ kind: 'chat', userId: 'u1' });
    const startedAt = 1_000;
    const refreshedAt = startedAt + 20 * 60_000;
    expect(store.acquireTurnLock(conversation.id, 'owner-a', startedAt)).toBe(true);
    expect(store.refreshTurnLock(conversation.id, 'owner-a', refreshedAt)).toBe(true);
    expect(store.acquireTurnLock(conversation.id, 'owner-b', startedAt + 31 * 60_000)).toBe(false);
    expect(store.acquireTurnLock(conversation.id, 'owner-b', refreshedAt + 30 * 60_000 + 1)).toBe(
      true,
    );
    expect(store.refreshTurnLock(conversation.id, 'owner-a', refreshedAt + 30 * 60_000 + 2)).toBe(
      false,
    );
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
