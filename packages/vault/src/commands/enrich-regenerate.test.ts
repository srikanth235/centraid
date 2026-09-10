// The two regeneration verbs (#1011): "do this one again" and "do the whole
// library again". A stamp is what makes a handler skip a target, so both are
// tested by what they leave behind for the handler's own skip logic to read.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { stampDerivation } from "../enrich/derivation.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerEnrichCommands } from "./enrich.js";
import { registerMediaCommands } from "./media.js";

/** Distinct 1x1 PNGs — the CAS dedupes identical bytes into ONE asset, so a
 *  test that needs two photographs needs two different pixels. */
const PIXELS = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
].map((base64) => Buffer.from(base64, "base64"));

describe("enrich regeneration verbs (#1011)", () => {
  let db: VaultDb;
  let gw: Gateway;
  let boot: BootstrapResult;
  let owner: Credential;

  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerEnrichCommands(gw);
    registerMediaCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    nextPixel = 0;
  });

  function invoke(command: string, input: Record<string, unknown>): unknown {
    return gw.invoke(owner, { command, input });
  }

  function output<T>(outcome: unknown): T {
    return (outcome as { output: T }).output;
  }

  let nextPixel = 0;
  function addPhoto(): { assetId: string; contentId: string } {
    const bytes = PIXELS[nextPixel++ % PIXELS.length]!;
    const staged = gw.stageBlob(owner, {
      bytes,
      filename: `pixel-${nextPixel}.png`,
    });
    const out = output<{ asset_id: string; content_id: string }>(
      invoke("media.add_asset", { staged_sha: staged.sha256 })
    );
    return { assetId: out.asset_id, contentId: out.content_id };
  }

  /** The two shapes the three system handlers actually write. */
  function stampFaces(assetId: string, model = "yunet-arcface@1"): void {
    stampDerivation(db.vault, {
      targetType: "media.asset",
      targetId: assetId,
      variant: "faces",
      capability: "faces",
      model,
    });
  }
  function stampOcr(contentId: string, model = "pp-ocrv5@1"): void {
    stampDerivation(db.vault, {
      targetType: "core.content_item",
      targetId: contentId,
      variant: "text",
      capability: "ocr",
      model,
    });
  }

  function stamps(capability: string): { target_id: string }[] {
    return db.vault
      .prepare(
        "SELECT target_id FROM enrich_derivation WHERE capability = ? ORDER BY target_id"
      )
      .all(capability) as unknown as { target_id: string }[];
  }

  function openRequests(): {
    target_type: string;
    target_id: string;
    capability: string;
    reason: string;
  }[] {
    return db.vault
      .prepare(
        "SELECT target_type, target_id, capability, reason FROM enrich_request WHERE drained_at IS NULL"
      )
      .all() as unknown as {
      target_type: string;
      target_id: string;
      capability: string;
      reason: string;
    }[];
  }

  function stateValue(automationRef: string, key: string): string | undefined {
    const row = db.vault
      .prepare(
        "SELECT value_json FROM automation_state WHERE automation_id = ? AND key = ?"
      )
      .get(automationRef, key) as { value_json: string } | undefined;
    return row?.value_json;
  }

  describe("enrich.regenerate", () => {
    test("drops the stamp for that asset and capability, and requeues it", () => {
      const one = addPhoto();
      const two = addPhoto();
      stampFaces(one.assetId);
      stampFaces(two.assetId);

      const result = output<{ deleted: number; request_id: string }>(
        invoke("enrich.regenerate", {
          asset_id: one.assetId,
          capability: "faces",
        })
      );
      expect(result.deleted).toBe(1);
      // The OTHER photograph is untouched: this is one target, not a sweep.
      expect(stamps("faces").map((row) => row.target_id)).toStrictEqual([
        two.assetId,
      ]);

      // Spread each row: node:sqlite hands back null-prototype objects.
      const requests = openRequests().map((row) => ({ ...row }));
      expect(requests).toStrictEqual([
        {
          target_type: "media.asset",
          target_id: one.assetId,
          capability: "faces",
          reason: "manual",
        },
      ]);
    });

    test("either id names the same photograph — OCR stamps its content item", () => {
      const photo = addPhoto();
      stampOcr(photo.contentId);

      // The member is looking at a photo and asks for OCR again. The stamp is
      // on the CONTENT ITEM, not the asset, and naming the asset must still
      // find it.
      const result = output<{ deleted: number }>(
        invoke("enrich.regenerate", {
          asset_id: photo.assetId,
          capability: "ocr",
        })
      );
      expect(result.deleted).toBe(1);
      expect(stamps("ocr")).toStrictEqual([]);

      // …and naming the content item works from the other direction.
      stampOcr(photo.contentId);
      expect(
        output<{ deleted: number }>(
          invoke("enrich.regenerate", {
            content_id: photo.contentId,
            capability: "ocr",
          })
        ).deleted
      ).toBe(1);
      expect(stamps("ocr")).toStrictEqual([]);
    });

    test("another capability's stamp for the same target survives", () => {
      const photo = addPhoto();
      stampFaces(photo.assetId);
      stampOcr(photo.contentId);

      invoke("enrich.regenerate", {
        asset_id: photo.assetId,
        capability: "faces",
      });
      expect(stamps("faces")).toStrictEqual([]);
      expect(stamps("ocr").map((row) => row.target_id)).toStrictEqual([
        photo.contentId,
      ]);
    });

    test("a target with no stamp is still requeued — regenerating is not a read", () => {
      const photo = addPhoto();
      const result = output<{ deleted: number }>(
        invoke("enrich.regenerate", {
          asset_id: photo.assetId,
          capability: "faces",
        })
      );
      expect(result.deleted).toBe(0);
      expect(openRequests()).toHaveLength(1);
    });

    test("naming both ids, or neither, is refused", () => {
      const photo = addPhoto();
      for (const input of [
        { capability: "faces" },
        {
          capability: "faces",
          asset_id: photo.assetId,
          content_id: photo.contentId,
        },
      ]) {
        const outcome = invoke("enrich.regenerate", input) as {
          status?: string;
        };
        expect(outcome.status).not.toBe("committed");
      }
      expect(openRequests()).toHaveLength(0);
    });

    test("an unknown asset is refused rather than silently queued", () => {
      const outcome = invoke("enrich.regenerate", {
        asset_id: "not-an-asset",
        capability: "faces",
      }) as { status?: string };
      expect(outcome.status).not.toBe("committed");
      expect(openRequests()).toHaveLength(0);
    });
  });

  describe("enrich.regenerate_all", () => {
    test("drops every stamp for the capability and rewinds the recipe's cursor", () => {
      const one = addPhoto();
      const two = addPhoto();
      stampFaces(one.assetId);
      stampFaces(two.assetId);
      stampOcr(one.contentId);
      // The recipe is mid-library.
      db.vault
        .prepare(
          "INSERT INTO automation_state (automation_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)"
        )
        .run("faces/faces", "cursor", JSON.stringify(two.assetId), 1);

      const result = output<{
        deleted: number;
        automation_ref: string;
        cursors_reset: number;
      }>(invoke("enrich.regenerate_all", { capability: "faces" }));

      expect(result.deleted).toBe(2);
      expect(result.automation_ref).toBe("faces/faces");
      expect(result.cursors_reset).toBe(2);
      expect(stamps("faces")).toStrictEqual([]);
      // A different capability's library is not part of this ask.
      expect(stamps("ocr").map((row) => row.target_id)).toStrictEqual([
        one.contentId,
      ]);

      // "" is what the handler reads as the beginning of the library.
      expect(stateValue("faces/faces", "cursor")).toBe('""');
      expect(stateValue("faces/faces", "consentCursor")).toBe('""');
    });

    test("rewinds the OCR recipe's own cursor, not faces'", () => {
      const photo = addPhoto();
      stampOcr(photo.contentId);
      const result = output<{ automation_ref: string; deleted: number }>(
        invoke("enrich.regenerate_all", { capability: "ocr" })
      );
      expect(result.automation_ref).toBe("photo-ocr/photo-ocr");
      expect(result.deleted).toBe(1);
      expect(stateValue("photo-ocr/photo-ocr", "cursor")).toBe('""');
      expect(stateValue("faces/faces", "cursor")).toBeUndefined();
    });

    test("a capability no bundled recipe owns is refused", () => {
      const outcome = invoke("enrich.regenerate_all", {
        capability: "palmistry",
      }) as { status?: string };
      expect(outcome.status).not.toBe("committed");
    });

    test("running it twice is safe", () => {
      const photo = addPhoto();
      stampFaces(photo.assetId);
      invoke("enrich.regenerate_all", { capability: "faces" });
      const second = output<{ deleted: number }>(
        invoke("enrich.regenerate_all", { capability: "faces" })
      );
      expect(second.deleted).toBe(0);
      expect(stateValue("faces/faces", "cursor")).toBe('""');
    });
  });
});
