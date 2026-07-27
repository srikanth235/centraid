// ConversationStore item rows: message_in landing at ordinal 0, the
// openItem/closeItem lifecycle, the 64 KiB raw-envelope cap, and attachment
// rows hanging off a message_in item. Conversation / turn / search behaviour
// stays in store.test.ts. Split from store.test.ts (500-line repo-hygiene cap);
// shared fixtures in store-test-fixtures.ts.

import { describe, expect, it } from 'vitest';
import { newStore } from './store-test-fixtures.js';

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
    expect(items.map((i) => [i.kind, i.ordinal])).toStrictEqual([
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
      callId: 'call-1',
      kind: 'tool',
      name: 'x',
      argsJson: '{"q":1}',
      rawJson: '{"phase":"start"}',
      startedAt: 10,
    });
    let [n] = store.listItems('t');
    expect(n?.endedAt).toBeUndefined();
    expect(n?.ok).toBe(true);
    store.closeItem({
      itemId: 'n1',
      ok: false,
      error: 'rate limited',
      rawJson: '{"phase":"result"}',
      endedAt: 35,
      durationMs: 25,
    });
    [n] = store.listItems('t');
    expect(store.listItems('t')).toHaveLength(1);
    expect(n?.ok).toBe(false);
    expect(n?.error).toBe('rate limited');
    expect(n?.argsJson).toBe('{"q":1}');
    expect(n?.callId).toBe('call-1');
    expect(n?.rawJson).toBe('{"phase":"result"}');
    store.close();
  });

  it('caps an oversized raw envelope but keeps its forensic identifiers', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 0,
    });
    // The ACP envelope around a whole-file read: identifiers plus megabytes of
    // content, written once at open and once at close.
    const huge = JSON.stringify({
      toolCallId: 'call-9',
      stopReason: 'end_turn',
      status: 'completed',
      attempt: 2,
      ok: true,
      content: [{ type: 'text', text: 'x'.repeat(3_000_000) }],
    });
    store.openItem({
      turnId: 't',
      itemId: 'n1',
      ordinal: 0,
      kind: 'tool',
      rawJson: huge,
      startedAt: 0,
    });
    store.closeItem({ itemId: 'n1', ok: true, rawJson: huge, endedAt: 1, durationMs: 1 });

    const [item] = store.listItems('t');
    const raw = item?.rawJson ?? '';
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    // Stop-reason / callId forensics survive; the payload that blew the cap
    // does not, and the row says so rather than pretending to be complete.
    expect(JSON.parse(raw)).toMatchObject({
      toolCallId: 'call-9',
      stopReason: 'end_turn',
      status: 'completed',
      attempt: 2,
      ok: true,
      rawTruncated: true,
    });
    expect(raw).not.toContain('xxxxx');
    store.close();
  });

  it('records an oversized non-JSON envelope as a bare truncation marker', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 0,
    });
    store.insertItem({
      itemId: 'n1',
      turnId: 't',
      ordinal: 0,
      kind: 'tool',
      rawJson: 'y'.repeat(200_000),
      ok: true,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    const [item] = store.listItems('t');
    expect(JSON.parse(item?.rawJson ?? '')).toStrictEqual({
      rawTruncated: true,
      rawOriginalBytes: 200_000,
    });
    store.close();
  });

  it('writes a raw envelope under the cap through verbatim', () => {
    const store = newStore();
    const c = store.createConversation({ kind: 'chat', userId: 'u1' });
    store.insertTurn({
      turnId: 't',
      conversationId: c.id,
      triggerKind: 'interactive',
      startedAt: 0,
    });
    const raw = JSON.stringify({ content: [{ text: 'z'.repeat(1000) }] });
    store.insertItem({
      itemId: 'n1',
      turnId: 't',
      ordinal: 0,
      kind: 'tool',
      rawJson: raw,
      ok: true,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    expect(store.listItems('t')[0]?.rawJson).toBe(raw);
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
    expect(byItem).toHaveLength(1);
    expect(byItem[0]?.mime).toBe('image/png');
    expect(byItem[0]?.filename).toBe('pic.png');
    expect(store.listAttachmentsForTurn('t')).toHaveLength(1);
    expect([...store.referencedHashes()]).toStrictEqual(['a'.repeat(64)]);
    store.close();
  });
});
