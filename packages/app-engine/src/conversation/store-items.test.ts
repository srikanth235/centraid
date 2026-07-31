// ConversationStore item rows: message_in landing at ordinal 0, the
// openItem/closeItem lifecycle, the 64 KiB raw-envelope cap, and attachment
// rows hanging off a message_in item. Conversation / turn / search behaviour
// stays in store.test.ts. Split from store.test.ts (500-line repo-hygiene cap);
// shared fixtures in store-test-fixtures.ts.

import type { StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { DatabaseProvider } from "../stores/gateway-db.js";
import { newProvider, newStore } from "./store-test-fixtures.js";
import { ConversationStore } from "./store.js";
import type { TurnWindow } from "./store.js";

describe("ConversationStore — items + message_in", () => {
  it("insertMessageIn lands ordinal 0; listItems is ordinal-ordered", () => {
    const store = newStore();
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    store.insertTurn({
      turnId: "t",
      conversationId: c.id,
      triggerKind: "interactive",
      startedAt: 1,
    });
    store.insertMessageIn({
      turnId: "t",
      role: "user",
      text: "hi there",
      startedAt: 1,
    });
    store.insertItem({
      itemId: "s1",
      turnId: "t",
      ordinal: 1,
      kind: "step",
      outputJson: JSON.stringify({ text: "reply" }),
      ok: true,
      startedAt: 2,
      endedAt: 3,
      durationMs: 1,
    });
    const items = store.listItems("t");
    expect(items.map((i) => [i.kind, i.ordinal])).toStrictEqual([
      ["message_in", 0],
      ["step", 1],
    ]);
    expect(items[0]?.text).toBe("hi there");
    expect(items[0]?.role).toBe("user");
    expect(store.messageInText("t")).toBe("hi there");
    store.close();
  });

  it("openItem lands an in-flight row; closeItem settles outcome + duration", () => {
    const store = newStore();
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    store.insertTurn({
      turnId: "t",
      conversationId: c.id,
      triggerKind: "interactive",
      startedAt: 0,
    });
    store.openItem({
      turnId: "t",
      itemId: "n1",
      ordinal: 0,
      callId: "call-1",
      kind: "tool",
      name: "x",
      argsJson: '{"q":1}',
      rawJson: '{"phase":"start"}',
      startedAt: 10,
    });
    let [n] = store.listItems("t");
    expect(n?.endedAt).toBeUndefined();
    expect(n?.ok).toBe(true);
    store.closeItem({
      itemId: "n1",
      ok: false,
      error: "rate limited",
      rawJson: '{"phase":"result"}',
      endedAt: 35,
      durationMs: 25,
    });
    [n] = store.listItems("t");
    expect(store.listItems("t")).toHaveLength(1);
    expect(n?.ok).toBe(false);
    expect(n?.error).toBe("rate limited");
    expect(n?.argsJson).toBe('{"q":1}');
    expect(n?.callId).toBe("call-1");
    expect(n?.rawJson).toBe('{"phase":"result"}');
    store.close();
  });

  it("caps an oversized raw envelope but keeps its forensic identifiers", () => {
    const store = newStore();
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    store.insertTurn({
      turnId: "t",
      conversationId: c.id,
      triggerKind: "interactive",
      startedAt: 0,
    });
    // The ACP envelope around a whole-file read: identifiers plus megabytes of
    // content, written once at open and once at close.
    const huge = JSON.stringify({
      toolCallId: "call-9",
      stopReason: "end_turn",
      status: "completed",
      attempt: 2,
      ok: true,
      content: [{ type: "text", text: "x".repeat(3_000_000) }],
    });
    store.openItem({
      turnId: "t",
      itemId: "n1",
      ordinal: 0,
      kind: "tool",
      rawJson: huge,
      startedAt: 0,
    });
    store.closeItem({
      itemId: "n1",
      ok: true,
      rawJson: huge,
      endedAt: 1,
      durationMs: 1,
    });

    const [item] = store.listItems("t");
    const raw = item?.rawJson ?? "";
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64 * 1024);
    // Stop-reason / callId forensics survive; the payload that blew the cap
    // does not, and the row says so rather than pretending to be complete.
    expect(JSON.parse(raw)).toMatchObject({
      toolCallId: "call-9",
      stopReason: "end_turn",
      status: "completed",
      attempt: 2,
      ok: true,
      rawTruncated: true,
    });
    expect(raw).not.toContain("xxxxx");
    store.close();
  });

  it("records an oversized non-JSON envelope as a bare truncation marker", () => {
    const store = newStore();
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    store.insertTurn({
      turnId: "t",
      conversationId: c.id,
      triggerKind: "interactive",
      startedAt: 0,
    });
    store.insertItem({
      itemId: "n1",
      turnId: "t",
      ordinal: 0,
      kind: "tool",
      rawJson: "y".repeat(200_000),
      ok: true,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    const [item] = store.listItems("t");
    expect(JSON.parse(item?.rawJson ?? "")).toStrictEqual({
      rawTruncated: true,
      rawOriginalBytes: 200_000,
    });
    store.close();
  });

  it("writes a raw envelope under the cap through verbatim", () => {
    const store = newStore();
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    store.insertTurn({
      turnId: "t",
      conversationId: c.id,
      triggerKind: "interactive",
      startedAt: 0,
    });
    const raw = JSON.stringify({ content: [{ text: "z".repeat(1000) }] });
    store.insertItem({
      itemId: "n1",
      turnId: "t",
      ordinal: 0,
      kind: "tool",
      rawJson: raw,
      ok: true,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    expect(store.listItems("t")[0]?.rawJson).toBe(raw);
    store.close();
  });
});

describe("ConversationStore — attachments", () => {
  it("insertAttachment FKs to a message_in item; lists by item + turn; referencedHashes", () => {
    const store = newStore();
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    store.insertTurn({
      turnId: "t",
      conversationId: c.id,
      triggerKind: "interactive",
      startedAt: 1,
    });
    const itemId = store.insertMessageIn({
      turnId: "t",
      role: "user",
      text: "see file",
      startedAt: 1,
    });
    store.insertAttachment({
      itemId,
      hash: "a".repeat(64),
      mime: "image/png",
      sizeBytes: 12,
      source: "upload",
      filename: "pic.png",
    });
    const byItem = store.listAttachmentsForItem(itemId);
    expect(byItem).toHaveLength(1);
    expect(byItem[0]?.mime).toBe("image/png");
    expect(byItem[0]?.filename).toBe("pic.png");
    expect(store.listAttachmentsForTurn("t")).toHaveLength(1);
    expect([...store.referencedHashes()]).toStrictEqual(["a".repeat(64)]);
    store.close();
  });
});

// Issue #659 G5: reading a transcript used to run one items query per turn and
// one attachments query per message. These are the batched replacements — the
// law is that they return exactly what the per-row reads returned, and that
// their statement count does not grow with the number of turns.
describe("ConversationStore — conversation-wide batched reads (#659 G5)", () => {
  /** A provider that counts every executed read, so "N+1" is measurable. */
  function countingProvider(): {
    provider: DatabaseProvider;
    reads: () => number;
  } {
    const base = newProvider();
    let reads = 0;
    const wrapStatement = (statement: StatementSync): StatementSync =>
      new Proxy(statement, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== "function") return value;
          const bound = value.bind(target) as (...args: unknown[]) => unknown;
          if (prop !== "all" && prop !== "get") return bound;
          return (...args: unknown[]): unknown => {
            reads += 1;
            return bound(...args);
          };
        },
      });
    const provider: DatabaseProvider = () => {
      const db = base();
      return new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== "function") return value;
          const bound = value.bind(target) as (...args: unknown[]) => unknown;
          if (prop !== "prepare") return bound;
          return (...args: unknown[]): StatementSync =>
            wrapStatement(bound(...args) as StatementSync);
        },
      }) as unknown as ReturnType<DatabaseProvider>;
    };
    return { provider, reads: () => reads };
  }

  function seedThread(store: ConversationStore, turnCount: number): string {
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    for (let index = 0; index < turnCount; index++) {
      const turnId = `t${index}`;
      store.insertTurn({
        turnId,
        conversationId: c.id,
        triggerKind: "interactive",
        startedAt: index + 1,
      });
      const itemId = store.insertMessageIn({
        turnId,
        role: "user",
        text: `hello ${index}`,
        startedAt: index + 1,
      });
      if (index % 3 === 0) {
        store.insertAttachment({
          itemId,
          hash: `hash-${index}`,
          mime: "image/png",
          sizeBytes: 10 + index,
        });
      }
    }
    return c.id;
  }

  it("group items and attachments exactly as the per-turn / per-item reads do", () => {
    const store = newStore();
    const conversationId = seedThread(store, 12);
    const turns = store.listTurns(conversationId);
    expect(turns).toHaveLength(12);

    const batchedItems = store.listItemsByTurn(conversationId);
    for (const turn of turns) {
      expect(batchedItems.get(turn.turnId)).toStrictEqual(
        store.listItems(turn.turnId)
      );
    }
    // No stray turns in the batch beyond the ones the conversation owns.
    expect([...batchedItems.keys()].sort()).toStrictEqual(
      turns.map((t) => t.turnId).sort()
    );

    const batchedAttachments = store.listAttachmentsByItem(conversationId);
    for (const [, items] of batchedItems) {
      for (const item of items) {
        expect(batchedAttachments.get(item.itemId) ?? []).toStrictEqual(
          store.listAttachmentsForItem(item.itemId)
        );
      }
    }
    store.close();
  });

  it("read the whole transcript in a fixed number of queries, whatever its length", () => {
    const readsFor = (turnCount: number): number => {
      const { provider, reads } = countingProvider();
      const store = new ConversationStore(provider);
      const conversationId = seedThread(store, turnCount);
      const before = reads();
      store.listTurns(conversationId);
      store.listItemsByTurn(conversationId);
      store.listAttachmentsByItem(conversationId);
      const after = reads();
      store.close();
      return after - before;
    };
    expect(readsFor(4)).toBe(3);
    expect(readsFor(80)).toBe(3);
  });
});

// Issue #659 G5: the first cut of the transcript cap was `ORDER BY seq ASC
// LIMIT ?`, which returns the OLDEST N. Paginating with it would have shown a
// reader the beginning of their conversation and hidden the recent part — the
// same failure mode as the slow load it was meant to replace, but silent.
describe("ConversationStore — transcript window (#659 G5)", () => {
  function seedTurns(store: ConversationStore, count: number): string {
    const c = store.createConversation({ kind: "chat", userId: "u1" });
    for (let index = 0; index < count; index += 1) {
      const turnId = `t${index}`;
      store.insertTurn({
        turnId,
        conversationId: c.id,
        triggerKind: "interactive",
        startedAt: index + 1,
      });
      store.insertMessageIn({
        turnId,
        role: "user",
        text: `message ${index}`,
        startedAt: index + 1,
      });
    }
    return c.id;
  }

  it("returns the NEWEST turns, not the oldest — the end a reader opens to", () => {
    const store = newStore();
    const conversationId = seedTurns(store, 20);

    const page = store.listTurnWindow(conversationId, { limit: 5 });
    // Oldest-first WITHIN the window, but the window is the tail.
    expect(page.turns.map((t) => t.seq)).toStrictEqual([15, 16, 17, 18, 19]);
    expect(page.oldestSeq).toBe(15);
    expect(page.hasMore).toBe(true);
    // The precise regression: seq 0 must not be in a 5-turn window of 20.
    expect(page.turns.map((t) => t.turnId)).not.toContain("t0");
    store.close();
  });

  it("walks strictly backwards with beforeSeq — no gaps, no repeats", () => {
    const store = newStore();
    const conversationId = seedTurns(store, 23);

    // Collect the pages, then assert on them — the walk itself makes no
    // assertions, so nothing here depends on a branch being taken.
    const pageSeqs: number[][] = [];
    let cursor: number | undefined;
    let exhausted = false;
    // The bound is the termination guard: if paging ever fails to reach the
    // oldest turn, `exhausted` stays false and the assertion below says so.
    for (let guard = 0; guard < 10 && !exhausted; guard += 1) {
      const page: TurnWindow = store.listTurnWindow(conversationId, {
        limit: 5,
        ...(cursor === undefined ? {} : { beforeSeq: cursor }),
      });
      pageSeqs.push(page.turns.map((t) => t.seq));
      cursor = page.oldestSeq;
      exhausted = !page.hasMore;
    }
    expect(exhausted).toBe(true);

    // Exact page boundaries: strictly backwards, contiguous within a page, and
    // 5+5+5+5+3. This subsumes the old per-page "older than its cursor" check
    // and is stronger — it pins WHICH turns each page held, not just that the
    // maximum moved down.
    expect(pageSeqs).toStrictEqual([
      [18, 19, 20, 21, 22],
      [13, 14, 15, 16, 17],
      [8, 9, 10, 11, 12],
      [3, 4, 5, 6, 7],
      [0, 1, 2],
    ]);

    // Every turn exactly once, in order: no gaps and no repeats.
    const seen = pageSeqs.toReversed().flat();
    expect(seen).toStrictEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(new Set(seen).size).toBe(23);
    store.close();
  });

  it("reports hasMore false exactly at the oldest turn", () => {
    const store = newStore();
    const conversationId = seedTurns(store, 10);

    // A window that reaches turn 0 is the end of the thread…
    const atOldest = store.listTurnWindow(conversationId, {
      beforeSeq: 4,
      limit: 4,
    });
    expect(atOldest.turns.map((t) => t.seq)).toStrictEqual([0, 1, 2, 3]);
    expect(atOldest.hasMore).toBe(false);

    // …one turn shy of it is not.
    const oneShort = store.listTurnWindow(conversationId, {
      beforeSeq: 4,
      limit: 3,
    });
    expect(oneShort.turns.map((t) => t.seq)).toStrictEqual([1, 2, 3]);
    expect(oneShort.hasMore).toBe(true);

    // A window larger than the whole thread is also the end of it.
    const whole = store.listTurnWindow(conversationId, { limit: 500 });
    expect(whole.turns).toHaveLength(10);
    expect(whole.hasMore).toBe(false);
    expect(whole.oldestSeq).toBe(0);

    // And an empty conversation reports no more and no cursor.
    const empty = store.createConversation({ kind: "chat", userId: "u1" });
    const none = store.listTurnWindow(empty.id);
    expect(none.turns).toStrictEqual([]);
    expect(none.hasMore).toBe(false);
    expect(none.oldestSeq).toBeUndefined();
    store.close();
  });

  it("scopes the batched item read to the window, not the whole thread", () => {
    const store = newStore();
    const conversationId = seedTurns(store, 20);
    const page = store.listTurnWindow(conversationId, { limit: 5 });
    const items = store.listItemsByTurn(conversationId, {
      fromSeq: page.turns[0]!.seq,
      toSeq: page.turns.at(-1)!.seq,
    });
    // Five turns' items, not twenty — batching and windowing compose.
    expect(items.size).toBe(5);
    expect([...items.keys()].sort()).toStrictEqual(
      page.turns.map((t) => t.turnId).sort()
    );
    store.close();
  });
});
