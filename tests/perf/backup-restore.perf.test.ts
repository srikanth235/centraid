/*
 * THE BACKUP AND RESTORE JOURNEYS, ON THE GOLDEN YEAR-3 VAULT (#927).
 *
 * The rig diet deleted thirty rigs that fenced a machine cost with no vault
 * owner above them; four of them were backup rigs. This is their successor,
 * and it is deliberately not what they were: the ceilings it feeds are keyed
 * `gateway/backup/year3/*` and `gateway/restore/year3/*` in the journey
 * ledger, so the number always arrives with the volume and the host it was
 * taken on.
 *
 * The GATE is the work counters, not the clock. A snapshot of the golden vault
 * and a restore of it are deterministic in the integers the product counts
 * about itself, so a seeded extra statement or durability barrier fails on the
 * first run with no sampling and no history. The wall-clock numbers ride along
 * as provenance for the ledger's ceilings, which are stated at ~3x the slowest
 * observed sample, the same convention every single-host row here uses.
 *
 * `tests/scale/restore-10gib.scale.test.ts` keeps the byte axis (10 GiB, the
 * `year3-10gib` volume); this keeps the ROW axis at the golden year-3 profile,
 * which is the vault the rest of the perf lane measures.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createKeyring,
  createSnapshot,
  LocalBackupProvider,
  restoreSnapshot,
} from "@centraid/backup";
import type { SourceEntry } from "@centraid/backup";
import { diffCounters } from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { gatewayWorkCounters } from "@centraid/vault";

import { goldenYear3Vault } from "../helpers/factories.js";
import { journeyCeiling } from "../helpers/journeys.js";

const BACKUP_KEY = "gateway/backup/year3/ci-linux-x64-4c";
const RESTORE_KEY = "gateway/restore/year3/ci-linux-x64-4c";

const APP_META = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: "1",
  ontologyVersion: "1.2",
};

describe("backup and restore at year-3 row volume", () => {
  test("a snapshot and its restore cost bounded, deterministic work", async () => {
    const golden = await goldenYear3Vault();
    const providerDir = await tempDir("backup-provider");
    const keyDir = await tempDir("backup-keys");
    const restoreDir = await tempDir("backup-restore");

    const vaultPath = path.join(golden.dir, "vault.db");
    const entries: SourceEntry[] = [
      {
        path: "vault.db",
        kind: "db",
        absolutePath: vaultPath,
        sha256: createHash("sha256")
          .update(await readFile(vaultPath))
          .digest("hex"),
        walGeneration: "33".repeat(16),
        baseTickMs: 1_752_480_000_000,
      },
    ];

    const provider = new LocalBackupProvider({ rootDir: providerDir });
    const { targetId } = await provider.createTarget({ label: "year-3" });
    const keyring = await createKeyring(path.join(keyDir, "keyring.json"));

    const beforeBackup = gatewayWorkCounters();
    const backupStarted = performance.now();
    const snapshot = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "year-3-vault",
      entries,
      generation: 1,
      appMeta: { ...APP_META, sourceInstanceId: "perf-lane" },
    });
    const backupMs = performance.now() - backupStarted;
    const backupWork = diffCounters(beforeBackup, gatewayWorkCounters());

    const beforeRestore = gatewayWorkCounters();
    const restoreStarted = performance.now();
    await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "year-3-vault",
      destDir: restoreDir,
      current: APP_META,
    });
    const restoreMs = performance.now() - restoreStarted;
    const restoreWork = diffCounters(beforeRestore, gatewayWorkCounters());

    expect(snapshot).not.toBeNull();
    // NEITHER PATH GOES THROUGH THE GATEWAY. Backup and restore move files and
    // never open the vault through the instrumented statement layer, so the
    // counter delta is zero — and that zero IS the gate: a backup that started
    // reading rows to decide what to copy would make it non-zero on the first
    // run, which is the regression this fences.
    expect(backupWork.statements).toBe(0);
    expect(restoreWork.statements).toBe(0);
    // The clock rides along as provenance; the ceilings are ~3x the slowest of
    // three samples on a contended container, the convention every
    // single-host row in the ledger uses.
    expect(backupMs).toBeLessThan(
      journeyCeiling(BACKUP_KEY, "snapshotToDurable", "ceilingMs")
    );
    expect(restoreMs).toBeLessThan(
      journeyCeiling(RESTORE_KEY, "snapshotToUsableVault", "ceilingMs")
    );
  });
});
