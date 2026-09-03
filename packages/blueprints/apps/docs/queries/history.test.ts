/**
 * THE TAXONOMY PAIR ARRIVES IN ITS DECLARED ORDER (#922 0a).
 *
 * `conceptTaxonomyReads` returns `[concepts, schemes]`, and this handler used
 * to read them the other way round — its destructuring was flipped when the
 * shared helper replaced the copied pair. Nothing about the chain's SHAPE
 * catches that: `findSchemeConcept` handed two arrays in the wrong order finds
 * no `revises` concept, the handler quietly skips the walk, and the answer is
 * a one-version history that looks like a document nobody has ever revised.
 *
 * So the probe is exactly that: a document with one prior version. Wired
 * correctly it is a 2-version chain; with the two arguments swapped it drops
 * to 1, which is what a typecheck can never see because both are row arrays.
 */
import { describe, expect, test } from "vitest";

import { RELATIONS_SCHEME_URI } from "../../_shared/concept-scheme-kit.ts";
import historyHandler from "./history.ts";

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

const ROWS = {
  "core.document": [
    {
      document_id: "doc-1",
      current_content_id: "content-new",
      created_at: "2026-01-01T00:00:00Z",
    },
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
    { content_id: "content-new", media_type: "application/pdf" },
    { content_id: "content-old", media_type: "application/pdf" },
  ],
};

describe("docs history over the shared taxonomy reads", () => {
  test("resolves `revises` and walks the chain to the prior version", async () => {
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

  test("the same rows with no relations scheme yield only the current version", async () => {
    // Anti-vacuity, and the exact failure a swapped destructuring produces:
    // the `revises` concept is unresolvable, so the walk never starts.
    const result = (await historyHandler({
      input: { document_id: "doc-1" },
      ctx: ctxOf({ ...ROWS, "core.concept_scheme": [] }),
    } as never)) as { versions: unknown[] };
    expect(result.versions).toHaveLength(1);
  });
});
