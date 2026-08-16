/*
 * The admin CLIs against a PROTECTOR-FUL data directory (issue #568 item D).
 *
 * `daemonKeyStore` always installs a protector, so every `keys/<id>.sealkey`
 * a running daemon writes is an `aes-256-gcm-v1` envelope. Four
 * `openVaultRegistry` calls in `vault-admin` / `device-admin` / `status-admin`
 * passed no `keyStore`, so their protector-less store threw
 * `unsupported_scheme`, `vault-registry.ts` swallowed it into
 * `failedMountsByDir`, and `list()` returned `[]`.
 *
 * The symptoms were silent, which is why a green CI shipped them: `vault list`
 * printed nothing, `status` reported zero vaults, `devices add --vault` failed
 * with "no vault matches" — and `devices revoke` opened `cleanupRegistry` for
 * the vault-local data-erasure step, found no vault, and SKIPPED IT.
 *
 * These drive the CLI verbs against a data dir whose sealing keys are
 * protected exactly as a daemon leaves them, and assert the revoke erasure
 * positively rather than by absence of an error.
 */

import { promises as fs, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, afterEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  KEY_STORE_ENVELOPE_MAGIC,
  listReplicaIntentOutcomes,
  recordReplicaIntentOutcome,
} from "@centraid/vault";

import { openVaultRegistry } from "../serve/vault-registry.ts";
import { commandDevices } from "./device-admin.ts";
import { daemonKeyStore } from "./key-store.ts";
import { daemonLayoutFor } from "./paths.ts";
import { commandVault } from "./vault-admin.ts";

const roots: string[] = [];
describe("admin-custody suite", () => {
  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  const quiet = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const fail = (message: string): never => {
    throw new Error(message);
  };

  async function capture(run: () => Promise<void>): Promise<string> {
    const original = process.stdout.write;
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await run();
    } finally {
      process.stdout.write = original;
    }
    return chunks.join("");
  }

  /** A data dir whose vault was created the way the DAEMON creates one. */
  async function daemonDataDir(name: string): Promise<{
    dataDir: string;
    vaultId: string;
    layout: ReturnType<typeof daemonLayoutFor>;
  }> {
    const dataDir = await tempDir("admin-custody-");
    roots.push(dataDir);
    const layout = daemonLayoutFor(dataDir);
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      keyStore: daemonKeyStore(layout.keysDir),
      logger: quiet,
      enableWalShipper: false,
    });
    const created = registry.create(name);
    registry.stop();
    // A daemon mints the per-vault sealing key through its own custody store,
    // so the on-disk envelope is `aes-256-gcm-v1`. Writing it here reproduces
    // exactly that artifact without needing a sealed write.
    daemonKeyStore(layout.keysDir).create(`${created.vaultId}.sealkey`);
    return { dataDir, vaultId: created.vaultId, layout };
  }

  test("a daemon-created vault really does carry a protected sealing key", async () => {
    const { layout, vaultId } = await daemonDataDir("Family");
    const raw = readFileSync(
      path.join(layout.keysDir, `${vaultId}.sealkey`),
      "utf8"
    );
    expect(raw.startsWith(KEY_STORE_ENVELOPE_MAGIC)).toBe(true);
    expect(
      JSON.parse(raw.slice(KEY_STORE_ENVELOPE_MAGIC.length))
    ).toMatchObject({
      scheme: "aes-256-gcm-v1",
    });
    // The precondition these tests exist for: a protector-less reader sees
    // NOTHING, silently.
    const blind = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      logger: quiet,
      enableWalShipper: false,
    });
    expect(blind.list()).toStrictEqual([]);
    blind.stop();
  });

  test("vault list sees a daemon-created vault", async () => {
    const { dataDir, vaultId } = await daemonDataDir("Family");
    const output = await capture(() =>
      commandVault(["list", "--data-dir", dataDir, "--json"], fail)
    );
    expect(JSON.parse(output.trim())).toMatchObject({
      ok: true,
      vaults: [expect.objectContaining({ vaultId, name: "Family" })],
    });
  });

  test("devices add --vault resolves a daemon-created vault by name", async () => {
    const { dataDir, vaultId } = await daemonDataDir("Family");
    const output = await capture(() =>
      commandDevices(
        ["add", "--data-dir", dataDir, "ep-laptop", "--vault", "Family"],
        fail
      )
    );
    expect(JSON.parse(output.trim())).toMatchObject({
      endpointId: "ep-laptop",
      vaultId,
    });
  });

  test("devices revoke performs the vault-local data erasure, not a silent skip", async () => {
    const { dataDir, vaultId, layout } = await daemonDataDir("Family");
    await capture(() =>
      commandDevices(
        ["add", "--data-dir", dataDir, "ep-owner", "--vault", "Family"],
        fail
      )
    );
    await capture(() =>
      commandDevices(
        ["add", "--data-dir", dataDir, "ep-phone", "--vault", "Family"],
        fail
      )
    );

    // Give the phone something vault-local to lose. `forgetReplicaDevice` — the
    // durable offline-intent outcomes a revoked device must not keep — is
    // exactly what `devices revoke` reaches, and exactly what it silently
    // skipped when the registry mounted nothing.
    const seed = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      keyStore: daemonKeyStore(layout.keysDir),
      logger: quiet,
      enableWalShipper: false,
    });
    const seedPlane = seed.get(vaultId)!;
    expect(
      seedPlane,
      "the CLI-visible registry must mount the vault"
    ).toBeTruthy();
    recordReplicaIntentOutcome(seedPlane.db.vault, {
      intentId: "intent-1",
      deviceId: "ep-phone",
      appId: "notes",
      action: "create",
      payloadHash: "hash-1",
      status: "parked",
    });
    expect(
      listReplicaIntentOutcomes(seedPlane.db.vault, "ep-phone")
    ).toHaveLength(1);
    seed.stop();

    const output = await capture(() =>
      commandDevices(["revoke", "--data-dir", dataDir, "ep-phone"], fail)
    );
    expect(JSON.parse(output.trim())).toMatchObject({
      revoked: { endpointId: "ep-phone" },
    });

    const after = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      keyStore: daemonKeyStore(layout.keysDir),
      logger: quiet,
      enableWalShipper: false,
    });
    try {
      // Positively asserted, not inferred from the absence of an error.
      expect(
        listReplicaIntentOutcomes(after.get(vaultId)!.db.vault, "ep-phone")
      ).toStrictEqual([]);
    } finally {
      after.stop();
    }
  });

  test("the CLI leaves no unprotected key material behind", async () => {
    const { dataDir, layout } = await daemonDataDir("Family");
    await capture(() =>
      commandDevices(
        ["add", "--data-dir", dataDir, "ep-laptop", "--vault", "Family"],
        fail
      )
    );
    for (const entry of readdirSync(layout.keysDir)) {
      if (entry.includes(".tmp")) continue;
      const raw = readFileSync(path.join(layout.keysDir, entry), "utf8");
      expect(
        JSON.parse(raw.slice(KEY_STORE_ENVELOPE_MAGIC.length)),
        `${entry} was rewritten without the daemon's protector`
      ).toMatchObject({ scheme: "aes-256-gcm-v1" });
    }
  });
});
