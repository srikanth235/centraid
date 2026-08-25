/*
 * Restore drill (#842 W1.3): same `runRestoreVerify` the scheduler calls
 * (#408 G9) over real vault + provider + `core.attach`.
 *
 * WHAT CI COVERS THAT THE PRODUCT CANNOT. Product only meets a healthy store.
 * Only CI can sabotage and demand the alarm. Comment out `doRunRestoreVerify`
 * and both red lanes go green while the vault is broken.
 *
 * Determinism: no clock, no `Math.random`. CAS sample is `<vaultId>:<seq>`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

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

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const cleanups: Array<() => Promise<void> | void> = [];

interface Machine {
  service: BackupService;
  plane: VaultPlane;
  vaultId: string;
  health: HealthRegistry;
}

describe("restore-drill", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  function invoke(
    plane: VaultPlane,
    command: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
    if (out.status !== "executed")
      throw new Error(`${command} failed: ${JSON.stringify(out)}`);
    return (out as { output: Record<string, unknown> }).output;
  }

  async function makeMachine(
    server: Awaited<ReturnType<typeof startFakeProviderServer>>,
    label: string
  ): Promise<Machine> {
    const vaultRoot = await tempDir(`${label}-vault`);
    const backupDir = await tempDir(`${label}-backup`);
    const registry = openVaultRegistry({
      rootDir: vaultRoot,
      logger: silentLogger,
      ownerName: "Mara",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const vaultId = registry.defaultVaultId();
    const plane = registry.get(vaultId)!;
    const health = new HealthRegistry();
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
      health,
      logger: silentLogger,
    });
    cleanups.push(() => service.stop());
    return { service, plane, vaultId, health };
  }

  function attachPhoto(plane: VaultPlane): string {
    const taskId = invoke(plane, "schedule.add_task", {
      title: "Frame the print",
    })["task_id"] as string;
    const out = invoke(plane, "core.attach", {
      subject_type: "schedule.task",
      subject_id: taskId,
      data_uri: PNG,
    });
    const row = plane.db.vault
      .prepare("SELECT content_uri FROM core_content_item WHERE content_id = ?")
      .get(out["content_id"] as string) as { content_uri: string };
    return row.content_uri.slice("blob:sha256-".length);
  }

  function casPathFor(plane: VaultPlane, sha: string): string {
    return path.join(plane.dir, "blobs", "sha256", sha.slice(0, 2), sha);
  }

  /**
   * Wipe parties, leave FK-clean — else `verifyRestoredPair` catches it first.
   * Cascade from `foreign_key_check`, not a hardcoded table list.
   */
  function emptyOutParties(plane: VaultPlane): void {
    const db = plane.db.vault;
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DELETE FROM core_party");
    for (let pass = 0; ; pass += 1) {
      const orphans = db.prepare("PRAGMA foreign_key_check").all() as {
        table: string;
        rowid: number | null;
      }[];
      if (orphans.length === 0) break;
      if (pass >= 16)
        throw new Error("sabotage never reached an fk-clean pair");
      for (const orphan of orphans) {
        if (orphan.rowid === null) continue;
        db.exec(`DELETE FROM "${orphan.table}" WHERE rowid = ${orphan.rowid}`);
      }
    }
    db.exec("PRAGMA foreign_keys = ON");
  }

  async function backupsHealth(m: Machine): Promise<string | undefined> {
    const snapshot = await m.health.snapshot();
    return snapshot.components.find((c) => c.component === "backups")?.status;
  }

  async function providerServer(): Promise<
    Awaited<ReturnType<typeof startFakeProviderServer>>
  > {
    const server = await startFakeProviderServer();
    cleanups.push(() => server.close());
    return server;
  }

  test("a real backup restores to a vault the drill judges USABLE", async () => {
    const m = await makeMachine(await providerServer(), "drill-green");
    const sha = attachPhoto(m.plane);
    expect((await fs.stat(casPathFor(m.plane, sha))).size).toBeGreaterThan(0);

    await m.service.runBackup(m.vaultId);
    await expect(
      m.service.runRestoreVerify(m.vaultId)
    ).resolves.toBeUndefined();

    const target = (await m.service.status())[m.vaultId];
    expect(target?.lastRestoreVerifyError).toBeUndefined();
    // Real ISO instant — health probe and 14-day staleness parse this.
    expect(
      Number.isFinite(Date.parse(target?.lastRestoreVerifiedAt ?? ""))
    ).toBe(true);
    await expect(backupsHealth(m)).resolves.toBe("ok");
  }, 60_000);

  test("a claimed blob whose bytes were never captured FAILS the drill", async () => {
    // Structural half is blind: the row survives; bytes are gone.
    const m = await makeMachine(await providerServer(), "drill-blob");
    const sha = attachPhoto(m.plane);
    await fs.rm(casPathFor(m.plane, sha));

    await m.service.runBackup(m.vaultId);
    await expect(m.service.runRestoreVerify(m.vaultId)).rejects.toThrow(
      /unrecoverable from this restore/u
    );

    // Persisted: a push-only failure would go green at the next tick.
    const target = (await m.service.status())[m.vaultId];
    expect(target?.lastRestoreVerifyError).toMatch(/restore-verify failed/u);
    expect(target?.lastRestoreVerifyError).toMatch(/claimed blob/u);
    await expect(backupsHealth(m)).resolves.toBe("error");
  }, 60_000);

  test("an empty-shell restore FAILS the drill though every structural check passes", async () => {
    // Structurally perfect, empty. Message naming ONLY the empty shell proves
    // the drill (not integrity/fk/G8/seal) caught this.
    const m = await makeMachine(await providerServer(), "drill-shell");
    emptyOutParties(m.plane);

    await m.service.runBackup(m.vaultId);
    let message = "";
    await m.service.runRestoreVerify(m.vaultId).catch((error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
    });
    expect(message).toMatch(/EMPTY SHELL/u);
    expect(message).not.toMatch(/integrity|fk violation|placebo|wal/u);
  }, 60_000);
});
