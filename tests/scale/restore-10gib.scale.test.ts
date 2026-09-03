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
  year3FixtureCacheRoot,
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

/**
 * YEAR-3 RESTORE (issue #659 S3).
 *
 * Backup honesty is a product promise: the vault owner is told their data can
 * come back. Until this rig, the largest restore the repo had ever executed was
 * `backup-restore.scale.test.ts` at ~160 MiB, and the year-3 restore time — the
 * number that decides whether "restore my vault" is a coffee break or an
 * afternoon — was a guess. Nobody had ever run it.
 *
 * It also isolates the one step whose cost is superlinear in the wrong way:
 * `PRAGMA foreign_key_check`. `packages/backup/src/wal-restore.ts` (checkDb)
 * runs `integrity_check` AND `foreign_key_check` on every restored database and
 * treats either failure as fatal — correctly, because a committed state can
 * never hold an FK violation, so one means the replay produced a wrong vault.
 * But `foreign_key_check` with no arguments walks EVERY row of EVERY table with
 * a foreign key and probes the parent index for each. That is O(rows), it runs
 * inside the restore the owner is waiting on, and its cost at year-3 volumes had
 * never been separated from the rest of the restore. This rig times it alone
 * and publishes the number.
 *
 * ── Year-3 declared volume (docs/coding-standards.md D6) ────────────────────
 *
 * | Dimension          | Year-3   | Seeded here                              |
 * | ------------------ | -------- | ---------------------------------------- |
 * | Vault on disk      | 10 GiB   | `CENTRAID_SCALE_RESTORE_GIB` (default 10) |
 * | Photo assets       | 90,000   | 90,000 `core_content_item` rows over a shared CAS pool    |
 * | Contacts / people  | 5,000    | `core_party` rows                        |
 * | CAS objects        | 100,000  | one 16 MiB filler per 16 MiB of target (byte axis)       |
 *
 * The full table lives in tests/experience-budgets/README.md. When the target
 * size changes, the measured numbers and the volume move together — a restore
 * duration with no stated size is not a measurement.
 *
 * ── Why this is opt-in ──────────────────────────────────────────────────────
 *
 * Ten GiB through the chunker, AEAD, and back is tens of minutes and ~25 GiB of
 * scratch disk. It cannot share the 30-minute nightly scale job, and it must
 * never touch the PR lane (TESTING.md). It runs only when
 * `CENTRAID_SCALE_RESTORE_GIB` is set — its own nightly job sets it — and
 * SKIPS loudly otherwise rather than silently shrinking to a size that proves
 * nothing.
 */
const OWNER = "tests/scale/restore-10gib.scale.test.ts";

const TARGET_GIB = Number(process.env.CENTRAID_SCALE_RESTORE_GIB ?? "0");
const ENABLED = Number.isFinite(TARGET_GIB) && TARGET_GIB > 0;

// Two axes, deliberately decoupled — the first cut of this rig scaled rows WITH
// bytes and produced 2,560 content rows at 10 GiB, which made the
// foreign_key_check number meaningless (measured 8.8 ms over 5,256 rows at
// 1 GiB). Restore duration is driven by BYTES; foreign_key_check is driven by
// ROWS. Both must be at year-3 or the rig answers the wrong question.
const YEAR3 = year3VaultProfile();
const YEAR3_SEAL_KEY = Buffer.alloc(32, 0x67);
const PARTY_COUNT = YEAR3.parties; // year-3 contacts
const CONTENT_ROWS = YEAR3.photos; // year-3 photo assets
// `core_content_item.sha256` is UNIQUE, so the row axis cannot share one CAS
// object across rows. It also does not need to MATERIALIZE one: no foreign key
// ties a content row to a CAS file, and foreign_key_check — the thing being
// measured — walks rows, not bytes. So the row axis inserts 90,000 rows with
// distinct synthetic digests and writes no files for them; the byte axis below
// carries the real CAS bytes. Stated plainly because it is the one place this
// fixture is not a faithful vault.
const BLOB_BYTES = 16 * 1024 * 1024;
const targetBytes = Math.round(TARGET_GIB * 1024 * 1024 * 1024);
const BLOB_COUNT = Math.max(1, Math.round(targetBytes / BLOB_BYTES));

/** Deterministic pseudo-random payload; incompressible enough to be honest. */
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

      // ONE way to name the fixture cache (#927 P4): the env-var-or-temp-dir
      // dance lives in the kit, so a rig cannot drift from where CI caches.
      const cacheRoot = year3FixtureCacheRoot();
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

      // Byte axis: the fixture's 90k logical photos deliberately do not
      // materialize 90k CAS files; large filler objects carry the real bytes.
      const blobShas: string[] = [];
      // Large filler objects are written in committed batches so a
      // 10 GiB seed never holds one transaction open for the whole run.
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

      // ── The isolated integrity pragmas ────────────────────────────────────
      // Measured on the RESTORED file, one at a time, on a freshly opened
      // connection so neither warms the other's page cache. This is the number
      // #659 S3 exists to publish: how much of a year-3 restore is spent
      // proving the restore is honest, as opposed to moving bytes.
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

      // The owner-facing ceilings live in tests/experience-budgets/gateway.json
      // and are asserted HERE, so they are not another budget nobody reads.
      // They are stated AT 10 GiB, so a smaller opt-in run (used to develop the
      // rig) reports but does not gate — a 1 GiB run passing a 10 GiB ceiling
      // would be a meaningless green.
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
      // Unconditional assertion on a boolean rather than a conditional expect:
      // the ceilings are stated AT 10 GiB, so a smaller development run reports
      // and does not gate, and `withinCeilings` already encodes that.
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
    // Ten GiB of chunk + AEAD + restore is tens of minutes on a CI disk. This
    // is a runaway guard, not a budget — the budget is the drift gate above.
    3_600_000
  );
});
