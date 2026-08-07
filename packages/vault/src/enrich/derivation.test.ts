// Derivation provenance (issue #724 W2) — behaviour: what a stamp says after
// a re-run, and which targets a version bump hands back to the sweep.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  stampDerivation,
  stampedModel,
  supersededTargets,
} from "./derivation.js";

const T0 = "2026-07-15T00:00:00.000Z";
const T1 = "2026-07-16T00:00:00.000Z";

function stamp(
  db: VaultDb,
  targetId: string,
  model: string,
  extra: { variant?: string; capability?: string; payload?: unknown } = {}
): void {
  stampDerivation(db.vault, {
    targetType: "media.media_asset",
    targetId,
    variant: extra.variant ?? "caption",
    capability: extra.capability ?? "ocr",
    model,
    ...(extra.payload === undefined ? {} : { payload: extra.payload }),
    now: T0,
  });
}

describe("derivation", () => {
  test("a stamp names the model whose output is on disk right now", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1", { payload: { regions: 3 } });
    expect(
      stampedModel(db.vault, {
        targetType: "media.media_asset",
        targetId: "asset-1",
        variant: "caption",
      })
    ).toBe("tess@1");
    const row = db.vault
      .prepare(
        "SELECT capability, payload_json, produced_at FROM enrich_derivation WHERE target_id = ?"
      )
      .get("asset-1") as {
      capability: string;
      payload_json: string;
      produced_at: string;
    };
    expect(row.capability).toBe("ocr");
    expect(JSON.parse(row.payload_json)).toStrictEqual({ regions: 3 });
    expect(row.produced_at).toBe(T0);
    db.close();
  });

  test("re-deriving replaces the stamp instead of growing a second one", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1");
    stampDerivation(db.vault, {
      targetType: "media.media_asset",
      targetId: "asset-1",
      variant: "caption",
      capability: "ocr",
      model: "tess@2",
      now: T1,
    });
    const rows = db.vault
      .prepare(
        "SELECT model, produced_at FROM enrich_derivation WHERE target_id = ?"
      )
      .all("asset-1") as unknown as { model: string; produced_at: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "tess@2", produced_at: T1 });
    db.close();
  });

  test("two variants of one target are two independent stamps", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1", { variant: "caption" });
    stamp(db, "asset-1", "asr@1", { variant: "transcript" });
    expect(
      stampedModel(db.vault, {
        targetType: "media.media_asset",
        targetId: "asset-1",
        variant: "transcript",
      })
    ).toBe("asr@1");
    expect(
      stampedModel(db.vault, {
        targetType: "media.media_asset",
        targetId: "asset-1",
        variant: "caption",
      })
    ).toBe("tess@1");
    db.close();
  });

  test("a target nothing has derived yet has no stamp at all", () => {
    const db = openVaultDb();
    expect(
      stampedModel(db.vault, {
        targetType: "media.media_asset",
        targetId: "never-seen",
        variant: "caption",
      })
    ).toBeNull();
    db.close();
  });

  test("a version bump hands back exactly the targets the old model produced", () => {
    const db = openVaultDb();
    stamp(db, "old-1", "tess@1");
    stamp(db, "old-2", "tess@1");
    stamp(db, "current", "tess@2");
    const superseded = supersededTargets(db.vault, {
      capability: "ocr",
      variant: "caption",
      currentModel: "tess@2",
    });
    expect(superseded.map((row) => row.targetId)).toStrictEqual([
      "old-1",
      "old-2",
    ]);
    expect(superseded[0]!.model).toBe("tess@1");
    db.close();
  });

  test("another model's rows are left alone, and so are unparseable ones", () => {
    const db = openVaultDb();
    stamp(db, "other-family", "paddle@9");
    stamp(db, "hand-written", "my ocr (final)");
    stamp(db, "newer", "tess@5");
    expect(
      supersededTargets(db.vault, {
        capability: "ocr",
        variant: "caption",
        currentModel: "tess@2",
      })
    ).toStrictEqual([]);
    db.close();
  });

  test("the selector is scoped by capability, variant, family and bounded by limit", () => {
    const db = openVaultDb();
    stamp(db, "a", "tess@1");
    stamp(db, "b", "tess@1");
    stamp(db, "c", "tess@1", {
      variant: "transcript",
      capability: "transcript",
    });
    stampDerivation(db.vault, {
      targetType: "core.content_item",
      targetId: "doc-1",
      variant: "caption",
      capability: "ocr",
      model: "tess@1",
      now: T0,
    });

    expect(
      supersededTargets(db.vault, {
        capability: "ocr",
        variant: "caption",
        currentModel: "tess@2",
        limit: 1,
      })
    ).toHaveLength(1);
    expect(
      supersededTargets(db.vault, {
        capability: "ocr",
        variant: "caption",
        currentModel: "tess@2",
        targetType: "core.content_item",
      }).map((row) => row.targetId)
    ).toStrictEqual(["doc-1"]);
    expect(
      supersededTargets(db.vault, {
        capability: "ocr",
        variant: "caption",
        currentModel: "tess@2",
      })
    ).toHaveLength(3);
    db.close();
  });

  test("a payload that is not JSON-valid can never be stored", () => {
    const db = openVaultDb();
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO enrich_derivation
             (derivation_id, target_type, target_id, variant, capability, model,
              payload_json, produced_at)
           VALUES ('d1', 'media.media_asset', 'a', 'caption', 'ocr', 'tess@1', '{oops', ?)`
        )
        .run(T0)
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });
});
