import { createHash } from "node:crypto";
import { cp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createKeyring,
  createSnapshot,
  LocalBackupProvider,
  restoreSnapshot,
} from "@centraid/backup";
import type { SourceEntry } from "@centraid/backup";
import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  seedYear3Vault,
  materializeYear3Fixture,
  year3VaultProfile,
} from "@centraid/test-kit/year3-vault";
import {
  blobUriFor,
  bootstrapVault,
  FsBlobStore,
  openVaultDb,
  sealAad,
  sealValue,
  sha256OfBytes,
  VAULT_MIGRATIONS,
} from "@centraid/vault";

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/restore-10gib.scale.test.ts";

const TARGET_GIB = Number(process.env.CENTRAID_SCALE_RESTORE_GIB ?? "0");
const ENABLED = Number.isFinite(TARGET_GIB) && TARGET_GIB > 0;

const YEAR3 = year3VaultProfile();
const YEAR3_SEAL_KEY = Buffer.alloc(32, 0x67);
const PARTY_COUNT = YEAR3.parties; // year-3 contacts
const CONTENT_ROWS = YEAR3.photos; // year-3 photo assets
const BLOB_BYTES = 16 * 1024 * 1024;
const targetBytes = Math.round(TARGET_GIB * 1024 * 1024 * 1024);
const BLOB_COUNT = Math.max(1, Math.round(targetBytes / BLOB_BYTES));

function blobBytes(index: number, size = BLOB_BYTES): Buffer {
  let state = (911 + index * 2_654_435_761) >>> 0;
  const result = Buffer.allocUnsafe(size);
  for (let offset = 0; offset < size; offset += 4) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    result.writeUInt32LE(state, offset);
  }
  return result;
}

describe("restore-10gib.scale", () => {
  test.skipIf(!ENABLED)(
    "a year-3 vault restores, and foreign_key_check is measured in isolation",
    async () => {
      const sourceDir = await tempDir("restore-10gib-source-");
      const providerDir = await tempDir("restore-10gib-provider-");
      const keyDir = await tempDir("restore-10gib-key-");
      const restoreDir = await tempDir("restore-10gib-restore-");
      await rm(restoreDir, { recursive: true, force: true });

      const cacheRoot =
        process.env.CENTRAID_YEAR3_CACHE_DIR ??
        (await tempDir("restore-year3-cache-"));
      const materialized = await materializeYear3Fixture(
        cacheRoot,
        async (target) => {
          const seeded = openVaultDb({ dir: target, sealKey: YEAR3_SEAL_KEY });
          try {
            bootstrapVault(seeded, { ownerName: "Restore owner" });
            seedYear3Vault(
              {
                vault: seeded.vault,
                sealCell: (entity, column, rowId, plaintext) =>
                  sealValue(
                    seeded.sealKey,
                    sealAad(entity.replace(".", "_"), column, rowId),
                    plaintext
                  ),
              },
              YEAR3
            );
          } finally {
            seeded.close();
          }
        },
        YEAR3,
        VAULT_MIGRATIONS.length
      );
      await cp(materialized.dir, sourceDir, { recursive: true });
      const db = openVaultDb({ dir: sourceDir, sealKey: YEAR3_SEAL_KEY });
      onTestFinished(() => db.close());
      const cas = new FsBlobStore(path.join(sourceDir, "blobs"));
      const insertContent = db.vault.prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'application/octet-stream', ?, ?, ?, ?)`
      );
      const now = new Date().toISOString();

      const blobShas: string[] = [];
      const BATCH = 8;
      for (let start = 0; start < BLOB_COUNT; start += BATCH) {
        db.vault.exec("BEGIN IMMEDIATE");
        for (
          let index = start;
          index < Math.min(start + BATCH, BLOB_COUNT);
          index += 1
        ) {
          const bytes = blobBytes(index);
          const sha = sha256OfBytes(bytes);
          cas.putSync(sha, bytes);
          insertContent.run(
            `filler-${index}`,
            blobUriFor(sha),
            sha,
            bytes.length,
            now
          );
          blobShas.push(sha);
        }
        db.vault.exec("COMMIT");
      }

      db.vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      const vaultPath = path.join(sourceDir, "vault.db");
      const vaultBytes = await readFile(vaultPath);
      const sourceVaultHash = createHash("sha256")
        .update(vaultBytes)
        .digest("hex");

      const baseTickMs = 1_752_480_000_000;
      const entries: SourceEntry[] = [
        {
          path: "vault.db",
          kind: "db",
          absolutePath: vaultPath,
          sha256: sourceVaultHash,
          walGeneration: "33".repeat(16),
          baseTickMs,
        },
        ...blobShas.map((sha) => ({
          path: `blobs/sha256/${sha.slice(0, 2)}/${sha}`,
          kind: "blob" as const,
          absolutePath: path.join(
            sourceDir,
            "blobs",
            "sha256",
            sha.slice(0, 2),
            sha
          ),
        })),
      ];

      const provider = new LocalBackupProvider({ rootDir: providerDir });
      const { targetId } = await provider.createTarget({ label: "year-3" });
      const keyring = await createKeyring(path.join(keyDir, "keyring.json"));

      const snapshotStarted = performance.now();
      const snapshot = await createSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "year-3-vault",
        entries,
        generation: 1,
        appMeta: {
          gatewayVersion: "0.1.0",
          vaultUserVersion: "1",
          ontologyVersion: "1.2",
          sourceInstanceId: "scale-lane",
        },
      });
      const snapshotMs = performance.now() - snapshotStarted;
      expect(snapshot).not.toBeNull();

      const restoreStarted = performance.now();
      await restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "year-3-vault",
        destDir: restoreDir,
        current: {
          gatewayVersion: "0.1.0",
          vaultUserVersion: "1",
          ontologyVersion: "1.2",
        },
      });
      const restoreMs = performance.now() - restoreStarted;

      const restoredVaultPath = path.join(restoreDir, "vault.db");
      const restoredBytes = (await stat(restoredVaultPath)).size;

      const fkConn = new DatabaseSync(restoredVaultPath);
      const fkStarted = performance.now();
      const fkViolations = fkConn.prepare("PRAGMA foreign_key_check").all();
      const foreignKeyCheckMs = performance.now() - fkStarted;
      fkConn.close();

      const integrityConn = new DatabaseSync(restoredVaultPath);
      const integrityStarted = performance.now();
      const integrity = integrityConn
        .prepare("PRAGMA integrity_check")
        .get() as { integrity_check: string } | undefined;
      const integrityCheckMs = performance.now() - integrityStarted;
      integrityConn.close();

      const restored = new DatabaseSync(restoredVaultPath);
      const partyRows = (
        restored.prepare("SELECT count(*) AS n FROM core_party").get() as {
          n: number;
        }
      ).n;
      const contentRows = (
        restored
          .prepare("SELECT count(*) AS n FROM core_content_item")
          .get() as { n: number }
      ).n;
      restored.close();

      const restoredVaultHash = createHash("sha256")
        .update(await readFile(restoredVaultPath))
        .digest("hex");

      const seededBytes = BLOB_COUNT * BLOB_BYTES;

      const experience = JSON.parse(
        await readFile("tests/experience-budgets/gateway.json", "utf8")
      ) as {
        metrics: {
          year3RestoreSeconds: { ceilingSeconds: number };
          restoreForeignKeyCheckMs: { ceilingMs: number };
        };
      };
      const atDeclaredVolume = TARGET_GIB >= 10;
      const restoreCeilingMs =
        experience.metrics.year3RestoreSeconds.ceilingSeconds * 1_000;
      const fkCeilingMs = experience.metrics.restoreForeignKeyCheckMs.ceilingMs;
      const withinCeilings =
        !atDeclaredVolume ||
        (restoreMs <= restoreCeilingMs && foreignKeyCheckMs <= fkCeilingMs);
      const drift = await rigDriftBudgetMs("scale", OWNER);
      const withinDrift = drift === null || restoreMs <= drift;
      const passed =
        restoredVaultHash === sourceVaultHash &&
        fkViolations.length === 0 &&
        integrity?.integrity_check === "ok" &&
        partyRows >= PARTY_COUNT &&
        contentRows === CONTENT_ROWS + BLOB_COUNT &&
        withinCeilings &&
        withinDrift;

      console.log("\n========== YEAR-3 RESTORE ==========");
      console.log(`seeded CAS bytes:        ${seededBytes}`);
      console.log(`content rows:            ${CONTENT_ROWS + BLOB_COUNT}`);
      console.log(`restored vault.db bytes: ${restoredBytes}`);
      console.log(`snapshot:                ${Math.round(snapshotMs)} ms`);
      console.log(`RESTORE:                 ${Math.round(restoreMs)} ms`);
      console.log(
        `foreign_key_check:       ${foreignKeyCheckMs.toFixed(1)} ms`
      );
      console.log(`integrity_check:         ${integrityCheckMs.toFixed(1)} ms`);
      console.log("====================================\n");

      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: `Year-3 restore (${TARGET_GIB} GiB seeded, ${CONTENT_ROWS + BLOB_COUNT} content rows, ${PARTY_COUNT} parties)`,
        status: passed ? "passed" : "failed",
        measurements: [
          {
            name: "restore wall clock",
            value: restoreMs,
            unit: "ms",
            ...(drift === null ? {} : { budget: drift }),
          },
          { name: "snapshot wall clock", value: snapshotMs, unit: "ms" },
          {
            name: "foreign_key_check (isolated)",
            value: foreignKeyCheckMs,
            unit: "ms",
          },
          {
            name: "integrity_check (isolated)",
            value: integrityCheckMs,
            unit: "ms",
          },
          { name: "seeded CAS bytes", value: seededBytes, unit: "bytes" },
          { name: "restored vault.db", value: restoredBytes, unit: "bytes" },
          {
            name: "rows checked by foreign_key_check",
            value: CONTENT_ROWS + BLOB_COUNT + PARTY_COUNT,
            unit: "rows",
          },
        ],
      });

      expect(restoredVaultHash).toBe(sourceVaultHash);
      expect(fkViolations).toStrictEqual([]);
      expect(integrity?.integrity_check).toBe("ok");
      expect(partyRows).toBeGreaterThanOrEqual(PARTY_COUNT);
      expect(contentRows).toBe(CONTENT_ROWS + BLOB_COUNT);
      expect(
        withinCeilings,
        `year-3 ceilings (asserted only at >= 10 GiB; this run seeded ${TARGET_GIB} GiB): ` +
          `restore ${Math.round(restoreMs)} ms vs ${restoreCeilingMs} ms, ` +
          `foreign_key_check ${foreignKeyCheckMs.toFixed(1)} ms vs ${fkCeilingMs} ms`
      ).toBe(true);
      expect(
        withinDrift,
        `sustained drift: ${restoreMs} ms vs drift budget ${drift} ms (1.5x the trailing median of the last 30 nightly samples)`
      ).toBe(true);
    },
    3_600_000
  );
});
