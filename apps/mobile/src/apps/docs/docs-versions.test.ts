// The version chain over replica rows (#821, spec §10) — the same walk the
// gateway's history query performs, asserted here over plain rows: NEW → OLD
// along live revises edges, dates from the edges' own assertion times, a
// cycle guard for restored versions, and the honest one-entry history for a
// vault where nothing was ever revised.
import { describe, expect, it } from "vitest";

import type { EntityRow } from "./docs-projection";
import { projectVersionChain } from "./docs-versions";

const SCHEMES: EntityRow[] = [
  { scheme_id: "s-rel", uri: "urn:duaility:relations" },
];
const CONCEPTS: EntityRow[] = [
  { concept_id: "c-revises", scheme_id: "s-rel", notation: "revises" },
];

const doc = (current: string): EntityRow => ({
  document_id: "d1",
  current_content_id: current,
  created_at: "2026-08-08T20:12:00Z",
});

const content = (id: string, size: number): EntityRow => ({
  content_id: id,
  media_type: "text/markdown",
  byte_size: size,
  created_at: "2026-08-08T20:12:00Z",
});

const edge = (
  from: string,
  to: string,
  validFrom: string,
  validTo: string | null = null
): EntityRow => ({
  from_type: "core.content_item",
  from_id: from,
  to_type: "core.content_item",
  to_id: to,
  relation_concept_id: "c-revises",
  valid_from: validFrom,
  valid_to: validTo,
});

describe(projectVersionChain, () => {
  it("walks NEW → OLD and numbers versions with the current one highest", () => {
    const chain = projectVersionChain({
      document: doc("v3"),
      contents: [content("v1", 10), content("v2", 20), content("v3", 30)],
      links: [
        edge("v3", "v2", "2026-08-11T18:44:00Z"),
        edge("v2", "v1", "2026-08-09T09:20:00Z"),
      ],
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(chain).not.toBeNull();
    expect(chain?.versionCount).toBe(3);
    expect(chain?.entries.map((entry) => entry.n)).toStrictEqual([3, 2, 1]);
    expect(chain?.entries[0]).toMatchObject({
      content_id: "v3",
      current: true,
      asserted_at: "2026-08-11T18:44:00Z",
    });
    // The never-revised original dates from its own mint.
    expect(chain?.entries[2]?.asserted_at).toBe("2026-08-08T20:12:00Z");
  });

  it("a document never revised is its own one-entry history — no revises concept, no fabrication", () => {
    const chain = projectVersionChain({
      document: doc("v1"),
      contents: [content("v1", 10)],
      links: [],
      concepts: [],
      schemes: [],
    });
    expect(chain?.versionCount).toBe(1);
    expect(chain?.entries[0]).toMatchObject({ n: 1, current: true });
  });

  it("ignores retracted edges (valid_to set)", () => {
    const chain = projectVersionChain({
      document: doc("v2"),
      contents: [content("v1", 10), content("v2", 20)],
      links: [edge("v2", "v1", "2026-08-09T09:20:00Z", "2026-08-10T00:00:00Z")],
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(chain?.versionCount).toBe(1);
  });

  it("terminates on a restore cycle instead of walking forever", () => {
    const chain = projectVersionChain({
      document: doc("v1"),
      contents: [content("v1", 10), content("v2", 20)],
      links: [
        edge("v1", "v2", "2026-08-12T10:00:00Z"),
        edge("v2", "v1", "2026-08-09T09:20:00Z"),
      ],
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(chain?.versionCount).toBe(2);
    expect(chain?.entries.map((entry) => entry.content_id)).toStrictEqual([
      "v1",
      "v2",
    ]);
  });

  it("returns null for a document the replica does not hold", () => {
    expect(
      projectVersionChain({
        document: undefined,
        contents: [],
        links: [],
        concepts: CONCEPTS,
        schemes: SCHEMES,
      })
    ).toBeNull();
  });
});
