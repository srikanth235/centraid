import { afterEach, describe, expect, test } from "vitest";

import { startFakeProviderServer } from "@centraid/backup/dist/testing/fake-provider-server.js";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { HealthRegistry } from "../serve/health-registry.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import { BackupService } from "./backup-service.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("restore-verify-sealkey", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  function invoke(
    plane: VaultPlane,
    command: string,
    input: Record<string, unknown>
  ): void {
    const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
    if (out.status !== "executed")
      throw new Error(`${command} failed: ${JSON.stringify(out)}`);
  }

  interface Machine {
    service: BackupService;
    plane: VaultPlane;
    vaultId: string;
  }

  async function makeSealedMachine(
    server: Awaited<ReturnType<typeof startFakeProviderServer>>
  ): Promise<Machine> {
    const vaultRoot = await tempDir("rv-sealkey-vault");
    const backupDir = await tempDir("rv-sealkey-backup");
    const registry = openVaultRegistry({
      rootDir: vaultRoot,
      logger: silentLogger,
      ownerName: "Mara",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const vaultId = registry.defaultVaultId();
    const plane = registry.get(vaultId)!;
    const service = new BackupService({
      config: {
        enabled: true,
        provider: {
          kind: "remote",
          endpoint: server.url,
          apiKey: server.apiKey,
        },
      },
      cacheDir: backupDir,
      vaults: registry,
      health: new HealthRegistry(),
      logger: silentLogger,
    });
    cleanups.push(() => service.stop());
    invoke(plane, "sync.configure_credential", {
      kind: "pull.gmail",
      label: "personal",
      cred_kind: "api_key",
      api_key: "sk-restore-verify",
      allowed_hosts: ["gmail.googleapis.com"],
    });
    return { service, plane, vaultId };
  }

  test("restore-verify passes when the restored seal key unseals the vault", async () => {
    const server = await startFakeProviderServer();
    cleanups.push(() => server.close());
    const m = await makeSealedMachine(server);
    await m.service.runBackup(m.vaultId);
    await expect(
      m.service.runRestoreVerify(m.vaultId)
    ).resolves.toBeUndefined();
  });

  test("restore-verify FAILS with the placebo problem when the seal key does not match", async () => {
    const server = await startFakeProviderServer();
    cleanups.push(() => server.close());
    const m = await makeSealedMachine(server);

    const row = m.plane.db.vault
      .prepare("SELECT settings_json FROM core_vault LIMIT 1")
      .get() as {
      settings_json: string;
    };
    const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
    settings["seal_key"] = {
      fingerprint: `sha256:${"f".repeat(32)}`,
      stamped_at: new Date().toISOString(),
    };
    m.plane.db.vault
      .prepare("UPDATE core_vault SET settings_json = ?")
      .run(JSON.stringify(settings));

    await m.service.runBackup(m.vaultId);
    await expect(m.service.runRestoreVerify(m.vaultId)).rejects.toThrow(
      /placebo/u
    );
  }, 45_000);
});
