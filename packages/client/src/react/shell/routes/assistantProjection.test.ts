import { describe, expect, it, vi } from "vitest";

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import { createTranscriptProjection } from "./assistantProjection.js";
import { hydrateMessages } from "./assistantTranscript.js";
import type { AsstMsg } from "./assistantTranscript.js";

// The rich-answer renderer pulls in the auth-aware ref resolver; stub it as
// assistantTranscript's own test does (the projection never calls it).
vi.mock(import("../../../gateway-client.js"), () => ({
  resolveAssistantRefs: vi.fn<typeof TypeImport_1gl5zx7.resolveAssistantRefs>(),
}));

const user = (text: string): AsstMsg => ({ kind: "user", text });
const answer = (text: string): AsstMsg => ({ kind: "ai", text });

describe(createTranscriptProjection, () => {
  it("returns the identical array when nothing in the model changed", () => {
    const projection = createTranscriptProjection();
    const msgs = [user("hi"), answer("hello")];
    expect(projection.project(msgs, 1)).toBe(projection.project(msgs, 1));
  });

  it("keeps unchanged rows referentially stable when one row changes", () => {
    const projection = createTranscriptProjection();
    const first = user("hi");
    const streaming: AsstMsg = { kind: "ai", text: "he", streaming: true };
    const before = projection.project([first, streaming], -1);
    streaming.text = "hell";
    const after = projection.project([first, streaming], -1);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("notices an in-place mutation of a message the model reused", () => {
    const projection = createTranscriptProjection();
    const streaming: AsstMsg = { kind: "ai", text: "a", streaming: true };
    projection.project([streaming], -1);
    streaming.text = "ab";
    const [dto] = projection.project([streaming], -1);
    expect(dto).toMatchObject({ kind: "ai", streaming: true, text: "ab" });
  });

  it("keeps a row's id when another row is spliced in above it", () => {
    const projection = createTranscriptProjection();
    const ask = user("hi");
    const reply = answer("hello");
    const before = projection.project([ask, reply], 1);
    const tools: AsstMsg = { kind: "tools", calls: [] };
    const after = projection.project([ask, tools, reply], 2);
    expect(after[2]?.msgId).toBe(before[1]?.msgId);
    expect(after[0]?.msgId).toBe(before[0]?.msgId);
  });

  it("gives every row a distinct id, including equal-looking siblings", () => {
    const projection = createTranscriptProjection();
    const rows = projection.project([user("same"), user("same")], -1);
    expect(rows[0]?.msgId).not.toBe(rows[1]?.msgId);
  });

  // The backfill case (issue #659). Older turns arriving at the FRONT of the
  // model — a "show earlier" expansion today, a server-paged fetch later —
  // must not disturb what is already on screen. If it did, every mounted row
  // would re-render and re-hydrate its refs and copy buttons at the exact
  // moment the reader is scrolling, which is the loudest possible way for this
  // to regress.
  it("keeps rendered rows identical when older messages are prepended", () => {
    const projection = createTranscriptProjection();
    const ask = user("hi");
    const reply = answer("hello");
    const before = projection.project([ask, reply], 1);

    const older = [user("older ask"), answer("older reply")];
    const after = projection.project([...older, ask, reply], 3);

    expect(after).toHaveLength(4);
    expect(after[2]).toBe(before[0]);
    expect(after[3]).toBe(before[1]);
  });

  it("keeps rendered rows' ids stable across a prepend", () => {
    const projection = createTranscriptProjection();
    const ask = user("hi");
    const before = projection.project([ask], -1);
    const after = projection.project([user("older"), ask], -1);
    expect(after[1]?.msgId).toBe(before[0]?.msgId);
    expect(after[0]?.msgId).not.toBe(before[0]?.msgId);
  });

  it("still tracks the regenerate target through a prepend that shifts indices", () => {
    const projection = createTranscriptProjection();
    const reply: AsstMsg = { kind: "ai", text: "done", turnId: "turn-1" };
    const before = projection.project([reply], 0);
    expect(before[0]).toMatchObject({ canRegenerate: true });

    // The same message is still the last answer — only its index moved — so it
    // must keep both its identity and its Regenerate control.
    const after = projection.project([user("older"), reply], 1);
    expect(after[1]).toBe(before[0]);
    expect(after[1]).toMatchObject({ canRegenerate: true });
  });

  // The path that will actually run (issue #659 G5). The three cases above use
  // synthetic arrays; this one drives the projection with rows shaped like the
  // gateway's own paged response and hydrated through the real codec, because
  // that is what `AssistantRoute.loadEarlier` prepends. The gateway's contract
  // is that a `beforeSeq` reply carries ONLY that page — so the client
  // concatenates page + held, and every held object survives untouched.
  describe("server-paged backfill", () => {
    const wireRows = (
      texts: string[],
      startedAt: number
    ): Array<{
      payload: CentraidConversationHistoryMessage;
      createdAt: number;
    }> =>
      texts.flatMap((text, index) => [
        {
          payload: { kind: "user" as const, text },
          createdAt: startedAt + index * 2,
        },
        {
          payload: {
            kind: "ai" as const,
            text: `re: ${text}`,
            turnId: `t-${startedAt + index}`,
          },
          createdAt: startedAt + index * 2 + 1,
        },
      ]);

    it("keeps every held row identical when a fetched page is prepended", () => {
      const projection = createTranscriptProjection();
      // The newest page, as the first load would deliver it.
      const held = hydrateMessages(wireRows(["latest"], 200));
      const before = projection.project(held, held.length - 1);

      // The previous page — a SEPARATE response carrying only its own turns.
      const older = hydrateMessages(wireRows(["earlier"], 100));
      const merged = [...older, ...held];
      const after = projection.project(merged, merged.length - 1);

      expect(after).toHaveLength(before.length + older.length);
      for (const [index, dto] of before.entries())
        expect(after[older.length + index]).toBe(dto);
    });

    it("keeps held rows' ids stable and gives the fetched page fresh ones", () => {
      const projection = createTranscriptProjection();
      const held = hydrateMessages(wireRows(["latest"], 200));
      const before = projection.project(held, held.length - 1);
      const heldIds = before.map((dto) => dto.msgId);

      const older = hydrateMessages(wireRows(["earlier"], 100));
      const after = projection.project([...older, ...held], -1);

      expect(after.slice(older.length).map((dto) => dto.msgId)).toStrictEqual(
        heldIds
      );
      const pageIds = after.slice(0, older.length).map((dto) => dto.msgId);
      expect(pageIds.some((id) => heldIds.includes(id))).toBe(false);
    });

    it("does not re-render held rows when a SECOND page is prepended", () => {
      const projection = createTranscriptProjection();
      const held = hydrateMessages(wireRows(["latest"], 300));
      const pageOne = hydrateMessages(wireRows(["earlier"], 200));
      const afterFirst = projection.project([...pageOne, ...held], -1);

      const pageTwo = hydrateMessages(wireRows(["earliest"], 100));
      const afterSecond = projection.project(
        [...pageTwo, ...pageOne, ...held],
        -1
      );

      // Everything from the first backfill onwards is untouched by the second.
      for (const [index, dto] of afterFirst.entries())
        expect(afterSecond[pageTwo.length + index]).toBe(dto);
    });
  });

  it("re-projects when the regenerate target moves", () => {
    const projection = createTranscriptProjection();
    const reply: AsstMsg = { kind: "ai", text: "done", turnId: "turn-1" };
    const withoutTarget = projection.project([reply], -1);
    const withTarget = projection.project([reply], 0);
    expect(withoutTarget[0]).not.toBe(withTarget[0]);
    expect(withTarget[0]).toMatchObject({ canRegenerate: true });
  });
});
