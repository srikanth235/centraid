/*
 * The automated restore drill, end to end (umbrella #842, slice W1.3).
 *
 * A backup you never restore is not a backup. The gateway already restores one
 * for real on the vault's `verifyEveryDays` clock (`BackupService.tick` →
 * `runRestoreVerify`, issue #408 G9); this lane proves the drill that clock
 * runs is worth running — that it takes a REAL backup through the REAL product
 * path, restores it, and judges the restored vault USABLE rather than merely
 * present.
 *
 * Every test here drives the shipped objects: a real `VaultRegistry` vault, a
 * real `BackupService` against a real provider server, real `core.attach`
 * ingest through the blob pipeline, and the same `runRestoreVerify` the
 * scheduler calls. Nothing is stubbed, so a green here is a green for the
 * owner's own machine.
 *
 * WHAT THIS CI LANE COVERS THAT THE IN-PRODUCT DRILL CANNOT. The in-product
 * drill only ever meets a healthy store: it can prove a backup restores, but
 * it can never prove it would NOTICE a backup that did not. Only CI can
 * sabotage a real vault and a real provider and demand the alarm — which is
 * why the two red lanes below (a claimed blob whose bytes were never captured,
 * and an empty-shell restore) live here and only here. They are also the
 * demonstrated-red for the whole slice: comment out the drill call in
 * `backup-service.ts#doRunRestoreVerify` and both go green while the vault is
 * provably broken.
 *
 * Determinism: no clock reads, no `Math.random`. The drill's CAS sample is
 * seeded from `<vaultId>:<seq>`, so a failure here replays over the identical
 * sample.
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

/** A 1x1 PNG — real bytes through the real attach/blob pipeline. */
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

  /** A real vault wired to a real BackupService over a real provider server. */
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

  /** Attach a PNG to a real task and return the blob sha the model now claims. */
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
   * Wipe the party rows and everything that pointed at them, leaving a vault
   * that is still FK-clean. The shell has to be STRUCTURALLY PERFECT or the
   * test proves nothing: a pair that also carried fk violations would be
   * caught by `verifyRestoredPair` and the drill's contribution would be
   * indistinguishable from the checks that already existed. The cascade is
   * discovered from `foreign_key_check` rather than hard-coded, so a new
   * table referencing `core_party` cannot silently make this sabotage partial.
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

  /** The `backups` component's status in a real health snapshot. */
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
    // The whole drill — structural half plus depth half — on the product path.
    await expect(
      m.service.runRestoreVerify(m.vaultId)
    ).resolves.toBeUndefined();

    const target = (await m.service.status())[m.vaultId];
    expect(target?.lastRestoreVerifyError).toBeUndefined();
    // A real ISO instant, not merely a non-empty string: the health probe and
    // the 14-day staleness window in backup-health.ts both parse this.
    expect(
      Number.isFinite(Date.parse(target?.lastRestoreVerifiedAt ?? ""))
    ).toBe(true);
    // A drilled backup reports its own health, and it is not merely 'not red'.
    await expect(backupsHealth(m)).resolves.toBe("ok");
  }, 60_000);

  test("a claimed blob whose bytes were never captured FAILS the drill", async () => {
    // The failure the structural half is blind to: the vault.db row survives
    // the restore in perfect health and its bytes are simply gone. Before this
    // drill the run went green and the owner learned about the broken photo on
    // the day they needed it.
    const m = await makeMachine(await providerServer(), "drill-blob");
    const sha = attachPhoto(m.plane);
    await fs.rm(casPathFor(m.plane, sha));

    await m.service.runBackup(m.vaultId);
    await expect(m.service.runRestoreVerify(m.vaultId)).rejects.toThrow(
      /unrecoverable from this restore/u
    );

    // Persisted, not merely pushed: the health probe recomputes from backup
    // state, so a failure that lived only in a pushed report would go green at
    // the next tick and the owner would never learn.
    const target = (await m.service.status())[m.vaultId];
    expect(target?.lastRestoreVerifyError).toMatch(/restore-verify failed/u);
    expect(target?.lastRestoreVerifyError).toMatch(/claimed blob/u);
    await expect(backupsHealth(m)).resolves.toBe("error");
  }, 60_000);

  test("an empty-shell restore FAILS the drill though every structural check passes", async () => {
    // Two structurally perfect databases with nobody in them. `integrity_check`,
    // `foreign_key_check`, the G8 receipt cross-check and the seal-key verdict
    // are all clean on this pair — the thrown message naming ONLY the empty
    // shell is the proof that the drill, and nothing above it, caught this.
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
