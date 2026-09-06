// The version chain over replica rows (#821, spec §10, re-cut by #996 R20(a)) —
// the same walk the gateway's history query performs, asserted here over plain
// rows: the document's own OCCURRENCES from `current_revision_id` through
// `parent_revision_id`, dates from each occurrence's `recorded_at`, a cycle
// guard for a malformed chain, and the honest one-entry history for a document
// nothing was ever done to.

import { describe, expect, it } from "vitest";

import type { EntityRow } from "./docs-projection";
import { projectVersionChain } from "./docs-versions";

const doc = (current: string, revision: string | null): EntityRow => ({
  document_id: "d1",
  current_content_id: current,
  ...(revision === null ? {} : { current_revision_id: revision }),
  created_at: "2026-08-08T20:12:00Z",
});

const content = (id: string, size: number): EntityRow => ({
  content_id: id,
  media_type: "text/markdown",
  byte_size: size,
  created_at: "2026-08-08T20:12:00Z",
});

const occurrence = (
  id: string,
  contentId: string,
  parent: string | null,
  recordedAt: string
): EntityRow => ({
  revision_id: id,
  entity_type: "core.document",
  entity_id: "d1",
  content_id: contentId,
  parent_revision_id: parent,
  recorded_at: recordedAt,
});

describe(projectVersionChain, () => {
  it("walks NEW → OLD and numbers versions with the current one highest", () => {
    const chain = projectVersionChain({
      document: doc("v3", "r3"),
      revisions: [
        occurrence("r3", "v3", "r2", "2026-08-10T10:00:00Z"),
        occurrence("r2", "v2", "r1", "2026-08-09T10:00:00Z"),
        occurrence("r1", "v1", null, "2026-08-08T20:12:00Z"),
      ],
      contents: [content("v1", 10), content("v2", 20), content("v3", 30)],
    });
    expect(chain?.entries.map((entry) => entry.content_id)).toStrictEqual([
      "v3",
      "v2",
      "v1",
    ]);
    expect(chain?.entries.map((entry) => entry.n)).toStrictEqual([3, 2, 1]);
    expect(chain?.entries[0]?.current).toBe(true);
    expect(chain?.versionCount).toBe(3);
    expect(chain?.entries[0]?.asserted_at).toBe("2026-08-10T10:00:00Z");
  });

  it("shows a restored version twice, because an occurrence is a moment", () => {
    // The property a content-keyed walk could not express (#996, R20(a)).
    const chain = projectVersionChain({
      document: doc("v1", "r3"),
      revisions: [
        occurrence("r3", "v1", "r2", "2026-08-10T10:00:00Z"),
        occurrence("r2", "v2", "r1", "2026-08-09T10:00:00Z"),
        occurrence("r1", "v1", null, "2026-08-08T20:12:00Z"),
      ],
      contents: [content("v1", 10), content("v2", 20)],
    });
    expect(chain?.entries.map((entry) => entry.content_id)).toStrictEqual([
      "v1",
      "v2",
      "v1",
    ]);
    expect(chain?.versionCount).toBe(3);
  });

  it("ignores another document's occurrences", () => {
    const chain = projectVersionChain({
      document: doc("v1", "r1"),
      revisions: [
        occurrence("r1", "v1", null, "2026-08-08T20:12:00Z"),
        {
          ...occurrence("r9", "vX", null, "2026-08-09T10:00:00Z"),
          entity_id: "d2",
        },
      ],
      contents: [content("v1", 10)],
    });
    expect(chain?.entries.map((entry) => entry.content_id)).toStrictEqual([
      "v1",
    ]);
  });

  it("terminates on a cycle rather than walking it", () => {
    const chain = projectVersionChain({
      document: doc("v2", "r2"),
      revisions: [
        occurrence("r2", "v2", "r1", "2026-08-09T10:00:00Z"),
        occurrence("r1", "v1", "r2", "2026-08-08T20:12:00Z"),
      ],
      contents: [content("v1", 10), content("v2", 20)],
    });
    expect(chain?.entries.map((entry) => entry.content_id)).toStrictEqual([
      "v2",
      "v1",
    ]);
  });

  it("answers one honest version for a document with no occurrence", () => {
    const chain = projectVersionChain({
      document: doc("v1", null),
      revisions: [],
      contents: [content("v1", 10)],
    });
    expect(chain?.entries.map((entry) => entry.content_id)).toStrictEqual([
      "v1",
    ]);
    expect(chain?.versionCount).toBe(1);
    expect(chain?.entries[0]?.current).toBe(true);
  });

  it("is null without a document row", () => {
    expect(
      projectVersionChain({
        document: undefined,
        revisions: [],
        contents: [],
      })
    ).toBeNull();
  });
});
