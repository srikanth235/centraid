import { describe, expect, it } from "vitest";

import { buildNotes } from "./notes-model";

describe(buildNotes, () => {
  it("decodes portable bodies and keeps scoped links and backlinks", () => {
    const notes = buildNotes(
      [
        {
          note_id: "n1",
          title: "Café 你好",
          body_content_id: "c1",
          pinned: 1,
          __centraidScopeId: "family",
        },
      ],
      [
        {
          content_id: "c1",
          content_uri: `data:text/markdown,${encodeURIComponent("See [[Ravi]] 😀")}`,
          __centraidScopeId: "family",
        },
      ],
      [
        {
          link_id: "out",
          from_type: "knowledge.note",
          from_id: "n1",
          to_type: "core.party",
          to_id: "p1",
          __centraidScopeId: "family",
        },
        {
          link_id: "in",
          from_type: "knowledge.note",
          from_id: "n2",
          to_type: "knowledge.note",
          to_id: "n1",
          __centraidScopeId: "family",
        },
        {
          link_id: "wrong-scope",
          from_type: "knowledge.note",
          from_id: "n1",
          to_type: "core.party",
          to_id: "p2",
          __centraidScopeId: "personal",
        },
      ],
      [
        {
          link_id: "out",
          selector_json: JSON.stringify({ exact: "[[Ravi]]" }),
          __centraidScopeId: "family",
        },
      ]
    );

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: "family:n1",
      title: "Café 你好",
      body: "See [[Ravi]] 😀",
      pinned: true,
    });
    expect(notes[0]?.references).toHaveLength(1);
    expect(notes[0]?.references[0]?.anchor).toMatchObject({
      link_id: "out",
    });
    expect(notes[0]?.backlinks).toHaveLength(1);
  });

  it("carries the chain head and the purge date the vault gave it", () => {
    const [live, trashed] = buildNotes(
      [
        {
          note_id: "n1",
          title: "Live",
          body_content_id: "c1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
        },
        {
          note_id: "n2",
          title: "Trashed",
          body_content_id: "c2",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          deleted_at: "2026-01-03T00:00:00Z",
          purge_at: "2026-02-02T00:00:00Z",
        },
      ],
      [],
      []
    );

    expect(live).toMatchObject({
      bodyContentId: "c1",
      createdAt: "2026-01-01T00:00:00Z",
      trashed: false,
    });
    expect(live?.purgeAt).toBeUndefined();
    expect(trashed).toMatchObject({
      trashed: true,
      purgeAt: "2026-02-02T00:00:00Z",
    });
  });
});
