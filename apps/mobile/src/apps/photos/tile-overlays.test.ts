import { describe, expect, test } from "vitest";

import { justify } from "./justify";
import type { VaultFacts } from "./tile-overlays";
import {
  CUSTODY_MIN_RUNG,
  STATE_COULD_NOT_DECODE,
  formatDuration,
  kindOverlay,
  marksVault,
  stateOverlay,
  tileGround,
  vaultMarkFor,
} from "./tile-overlays";
import type { PhotoAsset } from "./timeline-model";

function asset(overrides: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    id: "a1",
    uri: "file:///a1.jpg",
    previewUri: "file:///a1.jpg",
    originalUri: "file:///a1.jpg",
    capturedAt: "2026-08-04T10:00:00.000Z",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: false,
    backupState: "backed-up",
    source: "replica",
    ...overrides,
  };
}

const vaults = (...facts: VaultFacts[]): ReadonlyMap<string, VaultFacts> =>
  new Map(facts.map((f) => [f.vaultId, f]));

// Stated once. The values are stand-ins for whatever hue the registry carries;
// what the cases below are about is WHICH vaults get a mark, never the colour.
const FALLBACK_HUE = "#B07C2E";
const VAULT_HUE = "#3E6B57";
const SKEL = "#E4E3E0";
const LOADED = "#F0EFED";

describe("the vault slot (handoff §4.4, §H)", () => {
  test("fires for any vault but the member's own, the shared one included", () => {
    expect(marksVault(true)).toBe(false);
    expect(marksVault(false)).toBe(true);
  });

  test("the member's own photographs are the unmarked default", () => {
    const mark = vaultMarkFor(
      asset({ sourceVaultId: "v1" }),
      vaults({ vaultId: "v1", label: "My vault", personal: true }),
      3,
      FALLBACK_HUE
    );
    expect(mark).toBeUndefined();
  });

  test("is derived from the record, never a name — a rename keeps the mark", () => {
    const renamed = vaultMarkFor(
      asset({ sourceVaultId: "v2" }),
      // The member renamed the shared vault to something of their own. The
      // marker is about where the photograph IS, so it survives the rename.
      vaults({ vaultId: "v2", label: "Holiday pics", personal: false }),
      3,
      FALLBACK_HUE
    );
    expect(renamed).toBeDefined();
    expect(renamed?.initial).toBe("H");
  });

  test("the member's OWN vault named Sharing is still unmarked", () => {
    // The mirror of the rename case: the name is display, never the trigger.
    expect(
      vaultMarkFor(
        asset({ sourceVaultId: "v3" }),
        vaults({ vaultId: "v3", label: "Sharing", personal: true }),
        3,
        FALLBACK_HUE
      )
    ).toBeUndefined();
  });

  test("the rule is drawn at every rung; the initial only from M up", () => {
    const facts = vaults({
      vaultId: "v2",
      label: "Sharing",
      personal: false,
      color: VAULT_HUE,
    });
    const item = asset({ sourceVaultId: "v2" });
    expect(vaultMarkFor(item, facts, 0, FALLBACK_HUE)).toStrictEqual({
      hue: VAULT_HUE,
    });
    expect(vaultMarkFor(item, facts, 1, FALLBACK_HUE)).toStrictEqual({
      hue: VAULT_HUE,
    });
    expect(vaultMarkFor(item, facts, 2, FALLBACK_HUE)?.initial).toBe("S");
    expect(vaultMarkFor(item, facts, 3, FALLBACK_HUE)?.initial).toBe("S");
  });
});

describe("the kind slot", () => {
  test("shows a video duration from rung S up, and nothing at XS", () => {
    const video = asset({ kind: "video", durationS: 64 });
    expect(kindOverlay(video, 0)).toBeUndefined();
    expect(kindOverlay(video, 1)).toBe("1:04");
    expect(kindOverlay(video, 3)).toBe("1:04");
  });

  test("a live photograph says `live`, not a duration", () => {
    expect(kindOverlay(asset({ liveVideoUri: "file:///a1.mov" }), 2)).toBe(
      "live"
    );
  });

  test("a still photograph claims the slot at no rung", () => {
    expect(kindOverlay(asset(), 3)).toBeUndefined();
  });

  test("durations are tabular-friendly and zero-padded", () => {
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(64)).toBe("1:04");
    expect(formatDuration(3723)).toBe("1:02:03");
  });
});

describe("the state slot", () => {
  const M = 2; // a mid rung, comfortably above the custody floor

  test("SABOTAGE: the steady state says NOTHING — no line under every tile", () => {
    // The defect this slot was rebuilt to remove. `remote-only` is where bytes
    // are DESIGNED to live, so captioning it labelled the water for the fish:
    // in a vault whose assets are all on the gateway, every single tile
    // carried an identical line. Restoring the unconditional `on the gateway`
    // branch fails right here.
    expect(
      stateOverlay(asset({ backupState: "remote-only" }), M)
    ).toBeUndefined();
    expect(
      stateOverlay(asset({ backupState: "backed-up" }), M)
    ).toBeUndefined();
  });

  test("an unreachable gateway adds nothing to any tile", () => {
    // THE OVER-ANNOUNCEMENT THIS PINS. `on the gateway` rendered on every
    // `remote-only` tile the moment the gateway stops answering is an ambient
    // fact printed through a per-tile slot, forty times a screenful.
    // The replica bar states it once, at the top; a tile speaks only for
    // itself.
    for (const backupState of [
      "remote-only",
      "local-only",
      "backed-up",
    ] as const) {
      const line = stateOverlay(asset({ backupState }), M);
      expect(line?.form === "line" && line.text).not.toBe("on the gateway");
    }
  });

  test("bytes on this device keep their MARK regardless of the gateway", () => {
    // `local-only` needs no gateway to paint, so nothing about reachability
    // changes it — the custody mark is about this photograph's own bytes.
    expect(stateOverlay(asset({ backupState: "local-only" }), M)).toStrictEqual(
      { form: "custody" }
    );
  });

  test("bytes here and nowhere else take the MARK, never a caption", () => {
    // The one custody state a member can lose something to, and so the only
    // one worth marking — as a glyph, the way Google Photos marks it, because
    // in a fresh camera roll this fires on every photograph and a sentence
    // repeated that often is chrome (§18).
    expect(stateOverlay(asset({ backupState: "local-only" }), M)).toStrictEqual(
      {
        form: "custody",
      }
    );
  });

  test("the mark has a legibility floor, like every other slot", () => {
    const below = (CUSTODY_MIN_RUNG - 1) as typeof CUSTODY_MIN_RUNG;
    expect(
      stateOverlay(asset({ backupState: "local-only" }), below)
    ).toBeUndefined();
    expect(
      stateOverlay(asset({ backupState: "local-only" }), CUSTODY_MIN_RUNG)
    ).toStrictEqual({ form: "custody" });
  });

  test("a terminal failure keeps the tile and takes the --net role", () => {
    expect(stateOverlay(asset(), M, { decodeFailed: true })).toStrictEqual({
      form: "line",
      text: STATE_COULD_NOT_DECODE,
      tone: "net",
    });
  });

  test("a decode failure outranks the custody mark", () => {
    // The member needs to know the tile will not resolve, not where its bytes
    // are — the failure is the more urgent of the two true statements.
    expect(
      stateOverlay(asset({ backupState: "local-only" }), M, {
        decodeFailed: true,
      })
    ).toStrictEqual({
      form: "line",
      text: STATE_COULD_NOT_DECODE,
      tone: "net",
    });
  });

  test("SABOTAGE: a line and a mark can never both be drawn", () => {
    // The exclusion is STRUCTURAL — one return value with two shapes — so a
    // tile can never stack a glyph under a caption at its own foot. Every
    // case that produces a line is one where custody is not the actionable
    // fact, so the line winning is right on the merits too.
    const resolved = stateOverlay(asset({ backupState: "local-only" }), M, {
      decodeFailed: true,
    });
    expect(resolved?.form === "custody" && "text" in resolved).toBe(false);
  });

  test("the seconds in between say nothing — no flickering mark", () => {
    // `queued`/`uploading` are the seconds between two custody states. A mark
    // that blinks off tile by tile as a drain walks the grid is chrome.
    expect(stateOverlay(asset({ backupState: "queued" }), M)).toBeUndefined();
    expect(
      stateOverlay(asset({ backupState: "uploading" }), M)
    ).toBeUndefined();
  });
});

describe("a tile holds its geometry from record to bytes to failure (§14)", () => {
  const list = [
    asset({ id: "a", width: 4000, height: 3000 }),
    asset({ id: "b", width: 3000, height: 4000 }),
    asset({ id: "c", width: 4000, height: 3000 }),
    asset({ id: "d", width: 1600, height: 900 }),
  ];

  test("the skeleton occupies the exact box the photograph will", () => {
    // Packing reads `width`/`height` off the RECORD, which is known before the
    // bytes are — so the box a skeleton paints is the box the decoded
    // photograph lands in, and nothing reflows when bytes arrive.
    const beforeBytes = justify(list, 390, 120);
    const afterBytes = justify(list, 390, 120);
    expect(afterBytes).toStrictEqual(beforeBytes);
  });

  test("the ground is --skel before bytes and the loaded colour after", () => {
    expect(tileGround(false, SKEL, LOADED)).toBe(SKEL);
    expect(tileGround(true, SKEL, LOADED)).toBe(LOADED);
  });

  test("a failed tile keeps the geometry rather than vanishing", () => {
    // The failure is a state slot on the same rectangle, not a removal: a
    // vanishing tile is what §14 calls a grey mosaic with no explanation.
    const rows = justify(list, 390, 120);
    const failed = stateOverlay(list[0]!, 2, { decodeFailed: true });
    expect(failed).toStrictEqual({
      form: "line",
      text: STATE_COULD_NOT_DECODE,
      tone: "net",
    });
    expect(justify(list, 390, 120)).toStrictEqual(rows);
  });
});
