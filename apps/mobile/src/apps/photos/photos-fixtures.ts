import { sectionPhotoAssets } from "./timeline-model";
import type { PhotoAsset, PhotoSection } from "./timeline-model";

export type PhotosFixtureName =
  | "empty"
  | "one-day"
  | "multi-month"
  | "year-spanning"
  | "video-mixed"
  | "place-tagged"
  | "undated-mixed"
  // Adversarial fixtures (#721) — the corpora above prove the happy
  // path groups correctly; these prove the model degrades honestly, not
  // silently, on inputs a real device/backfill can actually hand it.
  | "all-undated"
  | "ten-k-one-day"
  | "date-line"
  | "wrong-camera-clock"
  | "mostly-offloaded";

export interface PhotosFixture {
  assets: PhotoAsset[];
  sections: PhotoSection[];
}

const CAPTURES = {
  newest: "2026-08-06T18:30:00.000Z",
  previousDay: "2026-08-05T09:15:00.000Z",
  previousMonth: "2026-06-21T16:00:00.000Z",
  previousYear: "2025-12-31T23:45:00.000Z",
  oldestYear: "2024-02-10T08:00:00.000Z",
} as const;

function asset(
  id: string,
  capturedAt: string | undefined,
  patch: Partial<PhotoAsset> = {}
): PhotoAsset {
  return {
    archived: false,
    backupState: "backed-up",
    ...(capturedAt === undefined ? {} : { capturedAt }),
    deleted: false,
    favorite: false,
    filename: `${id}.jpg`,
    height: 1200,
    id,
    kind: "photo",
    originalUri: `https://fixture.invalid/original/${id}`,
    previewUri: `https://fixture.invalid/thumb/${id}`,
    source: "replica",
    tzOffsetMin: 0,
    uri: `https://fixture.invalid/thumb/${id}`,
    width: 1600,
    ...patch,
  };
}

/**
 * The one deterministic Photos corpus used by unit and native component
 * tests. Its dates and labels mirror the demo vault's journey claims while
 * avoiding clock, locale, network, and random-id dependencies.
 */
export function makePhotosFixture(name: PhotosFixtureName): PhotosFixture {
  const byName: Record<PhotosFixtureName, PhotoAsset[]> = {
    empty: [],
    "one-day": [
      asset("day-a", CAPTURES.newest),
      asset("day-b", "2026-08-06T11:10:00.000Z", { favorite: true }),
    ],
    "multi-month": [
      asset("month-a", CAPTURES.newest),
      asset("month-b", CAPTURES.previousMonth),
      asset("month-c", "2026-03-14T12:00:00.000Z"),
    ],
    "year-spanning": [
      asset("year-a", CAPTURES.newest),
      asset("year-b", CAPTURES.previousYear),
      asset("year-c", CAPTURES.oldestYear),
    ],
    "video-mixed": [
      asset("mixed-photo", CAPTURES.newest),
      asset("mixed-video", CAPTURES.previousDay, {
        durationS: 12,
        filename: "mixed-video.mp4",
        kind: "video",
      }),
    ],
    "place-tagged": [
      asset("place-tahoe", CAPTURES.newest, { placeId: "place-tahoe" }),
      asset("place-home", CAPTURES.previousDay, { placeId: "place-home" }),
    ],
    // A device row whose media store recorded neither timestamp
    // (`device-media.ts`'s `capturedAtIso` returns `undefined`, never 1970).
    // Exercises the Undated section end to end alongside a normally-dated row.
    "undated-mixed": [
      asset("undated-a", CAPTURES.newest),
      asset("undated-b", undefined, { source: "device" }),
    ],
    // Every row undated — the degenerate end of "undated-mixed": nothing to
    // anchor a day/month/year on, so `sectionPhotoAssets` must emit exactly
    // one Undated section and no dated ones, never fabricate a day for any
    // of them.
    "all-undated": [
      asset("all-undated-a", undefined, { source: "device" }),
      asset("all-undated-b", undefined, { source: "replica" }),
      asset("all-undated-c", undefined, {
        durationS: 4,
        filename: "all-undated-c.mp4",
        kind: "video",
        source: "device",
      }),
    ],
    // 10k captures inside one calendar day (#721/D1): the timeline's
    // day-grouping cost is one bucket holding everything, not n buckets of
    // one — the pathological case a real "shot a wedding" burst produces.
    // Spaced 8s apart from local midnight so 10k rows still land inside the
    // same UTC day with room to spare (10_000 * 8s ≈ 22.2h).
    "ten-k-one-day": Array.from({ length: 10_000 }, (_, index) =>
      asset(
        `tenk-${String(index).padStart(5, "0")}`,
        new Date(
          Date.parse("2026-08-06T00:00:00.000Z") + index * 8_000
        ).toISOString()
      )
    ),
    // The international-date-line trap (#721): two capture-local
    // wall clocks 30–90 minutes apart in real elapsed time, each carrying its
    // own tzOffsetMin, that straddle both the date line AND the 2025→2026
    // year boundary. Every asset's raw UTC calendar slice DISAGREES with its
    // capture-local day — the exact case `captureLocalDay`'s doc comment
    // warns a naive UTC bucketing would misfile:
    //   utc13-dec31-2330  capturedAt 10:30Z, tz +780 (UTC+13) → local Dec 31 23:30
    //   utc-11-jan1-0030  capturedAt 11:30Z, tz -660 (UTC-11) → local Jan  1 00:30
    //   utc+1-jan1-0000   capturedAt 23:00Z (Dec 31!), tz +60 → local Jan  1 00:00
    //   utc-2-dec31-2300  capturedAt 01:00Z (Jan 1!), tz -120 → local Dec 31 23:00
    // Ordered newest-capture-local-first, matching every other fixture here,
    // so a consumer asserting section/order gets the same convention.
    "date-line": [
      asset("utc-11-jan1-0030", "2026-01-01T11:30:00.000Z", {
        tzOffsetMin: -660,
      }),
      asset("utc+1-jan1-0000", "2025-12-31T23:00:00.000Z", {
        tzOffsetMin: 60,
      }),
      asset("utc13-dec31-2330", "2025-12-31T10:30:00.000Z", {
        tzOffsetMin: 780,
      }),
      asset("utc-2-dec31-2300", "2026-01-01T01:00:00.000Z", {
        tzOffsetMin: -120,
      }),
    ],
    // A camera whose clock forgot the date entirely (#721): rows
    // from a live 2026 shoot beside rows the same device stamped in 2003,
    // AND with no tzOffsetMin recorded — device-media.ts never backfills one
    // it did not read off the file — so these fall through to the
    // device-local fallback branch of `captureLocalDay`, not the tzOffsetMin
    // branch every other fixture here exercises.
    "wrong-camera-clock": [
      asset("clock-current", CAPTURES.newest),
      asset("clock-current-2", CAPTURES.previousDay),
      asset("clock-wrong-2003-a", "2003-01-01T00:00:00.000Z", {
        tzOffsetMin: undefined,
      }),
      asset("clock-wrong-2003-b", "2003-06-15T12:00:00.000Z", {
        tzOffsetMin: undefined,
      }),
    ],
    // 99% offloaded (#721): `PhotoAsset` has no separate "offloaded"
    // boolean — `backupState: "remote-only"` + `source: "replica"` IS how the
    // model already spells "bytes live in the vault, not on this device"
    // (the same pair `mergePhotoAssets`' own tests use for a replica-only
    // row). One locally-resident row anchors the 1% so a consumer can prove
    // it still renders correctly amid an almost-entirely-offloaded library.
    "mostly-offloaded": Array.from({ length: 100 }, (_, index) =>
      asset(
        `offload-${String(index).padStart(3, "0")}`,
        new Date(
          Date.parse("2026-08-01T00:00:00.000Z") - index * 3_600_000
        ).toISOString(),
        index === 0
          ? { backupState: "backed-up", source: "device" }
          : { backupState: "remote-only", source: "replica" }
      )
    ),
  };
  const assets = byName[name].map((entry) => ({ ...entry }));
  return { assets, sections: sectionPhotoAssets(assets) };
}
