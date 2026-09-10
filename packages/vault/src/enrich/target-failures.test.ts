/*
 * THE THIRD ANSWER (#1014, B2). "Derived" and "skipped" were the only two
 * outcomes a recognition walk had, so a target it could not derive was met
 * again on every later tick and every later photograph waited behind it.
 * These are the properties that replace that.
 */

import { describe, expect, test } from "vitest";

import { fixtureSha } from "@centraid/test-kit/fixture-sha";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { stampDerivation } from "./derivation.js";
import {
  ENRICH_TARGET_MAX_FAILURES,
  declinedEnrichTargets,
  enrichTargetFailureSummary,
  isEnrichTargetDeclined,
  recordEnrichTargetFailure,
} from "./target-failures.js";

function seedAsset(db: VaultDb, assetId: string): void {
  const contentId = `content-${assetId}`;
  db.vault
    .prepare(
      `INSERT OR IGNORE INTO core_content_item
         (content_id, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'file:///x', ?, 1, '2026-01-01T00:00:00.000Z')`
    )
    .run(contentId, fixtureSha(assetId));
  db.vault
    .prepare(
      `INSERT OR IGNORE INTO media_asset (asset_id, content_id, kind, captured_at)
       VALUES (?, ?, 'photo', '2026-01-01T00:00:00.000Z')`
    )
    .run(assetId, contentId);
}

function fail(
  db: VaultDb,
  assetId: string,
  extra: { permanent?: boolean; reason?: string } = {}
): { failures: number; declined: boolean } {
  return recordEnrichTargetFailure(db.vault, {
    capability: "faces",
    targetType: "media.asset",
    targetId: assetId,
    error: "detector exploded",
    ...extra,
  });
}

describe("enrichment target failures", () => {
  test("counts to the cap, then declines the target", () => {
    const db = openVaultDb();
    seedAsset(db, "asset-1");
    const verdicts = Array.from({ length: ENRICH_TARGET_MAX_FAILURES }, () =>
      fail(db, "asset-1")
    );
    expect(verdicts.map((v) => v.declined)).toStrictEqual([
      ...Array.from({ length: ENRICH_TARGET_MAX_FAILURES - 1 }, () => false),
      true,
    ]);
    expect(verdicts.at(-1)?.failures).toBe(ENRICH_TARGET_MAX_FAILURES);
    expect(
      isEnrichTargetDeclined(db.vault, {
        capability: "faces",
        targetId: "asset-1",
      })
    ).toBe(true);
    db.close();
  });

  test("a permanent failure declines on the first count", () => {
    const db = openVaultDb();
    seedAsset(db, "asset-2");
    // Content past the extractor's ceiling will not become derivable by being
    // tried twice more.
    expect(
      fail(db, "asset-2", { permanent: true, reason: "too-large" })
    ).toMatchObject({ failures: 1, declined: true });
    expect(declinedEnrichTargets(db.vault)[0]).toMatchObject({
      targetId: "asset-2",
      reason: "too-large",
    });
    db.close();
  });

  test("stamping a derivation clears the target's failures", () => {
    const db = openVaultDb();
    seedAsset(db, "asset-3");
    fail(db, "asset-3");
    expect(enrichTargetFailureSummary(db.vault)).toStrictEqual([
      { capability: "faces", declined: 0, failing: 1 },
    ]);
    stampDerivation(db.vault, {
      targetType: "media.asset",
      targetId: "asset-3",
      variant: "faces",
      capability: "faces",
      model: "faces@1",
    });
    expect(enrichTargetFailureSummary(db.vault)).toStrictEqual([]);
    db.close();
  });

  test("purging the target takes its failure row with it", () => {
    const db = openVaultDb();
    seedAsset(db, "asset-4");
    fail(db, "asset-4", { permanent: true });
    db.vault.exec("PRAGMA foreign_keys = ON");
    db.vault
      .prepare("DELETE FROM media_asset WHERE asset_id = ?")
      .run("asset-4");
    expect(declinedEnrichTargets(db.vault)).toStrictEqual([]);
    db.close();
  });
});
