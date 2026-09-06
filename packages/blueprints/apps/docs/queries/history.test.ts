/**
 * THE CHAIN IS THE DOCUMENT'S OWN OCCURRENCES (#996, R20(a)).
 *
 * History used to be a `revises` link chain resolved through the shared
 * taxonomy pair, and the probe here was that the pair arrived in its declared
 * order — a swapped destructuring found no `revises` concept, skipped the walk
 * silently, and answered "a document nobody has ever revised".
 *
 * The occurrence chain removes that whole class of failure: there is no
 * concept to resolve and no relation to look up. What is left to prove is the
 * property the occurrence exists for — a document that returns to bytes it
 * already held reads as MORE versions, not fewer, where a content-keyed walk
 * could only ever show a node once.
 */
import { describe, expect, test } from "vitest";

import historyHandler from "./history.ts";

interface ReadCall {
  entity: string;
  where?: Array<{ column: string; op: string; value?: unknown }>;
}

/** Fixtures keyed by entity; `where` is deliberately not applied, so a handler
 *  that trusted the read instead of walking the chain itself fails here. */
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

const ROWS = {
  "core.document": [
    {
      document_id: "doc-1",
      current_content_id: "content-new",
      current_revision_id: "rev-2",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
  "core.entity_revision": [
    {
      revision_id: "rev-2",
      entity_type: "core.document",
      entity_id: "doc-1",
      content_id: "content-new",
      parent_revision_id: "rev-1",
      recorded_at: "2026-02-01T00:00:00Z",
    },
    {
      revision_id: "rev-1",
      entity_type: "core.document",
      entity_id: "doc-1",
      content_id: "content-old",
      parent_revision_id: null,
      recorded_at: "2026-01-01T00:00:00Z",
    },
  ],
  "core.content_item": [
    { content_id: "content-new", media_type: "application/pdf" },
    { content_id: "content-old", media_type: "application/pdf" },
  ],
};

describe("docs history over revision occurrences", () => {
  test("walks the occurrence chain to the prior version", async () => {
    const result = (await historyHandler({
      input: { document_id: "doc-1" },
      ctx: ctxOf(ROWS),
    } as never)) as {
      versions: Array<{ content_id: string; current: boolean }>;
    };
    expect(result.versions.map((v) => v.content_id)).toStrictEqual([
      "content-new",
      "content-old",
    ]);
    expect(result.versions[0]?.current).toBe(true);
  });

  test("a document restored to bytes it already held reads as four versions", async () => {
    // The property a content-keyed walk could not express: v1 appears at two
    // points in true history, and the chain says so.
    const rows = {
      ...ROWS,
      "core.document": [
        {
          document_id: "doc-1",
          current_content_id: "content-old",
          current_revision_id: "rev-4",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      "core.entity_revision": [
        {
          revision_id: "rev-4",
          content_id: "content-old",
          parent_revision_id: "rev-3",
          recorded_at: "2026-04-01T00:00:00Z",
        },
        {
          revision_id: "rev-3",
          content_id: "content-new",
          parent_revision_id: "rev-2",
          recorded_at: "2026-03-01T00:00:00Z",
        },
        {
          revision_id: "rev-2",
          content_id: "content-old",
          parent_revision_id: "rev-1",
          recorded_at: "2026-02-01T00:00:00Z",
        },
        {
          revision_id: "rev-1",
          content_id: "content-new",
          parent_revision_id: null,
          recorded_at: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const result = (await historyHandler({
      input: { document_id: "doc-1" },
      ctx: ctxOf(rows),
    } as never)) as { versions: Array<{ content_id: string }> };
    expect(result.versions.map((v) => v.content_id)).toStrictEqual([
      "content-old",
      "content-new",
      "content-old",
      "content-new",
    ]);
  });

  test("a document with no occurrence yet still has its current version", async () => {
    // Anti-vacuity, and the honest answer for a row minted before the wrapper
    // carried a pointer: one version, the bytes it is currently made of.
    const result = (await historyHandler({
      input: { document_id: "doc-1" },
      ctx: ctxOf({ ...ROWS, "core.entity_revision": [] }),
    } as never)) as { versions: unknown[] };
    expect(result.versions).toHaveLength(1);
  });
});
