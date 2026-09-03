import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  BUILT_IN_PROFILE,
  preferredDerivation,
  stampDerivation,
  stampedModel,
} from "./derivation.js";

const T0 = "2026-07-15T00:00:00.000Z";
const T1 = "2026-07-16T00:00:00.000Z";

function seedAsset(db: VaultDb, assetId: string): void {
  const contentId = `content-${assetId}`;
  db.vault
    .prepare(
      `INSERT OR IGNORE INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/jpeg', 'file:///x', ?, 1, '2026-01-01T00:00:00.000Z')`
    )
    .run(contentId, `sha-${assetId}`.padEnd(64, "0"));
  db.vault
    .prepare(
      `INSERT OR IGNORE INTO media_asset (asset_id, content_id, kind, captured_at)
       VALUES (?, ?, 'photo', '2026-01-01T00:00:00.000Z')`
    )
    .run(assetId, contentId);
}

function stamp(
  db: VaultDb,
  targetId: string,
  model: string,
  extra: {
    variant?: string;
    capability?: string;
    profile?: string;
    payload?: unknown;
    now?: string;
  } = {}
): void {
  seedAsset(db, targetId);
  stampDerivation(db.vault, {
    targetType: "media.asset",
    targetId,
    variant: extra.variant ?? "caption",
    capability: extra.capability ?? "ocr",
    model,
    ...(extra.profile === undefined ? {} : { profile: extra.profile }),
    ...(extra.payload === undefined ? {} : { payload: extra.payload }),
    now: extra.now ?? T0,
  });
}

describe("derivation", () => {
  test("a stamp names the model whose output is on disk right now", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1", { payload: { regions: 3 } });
    expect(
      stampedModel(db.vault, {
        targetType: "media.asset",
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
      targetType: "media.asset",
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
        targetType: "media.asset",
        targetId: "asset-1",
        variant: "transcript",
      })
    ).toBe("asr@1");
    expect(
      stampedModel(db.vault, {
        targetType: "media.asset",
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
        targetType: "media.asset",
        targetId: "never-seen",
        variant: "caption",
      })
    ).toBeNull();
    db.close();
  });

  test("a stamp written with no profile belongs to the built-in engine", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1");
    const row = db.vault
      .prepare("SELECT profile FROM enrich_derivation WHERE target_id = ?")
      .get("asset-1") as { profile: string };
    expect(row.profile).toBe(BUILT_IN_PROFILE);
    db.close();
  });

  test("two profiles derive one variant and both rows survive", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1");
    stamp(db, "asset-1", "qwen-vl@3", { profile: "ocr-llm", now: T1 });
    const rows = db.vault
      .prepare(
        `SELECT profile, model FROM enrich_derivation
          WHERE target_id = ? ORDER BY profile`
      )
      .all("asset-1") as unknown as { profile: string; model: string }[];
    expect(
      rows.map((row) => ({ profile: row.profile, model: row.model }))
    ).toStrictEqual([
      { profile: BUILT_IN_PROFILE, model: "tess@1" },
      { profile: "ocr-llm", model: "qwen-vl@3" },
    ]);
    db.close();
  });

  test("re-running ONE profile replaces only that profile's stamp", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1");
    stamp(db, "asset-1", "qwen-vl@3", { profile: "ocr-llm" });
    stamp(db, "asset-1", "qwen-vl@4", { profile: "ocr-llm", now: T1 });
    const rows = db.vault
      .prepare(
        `SELECT profile, model, produced_at FROM enrich_derivation
          WHERE target_id = ? ORDER BY profile`
      )
      .all("asset-1") as unknown as {
      profile: string;
      model: string;
      produced_at: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: "tess@1", produced_at: T0 });
    expect(rows[1]).toMatchObject({ model: "qwen-vl@4", produced_at: T1 });
    db.close();
  });

  test("resolution prefers the named profile, then built-in, then any", () => {
    const db = openVaultDb();
    const query = {
      targetType: "media.asset",
      targetId: "asset-1",
      variant: "caption",
    };
    stamp(db, "asset-1", "qwen-vl@3", { profile: "ocr-llm" });
    expect(preferredDerivation(db.vault, query)?.model).toBe("qwen-vl@3");
    stamp(db, "asset-1", "tess@1");
    expect(preferredDerivation(db.vault, query)?.profile).toBe(
      BUILT_IN_PROFILE
    );
    expect(
      preferredDerivation(db.vault, { ...query, preferredProfile: "ocr-llm" })
        ?.model
    ).toBe("qwen-vl@3");
    expect(
      preferredDerivation(db.vault, { ...query, preferredProfile: "absent" })
        ?.model
    ).toBe("tess@1");
    db.close();
  });

  test("resolution over several foreign profiles is stable", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "b@1", { profile: "profile-b" });
    stamp(db, "asset-1", "a@1", { profile: "profile-a" });
    const query = {
      targetType: "media.asset",
      targetId: "asset-1",
      variant: "caption",
    };
    expect(preferredDerivation(db.vault, query)?.profile).toBe("profile-a");
    expect(preferredDerivation(db.vault, query)?.profile).toBe("profile-a");
    db.close();
  });

  test("a resolved stamp carries its parsed payload and producer", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1", { payload: { regions: 3 } });
    expect(
      preferredDerivation(db.vault, {
        targetType: "media.asset",
        targetId: "asset-1",
        variant: "caption",
      })
    ).toStrictEqual({
      targetType: "media.asset",
      targetId: "asset-1",
      variant: "caption",
      capability: "ocr",
      profile: BUILT_IN_PROFILE,
      model: "tess@1",
      payload: { regions: 3 },
      producedAt: T0,
    });
    db.close();
  });

  test("stampedModel follows the same preference as the resolver", () => {
    const db = openVaultDb();
    stamp(db, "asset-1", "tess@1");
    stamp(db, "asset-1", "qwen-vl@3", { profile: "ocr-llm" });
    const query = {
      targetType: "media.asset",
      targetId: "asset-1",
      variant: "caption",
    };
    expect(stampedModel(db.vault, query)).toBe("tess@1");
    expect(
      stampedModel(db.vault, { ...query, preferredProfile: "ocr-llm" })
    ).toBe("qwen-vl@3");
    db.close();
  });

  test("nothing resolves for a target no profile has derived", () => {
    const db = openVaultDb();
    expect(
      preferredDerivation(db.vault, {
        targetType: "media.asset",
        targetId: "never-seen",
        variant: "caption",
      })
    ).toBeNull();
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
           VALUES ('d1', 'media.asset', 'a', 'caption', 'ocr', 'tess@1', '{oops', ?)`
        )
        .run(T0)
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });
});
