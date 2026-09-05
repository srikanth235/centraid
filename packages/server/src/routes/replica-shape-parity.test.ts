/*
 * #928 wave 2, acceptance box 2. Composing a replica shape from an app's own
 * manifest instead of from its grant rows must be a REFACTOR, not a reshape: a
 * shape id that moves rebootstraps every device that holds it. The eight ids
 * below were taken from the grant-derived builder on `origin/main` before it
 * was replaced, so this file fails if the static composition drifts from what
 * the evaluator answered.
 *
 * The ids are pinned rather than recomputed because a parity test that derives
 * both sides from the same code proves nothing. Re-pin ONLY when a shape is
 * deliberately reshaped, and say so in the receipt.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { seedYear3Vault } from "@centraid/test-kit/year3-vault";
import { sealAad, sealValue, SEALED_COLUMNS } from "@centraid/vault";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { buildReplicaShapes, replicaShapesWire } from "./replica-shape.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Grant-derived shape ids, captured on `origin/main` before wave 2.
 *
 * `docs` and `people` were RE-PINNED by #929: they scoped `share.circle_grant`,
 * `share.commons_member_state` and `share.commons_invitation`, which the
 * commons rail's deletion took with it. `docs` was re-pinned a SECOND time in
 * the same umbrella when its shared surfaces moved onto the subscription plane
 * — it now scopes `share.authority`, `share.fulfillment`, `share.subscription`
 * and `share.subscription_lineage` in place of the commons pair and
 * `core.share_origin`. Both are deliberate reshapes: those devices rebootstrap
 * once. The other six ids are unchanged, which is what this file is here to
 * show.
 */
const SHIPPED_SHAPE_IDS: Readonly<Record<string, string>> = {
  agenda: "agenda:818f3f9a7dd361669630fd53",
  docs: "docs:a81016f19ab7350d276a6e8e",
  locker: "locker:945ff2d895547b2e737301c9",
  notes: "notes:7de2cbbeeda5506d0fdcd35f",
  people: "people:cde59ac8f6e982ac17c88289",
  photos: "photos:66ebc07a3d159a98246ea3a9",
  tally: "tally:be8a5d156b1776ee3c75bac5",
  tasks: "tasks:1caed2924d41b44c6562807a",
};

const APPS_ROOT = path.resolve(import.meta.dirname, "../../../blueprints/apps");

interface ShippedManifest {
  name: string;
  vault: { scopes: { schema: string; verbs: string }[] };
}

/** Read off disk, exactly like the gateway's install path does. */
async function shippedManifests(): Promise<Map<string, ShippedManifest>> {
  const dirs = (await fs.readdir(APPS_ROOT)).toSorted();
  const read = await Promise.all(
    dirs.map(async (appId) => {
      const file = path.join(APPS_ROOT, appId, "app.json");
      const text = await fs.readFile(file, "utf8").catch(() => undefined);
      return text === undefined
        ? undefined
        : ([appId, JSON.parse(text) as ShippedManifest] as const);
    })
  );
  return new Map(
    read.filter(
      (entry): entry is readonly [string, ShippedManifest] =>
        entry !== undefined && Boolean(entry[1].vault?.scopes)
    )
  );
}

const cleanups: Array<() => Promise<void> | void> = [];

describe("replica shape parity with the shipped manifests", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function installedVault(): Promise<VaultPlane> {
    const dir = await tempDir(`shape-parity-${crypto.randomUUID()}-`);
    const opened = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => opened.stop()
    );
    for (const [appId, manifest] of await shippedManifests()) {
      opened.installApp(appId, manifest.name);
      opened.recordAppInstall(appId, {
        scopes: manifest.vault.scopes as Parameters<
          VaultPlane["recordAppInstall"]
        >[1]["scopes"],
      });
    }
    return opened;
  }

  test("every bundled app's shape id survives static composition", async () => {
    const vault = await installedVault();
    const shapes = buildReplicaShapes(vault.db.vault, {
      canWrite: true,
      rememberDevice: true,
    });
    expect(
      Object.fromEntries(
        shapes
          .map((shape) => [shape.appId, shape.shapeId] as const)
          .toSorted(([left], [right]) => left.localeCompare(right))
      )
    ).toStrictEqual(SHIPPED_SHAPE_IDS);
  }, 120_000);

  test("a vault carrying year-3 rows composes the same eight ids", async () => {
    const vault = await installedVault();
    seedYear3Vault(
      {
        vault: vault.db.vault,
        sealCell: (entity, column, rowId, plaintext) =>
          sealValue(
            vault.db.sealKey,
            sealAad(entity.replace(".", "_"), column, rowId),
            plaintext
          ),
      },
      { parties: 7, photos: 31, conversations: 3, turnsPerConversation: 4 }
    );
    const shapes = buildReplicaShapes(vault.db.vault, {
      canWrite: true,
      rememberDevice: true,
    });
    // No bundled scope carries a temporal filter, so a shape id is a function
    // of the manifest and the schema and not of the rows underneath it.
    expect(
      Object.fromEntries(
        shapes
          .map((shape) => [shape.appId, shape.shapeId] as const)
          .toSorted(([left], [right]) => left.localeCompare(right))
      )
    ).toStrictEqual(SHIPPED_SHAPE_IDS);
  }, 180_000);

  test("no sealed column name appears in any bundled app's shape", async () => {
    const vault = await installedVault();
    const wire = JSON.stringify(
      replicaShapesWire(
        buildReplicaShapes(vault.db.vault, {
          canWrite: true,
          rememberDevice: true,
        })
      )
    );
    const sealedNames = [
      ...new Set(
        Object.values(SEALED_COLUMNS).flatMap((columns) => [...columns])
      ),
    ].toSorted((left, right) => left.localeCompare(right));
    // Not vacuous: the registry has to be naming real secrets for this to bite.
    expect(sealedNames.length).toBeGreaterThan(5);
    expect(
      sealedNames.filter((column) => new RegExp(`"${column}"`, "u").test(wire))
    ).toStrictEqual([]);
  }, 120_000);
});
