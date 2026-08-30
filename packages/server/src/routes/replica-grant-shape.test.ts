/*
 * Grants ride the ORDINARY replica plane (#825): `share.authority` and
 * `share.fulfillment` are consent-shaped entities like any other. An
 * unapproved app gets nothing, which is what lets a surface say "we cannot
 * see" rather than "shared with nobody".
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { buildReplicaShapes } from "./replica-shape.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

describe("grant plane on the replica", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function plane(): Promise<VaultPlane> {
    const dir = await tempDir(`replica-grant-${crypto.randomUUID()}-`);
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
    return opened;
  }

  test("an approved app's shape carries the grant and its delivery state", async () => {
    const vault = await plane();
    vault.approveGrant("people", {
      purpose: "dpv:ServiceProvision",
      scopes: [
        { schema: "share", table: "authority", verbs: "read" },
        { schema: "share", table: "fulfillment", verbs: "read" },
      ],
    });
    const [shape] = buildReplicaShapes(vault.db.vault, {
      canWrite: false,
      rememberDevice: true,
      appId: "people",
    });
    // The plane's own column names: one table, one vocabulary (#883).
    const grant = shape?.entityMap.get("share.authority");
    expect(grant?.columns).toStrictEqual(
      expect.arrayContaining<string>([
        "authority_id",
        "principal_kind",
        "principal_id",
        "subject_type",
        "subject_id",
        "verb",
        "decision",
        "revoked_at",
      ])
    );
    expect(shape?.entityMap.get("share.fulfillment")?.columns).toStrictEqual(
      expect.arrayContaining<string>(["grant_id", "peer_vault_id", "state"])
    );
  });

  /*
   * THE SHIPPED MANIFEST UNBLOCKS IT (#883): the test above approves a
   * hand-written scope, proving the machinery, not the product. Read off disk
   * because a scope typed here would pass while the shipped one drifted.
   */
  test("People's SHIPPED manifest is what carries the authority plane to a seat", async () => {
    const manifest = JSON.parse(
      await fs.readFile(
        new URL("../../../blueprints/apps/people/app.json", import.meta.url),
        "utf8"
      )
    ) as {
      vault: { purpose: string; scopes: { verbs: string }[] };
    };
    const vault = await plane();
    vault.approveGrant("people", {
      purpose: manifest.vault.purpose,
      scopes: manifest.vault.scopes.filter((scope) =>
        scope.verbs.includes("read")
      ) as Parameters<typeof vault.approveGrant>[1]["scopes"],
    });
    const [shape] = buildReplicaShapes(vault.db.vault, {
      canWrite: false,
      rememberDevice: true,
      appId: "people",
    });
    const authority = shape?.entityMap.get("share.authority");
    expect(authority?.columns).toStrictEqual(
      expect.arrayContaining<string>([
        "authority_id",
        "principal_kind",
        "principal_id",
        "verb",
        "decision",
        "granted_at",
        "revoked_at",
      ])
    );
    // Every principal kind rides the SAME shape: one lens over one table
    // (V-dashboard), not four reads.
    expect(authority?.primaryKey).toBe("authority_id");
  });

  test("an app the owner never approved for shares sees no grant entity at all", async () => {
    const vault = await plane();
    vault.approveGrant("people", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "core", table: "party", verbs: "read" }],
    });
    const [shape] = buildReplicaShapes(vault.db.vault, {
      canWrite: false,
      rememberDevice: true,
      appId: "people",
    });
    // Absent from the shape, not present-and-empty: no client can tell itself
    // a story about who this vault shares with.
    expect(shape?.entityMap.has("share.authority")).toBe(false);
  });
});
