// Photos' pending-write projection (issue #738) — pure declaration checks,
// same convention as apps/_shared/pending-overlay.test.ts and
// apps/agenda/pending-projection.test.ts.
import { describe, expect, test } from "vitest";

import { photosPendingProjection } from "./pending-projection.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("Photos' pending-write projection", () => {
  test("update-asset projects only the fields present (favorite/captured_at/archived)", () => {
    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", favorite: 1 },
        ctx("intent-1")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { favorite: 1 },
      },
    ]);

    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", archived: 1 },
        ctx("intent-2")
      )
    ).toMatchObject([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { archived_at: expect.any(String) },
      },
    ]);

    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", archived: 0 },
        ctx("intent-3")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { archived_at: null },
      },
    ]);

    // title lives on core.content_item, not media.media_asset — undeclared.
    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", title: "Renamed" },
        ctx("intent-4")
      )
    ).toStrictEqual([]);
  });

  test("delete-asset/restore flip the soft-delete pair", () => {
    expect(
      photosPendingProjection.actions["delete-asset"]!(
        { asset_id: "asset-1" },
        ctx("intent-5")
      )
    ).toMatchObject([
      { op: "upsert", entity: "media.media_asset", rowId: "asset-1" },
    ]);
    expect(
      photosPendingProjection.actions.restore!(
        { asset_id: "asset-1" },
        ctx("intent-6")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { deleted_at: null, purge_at: null },
      },
    ]);
  });

  test("purge-asset and album membership are deliberately undeclared", () => {
    expect(photosPendingProjection.actions["purge-asset"]).toBeUndefined();
    expect(photosPendingProjection.actions["add-to-album"]).toBeUndefined();
    expect(
      photosPendingProjection.actions["remove-from-album"]
    ).toBeUndefined();
  });
});
