import crypto from "node:crypto";
/*
 * One revocation policy across both lanes (#1014, X14): a stopped-daemon
 * `devices revoke` must take the device's blob keys, the same as the HTTP
 * lane in `build-gateway.ts`.
 */
import { promises as fs } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { openVaultRegistry } from "../serve/vault-registry.ts";
import { capture, fail } from "./admin-test-kit.ts";
import { commandDevices } from "./device-admin.ts";
import { daemonKeyStore } from "./key-store.ts";
import { daemonLayoutFor } from "./paths.ts";
import { commandVault } from "./vault-admin.ts";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
// Same shape as `admin.test.ts`: every test bootstraps a real vault layout on
// disk, so this file is fsync-bound and needs the same escalation.
vi.setConfig({ testTimeout: 60_000 });

let dataDir: string;

describe("stopped-daemon revocation", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`revoke-keys-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("a stopped-daemon revoke takes the device's blob keys too", async () => {
    const layout = daemonLayoutFor(dataDir);
    await capture(() =>
      commandVault(["create", "--data-dir", dataDir, "--name", "Family"], fail)
    );
    await capture(() =>
      commandDevices(
        ["add", "--data-dir", dataDir, "ep-laptop", "--vault", "Family"],
        fail
      )
    );

    // Pair the device on the byte plane the way an enrolled device does, so
    // there is key material for the revoke to take.
    const seeded = openVaultRegistry({
      rootDir: layout.vaultDir,
      keyStore: daemonKeyStore(layout.keysDir),
      logger: silentLogger,
      enableWalShipper: false,
    });
    const vaultId = seeded.defaultVaultId();
    const seededPlane = seeded.get(vaultId)!;
    seededPlane.db.blobTransfers.enrollPairedDevice({
      identity: "ep-laptop",
      ownerPartyId: seededPlane.boot.ownerPartyId,
      name: "Priya laptop",
    });
    const pairedRows = (): number =>
      (
        seededPlane.db.vault
          .prepare(
            "SELECT COUNT(*) AS n FROM access_device_secret WHERE public_key = ?"
          )
          .get("ep-laptop") as { n: number }
      ).n;
    expect(pairedRows()).toBe(1);
    seeded.stop();

    await capture(() =>
      commandDevices(
        [
          "revoke",
          "--data-dir",
          dataDir,
          "ep-laptop",
          "--confirm-last-device",
          "Family",
        ],
        fail
      )
    );

    // X14: the HTTP lane already took these; the CLI lane used to leave the
    // revoked device holding every object key it had been granted.
    const after = openVaultRegistry({
      rootDir: layout.vaultDir,
      keyStore: daemonKeyStore(layout.keysDir),
      logger: silentLogger,
      enableWalShipper: false,
    });
    const afterPlane = after.get(vaultId)!;
    expect(
      (
        afterPlane.db.vault
          .prepare(
            "SELECT COUNT(*) AS n FROM access_device_secret WHERE public_key = ?"
          )
          .get("ep-laptop") as { n: number }
      ).n
    ).toBe(0);
    after.stop();
  });
});
