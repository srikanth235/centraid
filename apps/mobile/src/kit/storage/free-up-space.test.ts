// The eligibility predicate, the delete-time revalidation, and (issue #712,
// B3) the rollup-fed OFFER. The module moved from `apps/photos/` to `kit/` in
// that pass and the fixture moved with it: it is built from the structural
// `FreeUpAsset` this module declares, not from Photos' `PhotoAsset`, because
// `kit/` may not import an app — and the shape is exactly what an app has to
// satisfy to take part.
import { describe, expect, test } from "vitest";

import {
  freeUpOffer,
  revalidateBackedUp,
  selectFreeUpCandidates,
} from "./free-up-space";
import type {
  DeviceByteProbe,
  FreeUpAsset,
  FreeUpCandidate,
} from "./free-up-space";

const backedUp = (
  id: string,
  fields: Partial<FreeUpAsset> = {}
): FreeUpAsset => ({
  assetId: `asset-${id}`,
  localId: `local-${id}`,
  localIds: [`local-${id}`],
  sha256: `sha-${id}`,
  fileSize: 1_000,
  backupState: "backed-up",
  verifiedCasAck: true,
  source: "merged",
  ...fields,
});

describe("free-up-space eligibility", () => {
  test("selects only verifiably backed-up, unprotected copies", () => {
    const candidates = selectFreeUpCandidates(
      [
        backedUp("ok"),
        backedUp("unverified", { verifiedCasAck: false }),
        backedUp("remoteOnly", {
          source: "replica",
          localId: undefined,
          localIds: [],
        }),
        backedUp("queued", { backupState: "queued" }),
        backedUp("pinned"),
      ],
      new Set(["asset-pinned"])
    );
    expect(candidates.map((candidate) => candidate.assetId)).toStrictEqual([
      "asset-ok",
    ]);
  });

  test("excludes a pin whose membership id is a folded copy, not the canonical assetId", () => {
    const candidates = selectFreeUpCandidates(
      [
        backedUp("family", {
          assetId: "asset-family",
          assetIds: ["asset-personal", "asset-family"],
        }),
      ],
      new Set(["asset-personal"])
    );
    expect(candidates).toStrictEqual([]);
  });

  test("collects every device copy of one backed-up sha", () => {
    const [candidate] = selectFreeUpCandidates(
      [backedUp("dup", { localIds: ["local-a", "local-b"] })],
      new Set()
    );
    expect(candidate?.localIds).toStrictEqual(["local-a", "local-b"]);
  });

  test("revalidation keeps matches and excludes bytes that changed since backup", async () => {
    const candidates: FreeUpCandidate[] = [
      {
        assetId: "a",
        localIds: ["stable", "edited", "gone"],
        sha256: "sha-a",
        fileSize: 10,
      },
    ];
    const probe: DeviceByteProbe = async (localId) =>
      localId === "stable"
        ? { sha256: "sha-a", size: 42 }
        : localId === "edited"
          ? { sha256: "sha-DIFFERENT", size: 99 } // edited in place after backup
          : null; // OS no longer has the copy
    const result = await revalidateBackedUp(candidates, probe);
    expect(result.deletableLocalIds).toStrictEqual(["stable"]);
    expect(result.eligibleBytes).toBe(42);
    expect(result.changedCount).toBe(1);
    expect(result.missingCount).toBe(1);
  });

  test("an iCloud-only original is reported apart from a missing one", async () => {
    const result = await revalidateBackedUp(
      [
        {
          assetId: "a",
          localIds: ["cloud", "gone"],
          sha256: "sha-a",
          fileSize: 5,
        },
      ],
      async (localId) => (localId === "cloud" ? "in-cloud" : null)
    );
    expect(result.deletableLocalIds).toStrictEqual([]);
    expect(result.inCloudCount).toBe(1);
    expect(result.missingCount).toBe(1);
  });

  test("a probe failure is treated as missing, never as deletable", async () => {
    const result = await revalidateBackedUp(
      [{ assetId: "a", localIds: ["boom"], sha256: "sha-a", fileSize: 5 }],
      async () => {
        throw new Error("read failed");
      }
    );
    expect(result.deletableLocalIds).toStrictEqual([]);
    expect(result.missingCount).toBe(1);
  });

  test("an offer needs a computed rollup — an unrun sweep is not 'nothing'", () => {
    // The whole reason `computedAt` travels as null on the wire: zeroes from
    // an unrun sweep read as "you have nothing to free" when the truth is
    // "nobody has looked". A surface must be able to say those differently.
    expect(
      freeUpOffer({ computedAt: null, freeable: { count: 0, bytes: 0 } }, [
        "photos",
      ])
    ).toStrictEqual({ kind: "uncounted" });
  });

  test("a counted rollup with a freeable bucket becomes an offer of that bucket", () => {
    expect(
      freeUpOffer(
        {
          computedAt: "2026-08-06T00:00:00.000Z",
          freeable: { count: 4, bytes: 900 },
        },
        ["photos", "docs"]
      )
    ).toStrictEqual({ kind: "offer", totals: { count: 4, bytes: 900 } });
  });

  test("nothing freeable, or zero bytes, is an offer with no effect and so is not one", () => {
    const computedAt = "2026-08-06T00:00:00.000Z";
    expect(
      freeUpOffer({ computedAt, freeable: { count: 0, bytes: 0 } }, ["photos"])
    ).toStrictEqual({ kind: "nothing" });
    expect(
      freeUpOffer({ computedAt, freeable: { count: 3, bytes: 0 } }, ["photos"])
    ).toStrictEqual({ kind: "nothing" });
  });

  test("no participating app means no offer — the exclusion lives in the CALLER's list", () => {
    // Locker (bytes are the secret) and record-only apps are excluded by never
    // appearing in the list a caller passes. This module enumerates no apps, so
    // an empty list must be a real answer rather than a vacuous "everything".
    expect(
      freeUpOffer(
        {
          computedAt: "2026-08-06T00:00:00.000Z",
          freeable: { count: 9, bytes: 100 },
        },
        []
      )
    ).toStrictEqual({ kind: "nothing" });
  });
});
