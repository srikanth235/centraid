// Free-up-space must not delete originals in a keep-on-device album
// (issue #864 free-up-pinned).
//
// Album membership is `core.collection_entry.target_id` = that scope's
// `media_asset.asset_id`. SHA merge keeps one canonical `assetId` (the
// writable copy). Indexing the pin join on that survivor alone silently
// resolves the other copy's album entry to nothing, and the confirm copy
// still promised exclusion.
import { describe, expect, it } from "vitest";

import { selectFreeUpCandidates } from "../../kit/storage/free-up-space";
import type { FreeUpAsset } from "../../kit/storage/free-up-space";
import { protectedAssetIdsFromPins } from "./photos-library-pins";
import type { PhotoAsset } from "./timeline-model";

function entry(
  collectionId: string,
  targetId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { collection_id: collectionId, target_id: targetId, ...extra };
}

function photo(
  id: string,
  extra: Partial<PhotoAsset> & Partial<FreeUpAsset> = {}
): PhotoAsset & FreeUpAsset {
  return {
    archived: false,
    assetId: `asset-${id}`,
    backupState: "backed-up",
    deleted: false,
    favorite: false,
    fileSize: 1_000,
    id: `row-${id}`,
    kind: "photo",
    localIds: [`local-${id}`],
    originalUri: `original-${id}`,
    previewUri: "",
    sha256: `sha-${id}`,
    source: "merged",
    uri: `uri-${id}`,
    verifiedCasAck: true,
    ...extra,
  };
}

describe("the keep-originals pin join", () => {
  it("excludes a pinned album original whose membership id is not the merged row's canonical assetId", () => {
    const assets = [
      photo("family", {
        assetId: "asset-family",
        assetIds: ["asset-personal", "asset-family"],
        id: "row-family",
      }),
      photo("loose"),
    ];
    const protectedIds = protectedAssetIdsFromPins(
      [entry("vacation", "asset-personal"), entry("other", "asset-loose")],
      ["vacation"],
      assets
    );
    expect([...protectedIds].sort()).toStrictEqual([
      "asset-family",
      "asset-personal",
      "row-family",
    ]);
    expect(
      selectFreeUpCandidates(assets, protectedIds).map((row) => row.assetId)
    ).toStrictEqual(["asset-loose"]);
  });

  it("does not treat a non-asset collection entry as a pinned photograph", () => {
    const assets = [photo("ok")];
    const protectedIds = protectedAssetIdsFromPins(
      [
        entry("vacation", "asset-ok", { target_type: "core.collection" }),
        entry("vacation", "not-a-photo", { target_type: "core.place" }),
      ],
      ["vacation"],
      assets
    );
    expect(protectedIds.size).toBe(0);
    expect(
      selectFreeUpCandidates(assets, protectedIds).map((row) => row.assetId)
    ).toStrictEqual(["asset-ok"]);
  });
});
