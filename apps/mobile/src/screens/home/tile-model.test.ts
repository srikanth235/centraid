/**
 * Springboard tile selection + first-run detection (issue #708 A). The module
 * under test is pure by construction, so nothing here needs a renderer or a
 * replica — the rows are the wire shape `useReplicaQuery` hands back.
 */
import { describe, expect, it } from "vitest";

import type { ReplicaRow } from "@centraid/client/replica/native";

import {
  countThings,
  countUpcoming,
  decodeProse,
  firstProseLine,
  initialsOf,
  isWideTile,
  monthStartDate,
  MOSAIC_CELL_HEIGHT,
  MOSAIC_SLOTS,
  mosaicAwaitingBytes,
  mosaicCells,
  openTasks,
  formatBytes,
  selectDocRows,
  selectFaces,
  selectNextEvent,
  selectNoteExcerpt,
  selectPhotoMosaic,
  selectTaskRows,
  springboardState,
  sumMinor,
  tileEarnsGrid,
  tileSize,
  TILE_EMPTY_COPY,
} from "./tile-model";
import type { TileData, TileStatus } from "./tile-model";

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

  it("keeps a cell for an asset whose bytes are not addressable yet", () => {
    // A seeded, gateway-side vault with no gateway reachable: ten photographs
    // exist, none can be painted. Dropping them rendered the tile as one blank
    // rectangle under a header reading 10.
    const mosaic = selectPhotoMosaic(assets, undefined, () => undefined);
    expect(mosaic.map((photo) => photo.id)).toStrictEqual(["b", "a"]);
    expect(mosaic.every((photo) => photo.uri === undefined)).toBe(true);
  });

  it("drops a row with no content behind it — there is nothing to wait for", () => {
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
    expect(mosaic[0]?.uri?.endsWith("?variant=poster")).toBe(true);
  });
});

describe("the mosaic a seeded, gateway-side vault produces", () => {
  // The real replica shape for `media.media_asset`: `asset_id` and `content_id`
  // are both NOT NULL in the DDL, `captured_at` is nullable, and the multi-vault
  // reader stamps `__centraidScopeId` on every row. Ten of them, none pinned to
  // this device — which is what a freshly seeded vault looks like from a phone.
  const seeded = Array.from({ length: 10 }, (_, index) =>
    row({
      asset_id: `asset-${index}`,
      content_id: `content-${index}`,
      kind: "photo",
      captured_at: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      __centraidScopeId: "vault-personal",
    })
  );

  it("draws a full grid of cells with no local bytes and no gateway", () => {
    const photos = selectPhotoMosaic(seeded, undefined, () => undefined);
    // Bounded to what the tile draws, not to how many exist.
    expect(photos).toHaveLength(MOSAIC_SLOTS);
    expect(mosaicCells(photos)).toHaveLength(MOSAIC_SLOTS);
    // Every slot is a real cell — this is the assertion that fails if a row
    // without addressable bytes is dropped, which rendered the tile as one
    // blank rectangle under a header reading 10.
    for (const cell of mosaicCells(photos)) expect(cell).toBeDefined();
    expect(mosaicAwaitingBytes(photos)).toBe(true);
  });

  it("gives every cell a real height, so none can collapse into the ground", () => {
    // TileBody's `styles.thumb` takes this exact value as an explicit height
    // rather than deriving one from `aspectRatio`. A zero-height cell is
    // invisible and reads as a deliberate blank rectangle.
    expect(MOSAIC_CELL_HEIGHT).toBeGreaterThan(0);
    expect(Number.isFinite(MOSAIC_CELL_HEIGHT)).toBe(true);
  });

  it("still fills every slot once the gateway can address the bytes", () => {
    const photos = selectPhotoMosaic(seeded, "https://gw", () => undefined);
    expect(photos).toHaveLength(MOSAIC_SLOTS);
    expect(photos.every((photo) => photo.uri !== undefined)).toBe(true);
    expect(mosaicAwaitingBytes(photos)).toBe(false);
  });

  it("keeps the slot count when fewer photographs exist than slots", () => {
    const photos = selectPhotoMosaic(
      seeded.slice(0, 2),
      undefined,
      () => undefined
    );
    expect(photos).toHaveLength(2);
    // The grid does not shrink to two cells — it draws six and leaves four
    // empty, so nothing reflows when the rest arrive.
    const cells = mosaicCells(photos);
    expect(cells).toHaveLength(MOSAIC_SLOTS);
    expect(cells.filter(Boolean)).toHaveLength(2);
  });
});

describe(mosaicAwaitingBytes, () => {
  it("is true when cells exist but not one of them can paint", () => {
    expect(mosaicAwaitingBytes([{ id: "a" }, { id: "b" }])).toBe(true);
  });

  it("is false as soon as one cell has bytes to draw", () => {
    expect(
      mosaicAwaitingBytes([{ id: "a" }, { id: "b", uri: "file:///b.jpg" }])
    ).toBe(false);
  });

  it("is false with no cells at all — that is the empty tile, not this state", () => {
    expect(mosaicAwaitingBytes([])).toBe(false);
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

describe(formatBytes, () => {
  it("carries one decimal above the byte rung and none below it", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(4_299_161)).toBe("4.1 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("says nothing rather than inventing a size it does not have", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes("not a number")).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe(selectDocRows, () => {
  const doc = (id: string, title: string, updated: string, content: string) =>
    row({
      document_id: id,
      title,
      updated_at: updated,
      current_content_id: content,
    });

  it("draws newest-first file rows with the size off the content item", () => {
    expect(
      selectDocRows(
        [
          doc("d1", "Lease", "2026-02-02T00:00:00.000Z", "c9"),
          doc("d2", "Survey", "2026-03-03T00:00:00.000Z", "c4"),
        ],
        [
          row({ content_id: "c9", byte_size: 2048 }),
          row({ content_id: "c4", byte_size: 4_299_161 }),
        ]
      )
    ).toStrictEqual([
      { id: "d2", name: "Survey", size: "4.1 MB" },
      { id: "d1", name: "Lease", size: "2 KB" },
    ]);
  });

  it("keeps a row whose byte size was never recorded, without a size", () => {
    expect(
      selectDocRows([doc("d1", "Lease", "2026-02-02T00:00:00.000Z", "c9")], [])
    ).toStrictEqual([{ id: "d1", name: "Lease", size: "" }]);
  });

  it("bounds what reaches the tile", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      doc(`d${i}`, `Doc ${i}`, `2026-01-0${i + 1}T00:00:00.000Z`, `c${i}`)
    );
    expect(selectDocRows(many, [])).toHaveLength(3);
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
      { id: "p1", initials: "A" },
      { id: "p2", initials: "Z", color: "#abc" },
    ]);
  });

  it("does not treat a blank stored colour as a choice", () => {
    // The seeded vault leaves `avatar_color` empty, and an empty string that
    // survives to the renderer wins over the derivation — which is exactly how
    // the tile drew unfilled, near-white circles. Blank is absent.
    const faces = selectFaces(
      [
        row({ party_id: "p1", avatar_color: "" }),
        row({ party_id: "p2", avatar_color: "   " }),
        row({ party_id: "p3", avatar_color: "  #7a5283 " }),
      ],
      new Map([
        ["p1", "Ada Lovelace"],
        ["p2", "Bo Nguyen"],
        ["p3", "Cy Twombly"],
      ])
    );
    expect(faces).toStrictEqual([
      { id: "p1", initials: "A" },
      { id: "p2", initials: "B" },
      // A real stored colour still wins, and only its surrounding space is cut.
      { id: "p3", initials: "C", color: "#7a5283" },
    ]);
  });

  it("identifies a face by party id, never by the name it renders", () => {
    // The id is what the renderer derives the circle's hue from, so a rename
    // must not be able to move it.
    const faces = selectFaces(
      [row({ party_id: "party_ada" })],
      new Map([["party_ada", "Ada Lovelace"]])
    );
    expect(faces[0]?.id).toBe("party_ada");
  });

  it("caps the sample", () => {
    const profiles = Array.from({ length: 9 }, (_value, index) =>
      row({ party_id: `p${index}` })
    );
    expect(selectFaces(profiles, new Map(), 5)).toHaveLength(5);
  });
});

describe(initialsOf, () => {
  it("takes a single initial, and never renders a hole", () => {
    expect(initialsOf("Ada Byron Lovelace")).toBe("A");
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

describe(tileEarnsGrid, () => {
  const tile = (status: TileStatus, kind: "notes" | "locker" = "notes") => ({
    body: { kind },
    status,
  });

  it("admits a tile that has something to show", () => {
    expect(tileEarnsGrid(tile("content"))).toBe(true);
  });

  it("holds the slot while a read is in flight, so nothing relayouts", () => {
    expect(tileEarnsGrid(tile("loading"))).toBe(true);
  });

  it("demotes a settled-empty app to a first move", () => {
    expect(tileEarnsGrid(tile("empty"))).toBe(false);
  });

  it("demotes an unreadable app rather than showing a body it cannot stand behind", () => {
    expect(tileEarnsGrid(tile("unknown"))).toBe(false);
  });

  it("always keeps Locker, whose body is a state and not a query result", () => {
    expect(tileEarnsGrid(tile("unknown", "locker"))).toBe(true);
    expect(tileEarnsGrid(tile("empty", "locker"))).toBe(true);
  });
});

describe(countThings, () => {
  const tile = (over: Partial<TileData>): TileData =>
    ({
      appId: "notes",
      body: { kind: "notes", title: "", excerpt: "" },
      countLabel: "notes",
      status: "content",
      ...over,
    }) as TileData;

  it("sums only the counts a read actually returned", () => {
    expect(
      countThings([
        tile({ count: 8000 }),
        tile({ count: 432 }),
        // Locker withholds its count — omitted, never counted as zero.
        tile({ count: undefined, status: "unknown" }),
      ])
    ).toStrictEqual({ capped: false, settled: true, total: 8432 });
  });

  it("reports the total as a floor when a contributing read hit its ceiling", () => {
    expect(countThings([tile({ count: 200, countCapped: true })]).capped).toBe(
      true
    );
  });

  it("is unsettled while any tile is still reading", () => {
    expect(
      countThings([tile({ count: 3 }), tile({ status: "loading" })]).settled
    ).toBe(false);
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
