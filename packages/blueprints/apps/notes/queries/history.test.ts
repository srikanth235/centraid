/**
 * THE TAXONOMY PAIR ARRIVES IN ITS DECLARED ORDER (#922 0a) — the Notes half
 * of the same probe as `docs/queries/history.test.ts`.
 *
 * `conceptTaxonomyReads` returns `[concepts, schemes]`, and this handler read
 * them the other way round before the shared helper replaced its copied pair.
 * A swap is invisible to a typecheck (both are row arrays) and to any
 * assertion about a note that HAS no prior version: `findSchemeConcept` simply
 * fails to resolve `revises`, the walk never starts, and the answer is a
 * one-version history that reads as a note nobody has ever edited.
 */
import { describe, expect, test } from "vitest";

import { RELATIONS_SCHEME_URI } from "../../_shared/concept-scheme-kit.ts";
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
    { body_content_id: "content-new", created_at: "2026-01-01T00:00:00Z" },
  ],
  "core.concept_scheme": [
    { scheme_id: "scheme-relations", uri: RELATIONS_SCHEME_URI },
  ],
  "core.concept": [
    {
      concept_id: "concept-revises",
      scheme_id: "scheme-relations",
      notation: "revises",
    },
  ],
  "core.link": [{ to_id: "content-old", valid_from: "2026-02-01T00:00:00Z" }],
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

describe("notes history over the shared taxonomy reads", () => {
  test("resolves `revises` and walks the chain to the prior version", async () => {
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

  test("the same rows with no relations scheme yield only the current version", async () => {
    // Anti-vacuity, and the exact failure a swapped destructuring produces.
    const result = (await noteHistory({
      input: { note_id: "note-1" },
      ctx: ctxOf({ ...ROWS, "core.concept_scheme": [] }),
    } as never)) as { versions: unknown[] };
    expect(result.versions).toHaveLength(1);
  });
});
