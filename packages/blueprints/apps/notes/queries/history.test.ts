/**
 * THE CHAIN IS THE NOTE'S OWN OCCURRENCES (#996, R20(a)) — the Notes half of
 * the same probe as `docs/queries/history.test.ts`.
 *
 * History used to be a `revises` link chain resolved through the shared
 * taxonomy pair, and a swapped destructuring silently answered "a note nobody
 * has ever edited". There is no concept to resolve any more; what is left to
 * prove is that the walk is over the note's own occurrences and that a note
 * without one still answers honestly.
 */
import { describe, expect, test } from "vitest";

import noteHistory from "./history.ts";

interface ReadCall {
  entity: string;
  where?: Array<{ column: string; op: string; value?: unknown }>;
}

/** Fixtures keyed by entity; `where` is deliberately not applied, so a handler
 *  that trusted the read instead of resolving the relation itself fails here. */
function ctxOf(rowsByEntity: Record<string, unknown[]>) {
  return {
    vault: {
      read: async (request: ReadCall) => ({
        rows: rowsByEntity[request.entity] ?? [],
      }),
      search: async () => ({ rows: [] }),
      resolve: async () => ({ cards: [] }),
      invoke: async () => ({ status: "executed", output: {} }),
    },
  };
}

const body = (text: string): string =>
  `data:text/markdown,${encodeURIComponent(text)}`;

const ROWS = {
  "knowledge.note": [
    {
      body_content_id: "content-new",
      current_revision_id: "rev-2",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
  "core.entity_revision": [
    {
      revision_id: "rev-2",
      entity_type: "knowledge.note",
      entity_id: "note-1",
      content_id: "content-new",
      parent_revision_id: "rev-1",
      recorded_at: "2026-02-01T00:00:00Z",
    },
    {
      revision_id: "rev-1",
      entity_type: "knowledge.note",
      entity_id: "note-1",
      content_id: "content-old",
      parent_revision_id: null,
      recorded_at: "2026-01-01T00:00:00Z",
    },
  ],
  "core.content_item": [
    {
      content_id: "content-new",
      content_uri: body("second draft"),
      media_type: "text/markdown",
    },
    {
      content_id: "content-old",
      content_uri: body("first draft"),
      media_type: "text/markdown",
    },
  ],
};

describe("notes history over revision occurrences", () => {
  test("walks the occurrence chain to the prior version", async () => {
    const result = (await noteHistory({
      input: { note_id: "note-1" },
      ctx: ctxOf(ROWS),
    } as never)) as { versions: Array<{ content_id: string; body: string }> };
    expect(result.versions.map((v) => v.content_id)).toStrictEqual([
      "content-new",
      "content-old",
    ]);
    expect(result.versions[1]?.body).toBe("first draft");
  });

  test("a note with no occurrence yet still has its current version", async () => {
    // Anti-vacuity, and the honest answer for a note minted before the wrapper
    // carried a pointer.
    const result = (await noteHistory({
      input: { note_id: "note-1" },
      ctx: ctxOf({ ...ROWS, "core.entity_revision": [] }),
    } as never)) as { versions: unknown[] };
    expect(result.versions).toHaveLength(1);
  });
});
