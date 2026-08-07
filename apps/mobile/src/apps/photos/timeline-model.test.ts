import { afterEach, describe, expect, test } from "vitest";

import { makePhotosFixture } from "./photos-fixtures";
import { buildPeriods } from "./timeline-grains";
import {
  addDragSelection,
  captureLocalDay,
  mergePhotoAssets,
  onThisDay,
  sectionPhotoAssets,
} from "./timeline-model";
import type { PhotoAsset } from "./timeline-model";

const photo = (id: string, fields: Partial<PhotoAsset> = {}): PhotoAsset => ({
  id,
  uri: id,
  previewUri: id,
  originalUri: id,
  capturedAt: "2025-07-16T10:00:00.000Z",
  kind: "photo",
  favorite: false,
  archived: false,
  deleted: false,
  backupState: "local-only",
  source: "device",
  ...fields,
});

describe("native Photos timeline model", () => {
  test("shared multi-month fixture reaches the pure grouping model", () => {
    const fixture = makePhotosFixture("multi-month");

    expect(fixture.sections.map((section) => section.month)).toStrictEqual([
      "2026-08",
      "2026-06",
      "2026-03",
    ]);
    expect(fixture.sections.flatMap((section) => section.assets)).toHaveLength(
      fixture.assets.length
    );
  });

  test("sha merges device and replica identities while dHash only marks a review hint", () => {
    const remote = photo("remote", {
      sha256: "exact",
      phash: "similar",
      source: "replica",
      backupState: "remote-only",
    });
    const rows = mergePhotoAssets(
      [
        photo("same", { localId: "local-1", sha256: "exact" }),
        photo("hint", { phash: "similar" }),
      ],
      [remote]
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "remote")).toMatchObject({
      source: "merged",
      localId: "local-1",
    });
    expect(rows.find((row) => row.id === "hint")).toMatchObject({
      duplicateHint: true,
      source: "device",
    });
  });

  test("two device copies of one sha fold onto a single row, both reachable", () => {
    const rows = mergePhotoAssets(
      [
        photo("copy-a", { localId: "local-a", sha256: "exact" }),
        photo("copy-b", { localId: "local-b", sha256: "exact" }),
      ],
      [
        photo("remote", {
          sha256: "exact",
          source: "replica",
          backupState: "remote-only",
        }),
      ]
    );
    // The second copy must not be dropped (the old indexOf(-1) bug), and both
    // localIds must survive so free-up-space can reach every device original.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "merged", localId: "local-a" });
    expect(rows[0]?.localIds).toStrictEqual(["local-a", "local-b"]);
  });

  test("same-sha vault copies keep one writable source and its matching id", () => {
    const rows = mergePhotoAssets(
      [],
      [
        photo("personal-row", {
          assetId: "asset-personal",
          sha256: "same",
          source: "replica",
          sourceVaultId: "personal",
          scopeIds: ["personal"],
          canWrite: false,
        }),
        photo("family-row", {
          assetId: "asset-family",
          sha256: "same",
          source: "replica",
          sourceVaultId: "family",
          scopeIds: ["family"],
          writableScopeIds: ["family"],
          canWrite: true,
        }),
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetId: "asset-family",
      sourceVaultId: "family",
      canWrite: true,
    });
    expect(rows[0]?.scopeIds).toStrictEqual(["personal", "family"]);
  });

  test("sections by capture-local day using tzOffsetMin, not the raw UTC slice", () => {
    // 03:00 UTC in PDT (-420 min) is the previous evening, so it files a day earlier.
    const sections = sectionPhotoAssets([
      photo("evening", {
        capturedAt: "2026-07-16T03:00:00.000Z",
        tzOffsetMin: -420,
      }),
    ]);
    expect(sections[0]?.day).toBe("2026-07-15");
  });

  test("archive and trash never appear in timeline sections", () => {
    expect(
      sectionPhotoAssets([
        photo("live"),
        photo("archive", { archived: true }),
        photo("trash", { deleted: true }),
      ])
    ).toHaveLength(1);
    expect(
      sectionPhotoAssets([photo("live")])[0]?.assets.map((row) => row.id)
    ).toStrictEqual(["live"]);
  });

  test("day sections carry stable month groups for the timeline rail", () => {
    const sections = sectionPhotoAssets([
      photo("july"),
      photo("june", { capturedAt: "2025-06-30T10:00:00.000Z" }),
    ]);
    expect(sections.map((section) => section.month)).toStrictEqual([
      "2025-07",
      "2025-06",
    ]);
    expect(sections[0]?.monthTitle).toContain("2025");
  });

  test("coalesces HEIC and MOV capture companions into one logical timeline asset", () => {
    const rows = mergePhotoAssets(
      [],
      [
        photo("still", { captureGroupId: "live:1", originalUri: "still.heic" }),
        photo("motion", {
          captureGroupId: "live:1",
          kind: "video",
          originalUri: "motion.mov",
        }),
      ]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "still", liveVideoUri: "motion.mov" });
  });

  test("memories are prior years on the same calendar day", () => {
    expect(
      onThisDay(
        [
          photo("old"),
          photo("today", { capturedAt: "2026-07-16T10:00:00.000Z" }),
        ],
        new Date("2026-07-16T12:00:00Z")
      ).map((row) => row.id)
    ).toStrictEqual(["old"]);
  });

  test("drag selection accumulates every asset reached during one gesture", () => {
    const afterFirst = addDragSelection(new Set(["before"]), "first");
    const afterSecond = addDragSelection(afterFirst, "second");
    expect([...afterSecond]).toStrictEqual(["before", "first", "second"]);
  });
});

describe("capture-local day across the date line and the device-local fallback (issue #721 C2)", () => {
  // process.env.TZ swaps the host's local zone at runtime (POSIX) — the same
  // technique packages/client/src/app-format.test.ts uses to pin conversions
  // without mocking Date. Restored after every test so it never leaks into a
  // sibling test file.
  const realTz = process.env.TZ;
  afterEach(() => {
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  test("date-line-crossing sections stay in capture-local order, never raw UTC order", () => {
    const fixture = makePhotosFixture("date-line");
    // Every row's raw UTC capturedAt slice disagrees with its capture-local
    // day (see photos-fixtures.ts's header on this fixture) — sectioning must
    // follow tzOffsetMin, not a naive Date.parse(capturedAt) slice, and must
    // keep the newest-capture-local-first order the fixture was authored in.
    expect(fixture.sections.map((section) => section.day)).toStrictEqual([
      "2026-01-01",
      "2025-12-31",
    ]);
    expect(fixture.sections[0]?.assets.map((asset) => asset.id)).toStrictEqual([
      "utc-11-jan1-0030",
      "utc+1-jan1-0000",
    ]);
    expect(fixture.sections[1]?.assets.map((asset) => asset.id)).toStrictEqual([
      "utc13-dec31-2330",
      "utc-2-dec31-2300",
    ]);
  });

  test("the date-line fixture buckets into the right YEAR periods, not the year its raw UTC instant suggests", () => {
    const fixture = makePhotosFixture("date-line");
    const years = buildPeriods(fixture.sections, "years");
    // The Jan-1-local pair must land in 2026, not 2025, even though two of
    // those rows' raw capturedAt instants are technically still 2025 in UTC —
    // exactly the "wrong YEAR" trap timeline-grains.ts's header warns about.
    expect(years.map((period) => period.key)).toStrictEqual(["2026", "2025"]);
    expect(years[0]?.count).toBe("2 photographs");
    expect(years[1]?.count).toBe("2 photographs");
  });

  test("onThisDay and sectionPhotoAssets agree about which day a date-line capture belongs to", () => {
    process.env.TZ = "UTC";
    // Raw UTC slice says Dec 31 2024; tzOffsetMin +60 puts the capture-local
    // day at Jan 1 2025 — a year before "now" below, so it must surface as a
    // memory, filed under the exact day sectioning would give it alone.
    const dateLineMemory = photo("dateline-memory", {
      capturedAt: "2024-12-31T23:00:00.000Z",
      tzOffsetMin: 60,
    });
    expect(sectionPhotoAssets([dateLineMemory])[0]?.day).toBe("2025-01-01");
    expect(
      onThisDay([dateLineMemory], new Date("2026-01-01T12:00:00Z")).map(
        (row) => row.id
      )
    ).toStrictEqual(["dateline-memory"]);
  });

  test("captureLocalDay falls back to the viewing device's own calendar day when tzOffsetMin is absent", () => {
    // Kiritimati carries a fixed UTC+14 all year (no DST), which flips this
    // instant's calendar day relative to its raw UTC slice — proving the
    // fallback took the device-local branch rather than silently slicing the
    // UTC string.
    process.env.TZ = "Pacific/Kiritimati";
    const capturedAt = "2026-07-16T23:00:00.000Z";
    expect(capturedAt.slice(0, 10)).toBe("2026-07-16"); // the raw UTC day
    expect(captureLocalDay(capturedAt)).toBe("2026-07-17");
    expect(captureLocalDay(capturedAt, undefined)).toBe("2026-07-17");
  });

  test("the fallback branch and the explicit-tzOffsetMin branch agree once the offset matches the pinned zone", () => {
    process.env.TZ = "Pacific/Kiritimati";
    const capturedAt = "2026-07-16T23:00:00.000Z";
    expect(captureLocalDay(capturedAt)).toBe(
      captureLocalDay(capturedAt, 14 * 60)
    );
  });

  test("wrong-camera-clock fixture files a wiped-clock 2003 capture on its own day via the device-local fallback", () => {
    process.env.TZ = "UTC";
    const fixture = makePhotosFixture("wrong-camera-clock");
    const days = fixture.sections.map((section) => section.day);
    expect(days).toStrictEqual(
      expect.arrayContaining(["2003-01-01", "2003-06-15"])
    );
    expect(
      fixture.sections.find((section) => section.day === "2003-01-01")?.assets
    ).toHaveLength(1);
    // None of the wrong-clock rows carry a tzOffsetMin — every one of them
    // exercised the fallback branch, not the one the rest of this suite
    // covers.
    expect(
      fixture.assets
        .filter((asset) => asset.id.startsWith("clock-wrong"))
        .every((asset) => asset.tzOffsetMin === undefined)
    ).toBe(true);
  });
});
