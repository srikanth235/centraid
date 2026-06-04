import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { makeRuntimeDbProvider, type DatabaseProvider } from '../stores/gateway-db.js';
import { ConversationStore } from './store.js';

function newProvider(): DatabaseProvider {
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-conv-store-'));
  return makeRuntimeDbProvider(path.join(dir, 'runtime.sqlite'));
}

function newStore(): ConversationStore {
  return new ConversationStore(newProvider());
}

/** Seed one automation fire: its own execution conversation + a finished turn. */
function seedAutomationTurn(
  store: ConversationStore,
  automationRef: string,
  turnId: string,
  startedAt: number,
  ok = true,
): void {
  store.createAutomationRun(`conv-${turnId}`, automationRef, automationRef.split('/')[0]);
  store.insertTurn({
    turnId,
    conversationId: `conv-${turnId}`,
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
    assert.equal(got?.kind, 'chat');
    assert.equal(got?.userId, 'u1');
    assert.equal(got?.appId, 'app');
    assert.equal(got?.title, 'Hi');
    assert.equal(got?.turnCount, 0);
    store.close();
  });

  it('createAutomationRun makes a fresh execution conversation per fire, grouped by ref', () => {
    const store = newStore();
    store.createAutomationRun('c1', 'app/digest', 'app');
    store.createAutomationRun('c2', 'app/digest', 'app');
    const a = store.getConversation('c1');
    const b = store.getConversation('c2');
    assert.equal(a?.kind, 'automation');
    assert.equal(a?.automationId, 'app/digest');
    assert.equal(a?.appId, 'app');
    assert.equal(b?.automationId, 'app/digest');
    assert.notEqual(a?.id, b?.id, 're-firing makes a new conversation, not one reused thread');
    store.close();
  });

  it('listConversationsMeta returns chat/build threads with a transcript count', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1', appId: 'app' });
    store.createAutomationRun('auto-conv', 'app/auto'); // automation — excluded from chat list
    store.insertTurn({
      turnId: 't1',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 1,
    });
    store.insertMessageIn({ turnId: 't1', role: 'user', text: 'hello', startedAt: 1 });
    const list = store.listConversationsMeta('u1');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, c.id);
    assert.equal(list[0]?.messageCount, 1);
    store.close();
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
    assert.equal(store.getTurn('t0')?.seq, 0);
    assert.equal(store.getTurn('t1')?.seq, 1);
    store.finishTurn({ turnId: 't1', endedAt: 3, ok: false, error: 'boom', summary: 's' });
    const t = store.getTurn('t1');
    assert.equal(t?.ok, false);
    assert.equal(t?.error, 'boom');
    assert.equal(t?.summary, 's');
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
    assert.equal(t?.totalInputTokens, 100);
    assert.equal(t?.totalOutputTokens, 20);
    assert.equal(t?.stepCount, 0);
    assert.equal(t?.toolCount, 1);
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
    assert.equal(store.listTurnsFiltered(c.id).length, 5);
    assert.equal(store.listTurnsFiltered(c.id, { status: 'ok' }).length, 4);
    assert.equal(store.listTurnsFiltered(c.id, { status: 'error' }).length, 1);
    assert.equal(store.listTurnsFiltered(c.id, { since: 103 }).length, 2);
    assert.deepEqual(
      store.listTurnsFiltered(c.id, { limit: 2 }).map((t) => t.turnId),
      ['r4', 'r3'],
    );
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
    assert.deepEqual(
      items.map((i) => [i.kind, i.ordinal]),
      [
        ['message_in', 0],
        ['step', 1],
      ],
    );
    assert.equal(items[0]?.text, 'hi there');
    assert.equal(items[0]?.role, 'user');
    assert.equal(store.messageInText('t'), 'hi there');
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
    assert.equal(n?.endedAt, undefined);
    assert.equal(n?.ok, true);
    store.closeItem({
      itemId: 'n1',
      ok: false,
      error: 'rate limited',
      endedAt: 35,
      durationMs: 25,
    });
    [n] = store.listItems('t');
    assert.equal(store.listItems('t').length, 1, 'closeItem updates, never inserts');
    assert.equal(n?.ok, false);
    assert.equal(n?.error, 'rate limited');
    assert.equal(n?.argsJson, '{"q":1}');
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
    assert.equal(byItem.length, 1);
    assert.equal(byItem[0]?.mime, 'image/png');
    assert.equal(byItem[0]?.filename, 'pic.png');
    assert.equal(store.listAttachmentsForTurn('t').length, 1);
    assert.deepEqual([...store.referencedHashes()], ['a'.repeat(64)]);
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
    assert.equal(s2.stateGet('auto-foo', 'cursor')?.valueJson, JSON.stringify({ since: 42 }));
    assert.equal(s2.stateGet('auto-bar', 'cursor')?.valueJson, JSON.stringify('B'));
    s2.stateDelete('auto-foo', 'cursor');
    assert.equal(s2.stateGet('auto-foo', 'cursor'), undefined);
    s2.close();
  });
});

describe('ConversationStore — prune + delete', () => {
  /** Seed one fire (its own execution conversation + turn + a tool item). */
  function seedFire(store: ConversationStore, i: number, ok = true): void {
    const id = `r${i}`;
    store.createAutomationRun(`c${i}`, 'app/foo', 'app');
    store.insertTurn({
      turnId: id,
      conversationId: `c${i}`,
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
    assert.deepEqual(remaining, ['r0', 'r4', 'r5'], 'pinned r0 survives count pruning');
    assert.equal(store.listItems('r1').length, 0, 'pruned fire items cascade away');
    assert.equal(store.listItems('r5').length, 1);
    store.close();
  });

  it('pruneAutomation errorsOnly drops successful fires; all=true is a no-op', () => {
    const store = newStore();
    for (let i = 0; i < 4; i++) seedFire(store, i, i % 2 === 0);
    store.pruneAutomation('app/foo', { errorsOnly: true });
    const remaining = store.listAutomationTurns('app/foo', { limit: 100 });
    assert.equal(remaining.length, 2);
    for (const t of remaining) assert.equal(t.ok, false);
    store.pruneAutomation('app/foo', { all: true });
    assert.equal(store.listAutomationTurns('app/foo', { limit: 100 }).length, 2);
    store.close();
  });

  it('deleteAutomationData drops every execution conversation (cascade) + state, leaving others', () => {
    const store = newStore();
    seedAutomationTurn(store, 'app/a', 'a1', 1);
    seedAutomationTurn(store, 'app/b', 'b1', 1);
    store.insertMessageIn({ turnId: 'a1', role: 'user', text: 'x', startedAt: 1 });
    store.stateSet('app/a', 'k', JSON.stringify('v'), 1);
    store.stateSet('app/b', 'k', JSON.stringify('v'), 1);
    store.deleteAutomationData('app/a');
    assert.equal(store.listAutomationTurns('app/a').length, 0);
    assert.equal(store.listItems('a1').length, 0, 'items cascade with the conversation');
    assert.equal(store.stateGet('app/a', 'k'), undefined);
    assert.equal(store.listAutomationTurns('app/b').length, 1);
    assert.ok(store.stateGet('app/b', 'k'));
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
    assert.equal(
      store.deleteConversation(c.id, 'other-user'),
      false,
      'cross-user delete is a no-op',
    );
    assert.equal(store.deleteConversation(c.id, 'u1'), true);
    assert.equal(store.listItems('t').length, 0);
    assert.equal(store.referencedHashes().size, 0, 'attachment rows cascade away');
    store.close();
  });
});
