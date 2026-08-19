/*
 * Grants ride the ORDINARY replica plane (#825). There is no bespoke client
 * read for who a vault shares with: `share.grant` and `share.fulfillment` are
 * consent-shaped entities like any other, so an app the owner approved gets
 * them in its shape, with the same field masks, the same change log, and the
 * same denial behaviour — and an app the owner did not approve gets nothing,
 * which is what lets a surface say "we cannot see" rather than "shared with
 * nobody".
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
        { schema: "share", table: "grant", verbs: "read" },
        { schema: "share", table: "fulfillment", verbs: "read" },
      ],
    });
    const [shape] = buildReplicaShapes(vault.db.vault, {
      canWrite: false,
      rememberDevice: true,
      appId: "people",
    });
    const grant = shape?.entityMap.get("share.grant");
    expect(grant?.columns).toStrictEqual(
      expect.arrayContaining<string>([
        "grant_id",
        "audience_kind",
        "audience_id",
        "subject_type",
        "subject_id",
        "capability",
        "revoked_at",
      ])
    );
    expect(shape?.entityMap.get("share.fulfillment")?.columns).toStrictEqual(
      expect.arrayContaining<string>(["grant_id", "peer_vault_id", "state"])
    );
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
    // Absent from the shape, not present-and-empty: the client cannot tell
    // itself a story about who this vault shares with.
    expect(shape?.entityMap.has("share.grant")).toBe(false);
  });
});
