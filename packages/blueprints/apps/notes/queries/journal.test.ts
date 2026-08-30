// The Journal place is INCLUDE-ONLY over the People-journal scheme — the
// mirror image of the exclusion its three sibling projections apply. Same
// mocked-vault shape as `src/day-context-journal-queries.test.ts`: fixtures
// keyed by entity, no `where` applied, so a handler that trusted the read
// instead of re-narrowing in memory fails here.
import { describe, expect, test } from "vitest";

import { FLAGS_SCHEME_URI } from "../../_shared/concept-scheme-kit.ts";
import {
  JOURNAL_ENTRY_NOTATION,
  JOURNAL_SCHEME_URI,
} from "../../_shared/journal-scheme.ts";
import journalHandler from "./journal.ts";

interface ReadCall {
  entity: string;
  where?: Array<{ column: string; op: string; value?: unknown }>;
  limit?: number;
}

function ctxOf(
  rowsByEntity: Record<string, unknown[]>,
  calls: ReadCall[] = []
) {
  return {
    calls,
    vault: {
      read: async (request: ReadCall) => {
        calls.push(request);
        return { rows: rowsByEntity[request.entity] ?? [] };
      },
      search: async () => ({ rows: [] }),
      resolve: async () => ({ cards: [] }),
      invoke: async () => ({ status: "executed", output: {} }),
    },
  };
}

const body = (text: string): string =>
  `data:text/markdown,${encodeURIComponent(text)}`;

/** A vault with two journal entries, one ordinary note, and one journal
 *  entry already in the trash. */
function vaultRows() {
  return {
    "core.concept_scheme": [
      { scheme_id: "scheme-journal", uri: JOURNAL_SCHEME_URI },
      { scheme_id: "scheme-other", uri: FLAGS_SCHEME_URI },
    ],
    "core.concept": [
      {
        concept_id: "concept-entry",
        scheme_id: "scheme-journal",
        notation: JOURNAL_ENTRY_NOTATION,
      },
      {
        concept_id: "concept-noise",
        scheme_id: "scheme-journal",
        notation: "something-else",
      },
    ],
    "core.tag": [
      { target_id: "note-journal-1", concept_id: "concept-entry" },
      { target_id: "note-journal-2", concept_id: "concept-entry" },
      { target_id: "note-trashed", concept_id: "concept-entry" },
      { target_id: "note-plain", concept_id: "concept-noise" },
    ],
    "knowledge.note": [
      {
        note_id: "note-journal-1",
        title: "Coffee with Priya",
        updated_at: "2026-08-20T09:00:00Z",
        body_content_id: "content-1",
        deleted_at: null,
      },
      {
        note_id: "note-journal-2",
        title: "",
        updated_at: "2026-08-19T09:00:00Z",
        body_content_id: "content-2",
        deleted_at: null,
      },
      {
        note_id: "note-trashed",
        title: "Deleted entry",
        updated_at: "2026-08-18T09:00:00Z",
        body_content_id: "content-3",
        deleted_at: "2026-08-19T10:00:00Z",
      },
      {
        note_id: "note-plain",
        title: "Q3 roadmap",
        updated_at: "2026-08-21T09:00:00Z",
        body_content_id: "content-4",
        deleted_at: null,
      },
    ],
    "core.content_item": [
      {
        content_id: "content-1",
        content_uri: body("we talked about the move"),
      },
      {
        content_id: "content-2",
        content_uri: body("first line\n- [x] one\n- [ ] two"),
      },
      { content_id: "content-3", content_uri: body("gone") },
      { content_id: "content-4", content_uri: body("the three bets") },
    ],
  };
}

describe("the Journal place", () => {
  test("includes the marked entries and nothing else", async () => {
    const ctx = ctxOf(vaultRows());
    const answer = await journalHandler({ input: {}, ctx } as never);
    expect(
      answer.entries.map((entry: { note_id: string }) => entry.note_id)
    ).toStrictEqual(["note-journal-1", "note-journal-2"]);
  });

  test("a trashed entry is in the trash, not in the place", async () => {
    const ctx = ctxOf(vaultRows());
    const answer = await journalHandler({ input: {}, ctx } as never);
    expect(
      answer.entries.some(
        (entry: { note_id: string }) => entry.note_id === "note-trashed"
      )
    ).toBe(false);
  });

  test("an entry ships a preview and a tally, never a whole body", async () => {
    const ctx = ctxOf(vaultRows());
    const answer = await journalHandler({ input: {}, ctx } as never);
    const untitled = answer.entries[1] as Record<string, unknown>;
    expect(untitled["preview"]).toContain("first line");
    expect(untitled["check"]).toStrictEqual({ total: 2, done: 1 });
    // The place ships a preview and a tally, never a body: the editor pulls
    // the canonical text on open, exactly as the library does.
    expect(untitled["body"]).toBeUndefined();
  });

  test("every read is bounded — by an eq, an in, or a limit", async () => {
    const calls: ReadCall[] = [];
    const ctx = ctxOf(vaultRows(), calls);
    await journalHandler({ input: { limit: 50 }, ctx } as never);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const bounded =
        (call.where ?? []).some((clause) => ["eq", "in"].includes(clause.op)) ||
        typeof call.limit === "number";
      expect(bounded, `${call.entity} read is unbounded`).toBe(true);
    }
  });

  test("a vault where nobody has journalled answers empty without walking tags", async () => {
    const calls: ReadCall[] = [];
    const ctx = ctxOf({ "core.concept_scheme": [], "core.concept": [] }, calls);
    const answer = await journalHandler({ input: {}, ctx } as never);
    expect(answer.entries).toStrictEqual([]);
    expect(calls.map((call) => call.entity)).not.toContain("core.tag");
  });

  test("a denial is a value with a receipt, never a throw", async () => {
    const ctx = {
      vault: {
        read: async () => {
          throw Object.assign(new Error("no consent"), { code: "denied" });
        },
      },
    };
    const answer = await journalHandler({ input: {}, ctx } as never);
    expect(answer.entries).toStrictEqual([]);
    expect(answer.vaultDenied).toStrictEqual({
      code: "denied",
      message: "no consent",
    });
  });
});
