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
  // Adversarial (#721): degrade honestly on inputs a real device can hand.
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

/** Deterministic Photos corpus for unit and native component tests. */
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
    // `capturedAtIso` returns `undefined`, never 1970.
    "undated-mixed": [
      asset("undated-a", CAPTURES.newest),
      asset("undated-b", undefined, { source: "device" }),
    ],
    // Degenerate: exactly one Undated section, never fabricate a day.
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
    // 10k in one day (#721/D1). 8s apart from midnight so 10k rows stay
    // inside the same UTC day (10_000 * 8s ≈ 22.2h).
    "ten-k-one-day": Array.from({ length: 10_000 }, (_, index) =>
      asset(
        `tenk-${String(index).padStart(5, "0")}`,
        new Date(
          Date.parse("2026-08-06T00:00:00.000Z") + index * 8_000
        ).toISOString()
      )
    ),
    // Date-line trap (#721): UTC calendar slice DISAGREES with capture-local
    // day. Naive UTC bucketing misfiles these:
    //   utc13-dec31-2330  10:30Z +780 → local Dec 31 23:30
    //   utc-11-jan1-0030  11:30Z -660 → local Jan  1 00:30
    //   utc+1-jan1-0000   23:00Z +60  → local Jan  1 00:00
    //   utc-2-dec31-2300  01:00Z -120 → local Dec 31 23:00
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
    // No tzOffsetMin (#721): `captureLocalDay`'s device-local fallback, not
    // the tzOffsetMin branch every other fixture exercises.
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
    // 99% offloaded (#721): `backupState: "remote-only"` + `source: "replica"`
    // is "bytes in the vault". One locally-resident row anchors the 1%.
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
