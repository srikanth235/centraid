/**
 * Springboard tile selection + first-run detection (issue #708 A). The module
 * under test is pure by construction, so nothing here needs a renderer or a
 * replica — the rows are the wire shape `useReplicaQuery` hands back.
 */
import { describe, expect, it } from "vitest";

import type { ReplicaRow } from "@centraid/client/replica/native";

import {
  countUpcoming,
  decodeProse,
  firstProseLine,
  initialsOf,
  isWideTile,
  monthStartDate,
  openTasks,
  selectDocExcerpt,
  selectFaces,
  selectNextEvent,
  selectNoteExcerpt,
  selectPhotoMosaic,
  selectTaskRows,
  springboardState,
  sumMinor,
  tileSize,
  TILE_EMPTY_COPY,
} from "./tile-model";
import type { TileStatus } from "./tile-model";

const row = (values: Record<string, unknown>): ReplicaRow =>
  values as ReplicaRow;

const prose = (text: string): string =>
  `data:text/markdown,${encodeURIComponent(text)}`;

describe(selectPhotoMosaic, () => {
  const assets = [
    row({
      asset_id: "a",
      content_id: "c-a",
      captured_at: "2026-01-01T00:00:00.000Z",
      __centraidScopeId: "v1",
    }),
    row({
      asset_id: "b",
      content_id: "c-b",
      captured_at: "2026-03-01T00:00:00.000Z",
      __centraidScopeId: "v1",
    }),
  ];

  it("orders newest first and builds the gateway thumb address", () => {
    const mosaic = selectPhotoMosaic(assets, "https://gw", () => undefined);
    expect(mosaic.map((photo) => photo.id)).toStrictEqual(["b", "a"]);
    expect(mosaic[0]?.uri).toBe(
      "https://gw/centraid/_gateway/blobs/v1/c-b?variant=thumb"
    );
  });

  it("prefers a pinned on-device thumbnail over the gateway", () => {
    const mosaic = selectPhotoMosaic(assets, "https://gw", (scope, content) =>
      content === "c-b" ? "file:///pinned.jpg" : undefined
    );
    expect(mosaic[0]?.uri).toBe("file:///pinned.jpg");
  });

  it("drops rows it cannot address rather than rendering a broken tile", () => {
    expect(selectPhotoMosaic(assets, undefined, () => undefined)).toStrictEqual(
      []
    );
    expect(
      selectPhotoMosaic(
        [row({ captured_at: "x" })],
        "https://gw",
        () => undefined
      )
    ).toStrictEqual([]);
  });

  it("asks for a video poster instead of a photo thumb", () => {
    const mosaic = selectPhotoMosaic(
      [row({ asset_id: "v", content_id: "c-v", kind: "video" })],
      "https://gw",
      () => undefined
    );
    expect(mosaic[0]?.uri.endsWith("?variant=poster")).toBe(true);
  });
});

describe(decodeProse, () => {
  it("decodes a percent-encoded data body", () => {
    expect(decodeProse(prose("hello world"))).toBe("hello world");
  });

  it("returns nothing for bytes it must not guess at", () => {
    expect(decodeProse("data:application/pdf;base64,AAAA")).toBe("");
    expect(decodeProse("https://example.test/a.pdf")).toBe("");
    expect(decodeProse(undefined)).toBe("");
  });
});

describe(firstProseLine, () => {
  it("skips markdown syntax and blank lines", () => {
    expect(firstProseLine("# Title\n\n> quoted opening")).toBe(
      "quoted opening"
    );
  });

  it("is empty when there is no prose", () => {
    expect(firstProseLine("")).toBe("");
  });
});

describe(selectNoteExcerpt, () => {
  const notes = [
    row({
      note_id: "n1",
      title: "Older",
      updated_at: "2026-01-01T00:00:00.000Z",
      body_content_id: "c1",
    }),
    row({
      note_id: "n2",
      title: "Newer",
      updated_at: "2026-05-01T00:00:00.000Z",
      body_content_id: "c2",
    }),
  ];
  const contents = [
    row({ content_id: "c1", content_uri: prose("old body") }),
    row({ content_id: "c2", content_uri: prose("# Heading\nnew body") }),
  ];

  it("takes the newest note and its opening prose line", () => {
    expect(selectNoteExcerpt(notes, contents)).toStrictEqual({
      title: "Newer",
      excerpt: "new body",
    });
  });

  it("keeps the title when the body is unreadable", () => {
    expect(selectNoteExcerpt(notes, [])).toStrictEqual({
      title: "Newer",
      excerpt: "",
    });
  });

  it("is undefined with no notes", () => {
    expect(selectNoteExcerpt([], contents)).toBeUndefined();
  });
});

describe(selectDocExcerpt, () => {
  it("resolves through current_content_id", () => {
    expect(
      selectDocExcerpt(
        [
          row({
            document_id: "d1",
            title: "Lease",
            updated_at: "2026-02-02T00:00:00.000Z",
            current_content_id: "c9",
          }),
        ],
        [row({ content_id: "c9", content_uri: prose("The tenant shall…") })]
      )
    ).toStrictEqual({ title: "Lease", excerpt: "The tenant shall…" });
  });
});

describe(selectNextEvent, () => {
  const now = new Date("2026-06-01T09:00:00.000Z");
  const at = (iso: string): string => iso.slice(11, 16);
  const occurrence = (key: string, summary: string, start: string) => ({
    instanceKey: key,
    summary,
    start,
  });

  it("names what is after the next event", () => {
    expect(
      selectNextEvent(
        [
          occurrence("b", "Dentist", "2026-06-01T15:00:00.000Z"),
          occurrence("a", "Standup", "2026-06-01T10:00:00.000Z"),
        ],
        now,
        at
      )
    ).toStrictEqual({ title: "Standup", at: "10:00", after: "then Dentist" });
  });

  it("says so when nothing follows, rather than going blank", () => {
    expect(
      selectNextEvent(
        [occurrence("a", "Standup", "2026-06-01T10:00:00.000Z")],
        now,
        at
      )?.after
    ).toBe("nothing after it");
  });

  it("ignores occurrences already past", () => {
    expect(
      selectNextEvent(
        [occurrence("a", "Standup", "2026-06-01T08:00:00.000Z")],
        now,
        at
      )
    ).toBeUndefined();
  });
});

describe(countUpcoming, () => {
  it("counts only inside the window", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const occurrences = [
      { instanceKey: "a", summary: "a", start: "2026-06-03T00:00:00.000Z" },
      { instanceKey: "b", summary: "b", start: "2026-06-20T00:00:00.000Z" },
      { instanceKey: "c", summary: "c", start: "2026-05-30T00:00:00.000Z" },
    ];
    expect(countUpcoming(occurrences, now, 7)).toBe(1);
  });
});

describe(selectFaces, () => {
  it("orders by display name and carries the person's own colour", () => {
    const faces = selectFaces(
      [
        row({ party_id: "p2", avatar_color: "#abc" }),
        row({ party_id: "p1" }),
        row({ party_id: "p3", deleted_at: "2026-01-01T00:00:00.000Z" }),
      ],
      new Map([
        ["p1", "Ada Lovelace"],
        ["p2", "Zoe Quinn"],
        ["p3", "Deleted Person"],
      ])
    );
    expect(faces).toStrictEqual([
      { id: "p1", initials: "AL" },
      { id: "p2", initials: "ZQ", color: "#abc" },
    ]);
  });

  it("caps the sample", () => {
    const profiles = Array.from({ length: 9 }, (_value, index) =>
      row({ party_id: `p${index}` })
    );
    expect(selectFaces(profiles, new Map(), 5)).toHaveLength(5);
  });
});

describe(initialsOf, () => {
  it("takes first and last initials, and never renders a hole", () => {
    expect(initialsOf("Ada Byron Lovelace")).toBe("AL");
    expect(initialsOf("Prince")).toBe("P");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe(selectTaskRows, () => {
  const open = (id: string, order: number): ReplicaRow =>
    row({
      task_id: id,
      title: id,
      status: "needs-action",
      sort_order: order,
    });

  it("draws open work with exactly one struck-through completion", () => {
    const rows = selectTaskRows(
      [
        open("c", 3),
        open("a", 1),
        open("b", 2),
        row({
          task_id: "old",
          title: "old win",
          status: "completed",
          completed_at: "2026-01-01T00:00:00.000Z",
        }),
        row({
          task_id: "new",
          title: "recent win",
          status: "completed",
          completed_at: "2026-05-05T00:00:00.000Z",
        }),
      ],
      4
    );
    expect(rows.map((task) => task.title)).toStrictEqual([
      "a",
      "b",
      "c",
      "recent win",
    ]);
    expect(rows.filter((task) => task.done)).toHaveLength(1);
    expect(rows.at(-1)?.done).toBe(true);
  });

  it("shows no struck row when nothing has been completed", () => {
    const rows = selectTaskRows([open("a", 1), open("b", 2)], 4);
    expect(rows.every((task) => !task.done)).toBe(true);
  });

  it("counts only open statuses", () => {
    expect(
      openTasks([
        open("a", 1),
        row({ task_id: "b", status: "in-process" }),
        row({ task_id: "c", status: "completed" }),
        row({ task_id: "d", status: "cancelled" }),
      ])
    ).toHaveLength(2);
  });
});

describe(sumMinor, () => {
  it("adds minor units and tolerates missing amounts", () => {
    expect(
      sumMinor([
        row({ amount_minor: 1250 }),
        row({}),
        row({ amount_minor: 99 }),
      ])
    ).toBe(1349);
  });
});

describe(monthStartDate, () => {
  it("is the ISO date `spent_on` stores", () => {
    expect(monthStartDate(new Date(2026, 6, 17))).toBe("2026-07-01");
  });
});

describe(springboardState, () => {
  const tiles = (...statuses: TileStatus[]): { status: TileStatus }[] =>
    statuses.map((status) => ({ status }));

  it("shows the grid as soon as one app has content", () => {
    expect(springboardState(tiles("loading", "empty", "content"))).toBe(
      "content"
    );
  });

  it("will not call first run while a read is still in flight", () => {
    expect(springboardState(tiles("empty", "loading", "unknown"))).toBe(
      "loading"
    );
  });

  it("calls first run only when every readable tile settled empty", () => {
    // Locker is permanently `unknown` (sealed, online-only) — it must not
    // veto a genuine day one.
    expect(springboardState(tiles("empty", "empty", "unknown"))).toBe(
      "first-run"
    );
  });

  it("renders the grid, not day one, when nothing is readable at all", () => {
    expect(springboardState(tiles("unknown", "unknown"))).toBe("content");
  });

  it("treats no tiles as not-yet-known", () => {
    expect(springboardState([])).toBe("loading");
  });
});

describe(tileSize, () => {
  it("gives Photos the 2×2, prose the 2×1, and everything else the 1×1", () => {
    expect(tileSize("photos")).toBe("large");
    expect(tileSize("docs")).toBe("medium");
    expect(tileSize("notes")).toBe("medium");
    for (const id of ["agenda", "tasks", "people", "tally", "locker"])
      expect(tileSize(id)).toBe("small");
  });

  it("gives an app with no first-party tile the 1×1", () => {
    expect(tileSize("some-gateway-app")).toBe("small");
  });

  it("puts medium AND the flattened large in a full-width mobile slot", () => {
    expect(isWideTile("photos")).toBe(true);
    expect(isWideTile("docs")).toBe(true);
    expect(isWideTile("tasks")).toBe(false);
  });
});

describe("what-to-do copy", () => {
  it("covers every first-party app", () => {
    expect(Object.keys(TILE_EMPTY_COPY).sort()).toStrictEqual([
      "agenda",
      "docs",
      "locker",
      "notes",
      "people",
      "photos",
      "tally",
      "tasks",
    ]);
  });
});
