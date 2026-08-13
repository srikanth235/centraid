// Trash's per-item countdown (proto:4446-4449, §5).
//
// Its own file rather than a block inside `tile-overlays.test.ts`: the rule
// under test is the TRASH SHELF's, and it is asserted against the same
// derivation the web ships (`packages/blueprints/apps/photos/queries/
// library.ts` → `purge_in_days`, and `components/Timeline.tsx` → the wording).
// Two surfaces, one countdown; if either drifts, this fails.
import { describe, expect, it } from "vitest";

import { purgeInDays, purgeNote, stateOverlay } from "./tile-overlays";
import type { PhotoAsset } from "./timeline-model";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

function asset(overrides: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    id: "a1",
    uri: "file://a1",
    previewUri: "file://a1",
    originalUri: "file://a1",
    capturedAt: "2026-07-01T00:00:00.000Z",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: true,
    backupState: "backed-up",
    source: "replica",
    ...overrides,
  };
}

describe("days until the sweep purges", () => {
  it("rounds UP, so hours left still read as a day", () => {
    expect(purgeInDays(new Date(NOW + DAY / 4).toISOString(), NOW)).toBe(1);
    expect(purgeInDays(new Date(NOW + 28 * DAY).toISOString(), NOW)).toBe(28);
  });

  it("never goes negative — an overdue purge is 'today', not '-3 days'", () => {
    expect(purgeInDays(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe(0);
  });

  it("is absent rather than invented when there is no readable date", () => {
    expect(purgeInDays(undefined, NOW)).toBeUndefined();
    expect(purgeInDays("not a date", NOW)).toBeUndefined();
  });

  it("words the countdown exactly as the web's timeline words it", () => {
    expect(purgeNote(0)).toBe("purges today");
    expect(purgeNote(1)).toBe("purges in 1 day");
    expect(purgeNote(28)).toBe("purges in 28 days");
  });
});

describe("the countdown lands in the tile's state slot", () => {
  const M = 2; // a mid rung, above every slot's legibility floor

  it("outranks custody — how long it has left beats where it lives", () => {
    const overlay = stateOverlay(
      asset({
        backupState: "remote-only",
        purgeAt: new Date(Date.now() + 5 * DAY).toISOString(),
      }),
      M
    );
    expect(overlay?.form).toBe("line");
    if (overlay?.form !== "line") throw new Error("expected a line");
    expect(overlay.text).toMatch(/^purges in \d+ days?$/u);
    // Mono on the page colour in the EXPIRING register (`--seam`, issue
    // #765): a trashed photograph is not an error, and `--net` here would
    // paint the whole shelf red (§4.4) — but it is not a settled fact either,
    // which is precisely the state `--seam` names.
    expect(overlay.tone).toBe("seam");
  });

  it("takes the slot from the custody mark, never sits beside it", () => {
    // A trashed photograph that is also `local-only` is a real combination,
    // and the two would otherwise land in the same corner of the same tile.
    // Days-until-gone is the one a member can act on.
    expect(
      stateOverlay(
        asset({
          backupState: "local-only",
          purgeAt: new Date(Date.now() + 5 * DAY).toISOString(),
        }),
        M
      )
    ).toStrictEqual({
      form: "line",
      text: purgeNote(5),
      tone: "seam",
    });
  });

  it("leaves every other shelf's state slot alone", () => {
    // Outside Trash the slot is silent for the two custody states that are
    // NORMAL, and carries the mark for the one that is not.
    expect(
      stateOverlay(asset({ backupState: "remote-only" }), M)
    ).toBeUndefined();
    expect(
      stateOverlay(asset({ backupState: "backed-up" }), M)
    ).toBeUndefined();
    expect(stateOverlay(asset({ backupState: "local-only" }), M)).toStrictEqual(
      {
        form: "custody",
      }
    );
  });

  it("still says 'could not decode' first — a tile that will not resolve", () => {
    const overlay = stateOverlay(
      asset({ purgeAt: new Date(Date.now() + DAY).toISOString() }),
      M,
      { decodeFailed: true }
    );
    expect(overlay).toStrictEqual({
      form: "line",
      text: "could not decode",
      tone: "net",
    });
  });
});
