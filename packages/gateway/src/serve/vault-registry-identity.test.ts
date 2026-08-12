import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import { VaultDirectory } from "./vault-directory.js";
import { openVaultRegistry } from "./vault-registry.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

describe("vault-registry stable identity", () => {
  afterEach(async () =>
    forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup())
  );

  test("an existing vault with no identity seed fails closed instead of re-minting", async () => {
    const root = await tempDir();
    const first = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    const created = first.create();
    first.stop();
    await fs.rm(path.join(root, "keys", `${created.vaultId}.identity`));

    const reopened = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => reopened.stop());
    expect(reopened.list()).toStrictEqual([]);
    expect(reopened.failedMounts()).toHaveLength(1);
    expect(reopened.failedMounts()[0]!.message).toContain(
      "refusing to mint a replacement"
    );
    expect(
      existsSync(path.join(root, "keys", `${created.vaultId}.identity`))
    ).toBe(false);
  });

  test("a mounted vault whose identity disagrees with the gateway directory fails closed", async () => {
    const root = await tempDir();
    const database = GatewayDatabase.open(await tempDir());
    cleanups.push(() => database.close());
    const identityDirectory = new VaultDirectory(database);
    const first = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
      identityDirectory,
    });
    const created = first.create();
    first.stop();
    database.run(
      "UPDATE vault_directory SET public_key = ? WHERE vault_id = ?",
      "mismatched-pinned-key",
      created.vaultId
    );

    const reopened = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
      identityDirectory,
    });
    cleanups.push(() => reopened.stop());
    expect(reopened.list()).toStrictEqual([]);
    expect(reopened.failedMounts()[0]?.message).toContain(
      "does not match its stable identity directory"
    );
  });
});
