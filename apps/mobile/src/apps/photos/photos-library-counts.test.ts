// The head counts are a fold, not a filter (#880): what the Library index
// shows must be identical to the four inline `assets.filter(...).length` passes
// and the two face-row passes they replaced — the change is how often they run,
// never what they say.
import { describe, expect, test } from "vitest";

import { faceReviewCounts, photoLibraryCounts } from "./photos-library-counts";
import type { PhotoAsset } from "./timeline-model";

function asset(flags: Partial<PhotoAsset>): PhotoAsset {
  return {
    id: "asset",
    uri: "uri",
    previewUri: "uri",
    originalUri: "uri",
    capturedAt: "2026-01-01T00:00:00.000Z",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: false,
    backupState: "remote-only",
    source: "replica",
    ...flags,
  };
}

const LIBRARY = [
  asset({ id: "a", favorite: true }),
  asset({ id: "b", favorite: true, duplicateHint: true }),
  asset({ id: "c", archived: true }),
  asset({ id: "d", deleted: true, duplicateHint: true }),
  // Trash and archive are independent states; a row may report both.
  asset({ id: "e", archived: true, deleted: true }),
  asset({ id: "f" }),
];

describe(photoLibraryCounts, () => {
  test("counts each state over one pass", () => {
    expect(photoLibraryCounts(LIBRARY)).toStrictEqual({
      favorites: 2,
      archived: 2,
      deleted: 2,
      duplicates: 2,
    });
  });

  test("agrees with the per-state filters it replaced", () => {
    const counts = photoLibraryCounts(LIBRARY);
    expect(counts.favorites).toBe(
      LIBRARY.filter((item) => item.favorite).length
    );
    expect(counts.archived).toBe(
      LIBRARY.filter((item) => item.archived).length
    );
    expect(counts.deleted).toBe(LIBRARY.filter((item) => item.deleted).length);
    expect(counts.duplicates).toBe(
      LIBRARY.filter((item) => item.duplicateHint).length
    );
  });

  test("an empty library is four zeroes, not a withheld count", () => {
    expect(photoLibraryCounts([])).toStrictEqual({
      favorites: 0,
      archived: 0,
      deleted: 0,
      duplicates: 0,
    });
  });
});

describe(faceReviewCounts, () => {
  test("counts distinct named parties and proposed regions", () => {
    const rows = [
      { party_id: "party-a", review_state: "confirmed" },
      { party_id: "party-a", review_state: "proposed" },
      { party_id: "party-b", review_state: "proposed" },
      // Not yet anybody: an unnamed region is a proposal without a party.
      { party_id: null, review_state: "proposed" },
      { party_id: "", review_state: "rejected" },
    ];

    expect(faceReviewCounts(rows)).toStrictEqual({ people: 2, proposals: 3 });
  });
});
