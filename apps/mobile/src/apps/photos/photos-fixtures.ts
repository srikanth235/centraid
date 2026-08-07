import { sectionPhotoAssets } from "./timeline-model";
import type { PhotoAsset, PhotoSection } from "./timeline-model";

export type PhotosFixtureName =
  | "empty"
  | "one-day"
  | "multi-month"
  | "year-spanning"
  | "video-mixed"
  | "place-tagged"
  | "undated-mixed";

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
  };
  const assets = byName[name].map((entry) => ({ ...entry }));
  return { assets, sections: sectionPhotoAssets(assets) };
}
