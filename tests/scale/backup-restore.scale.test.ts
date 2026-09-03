import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  createKeyring,
  createSnapshot,
  LocalBackupProvider,
  restoreSnapshot,
} from "@centraid/backup";
import type { SourceEntry } from "@centraid/backup";
import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { generateVolumeFixture } from "@centraid/test-kit/volume-fixture";
import { FsBlobStore, sha256OfBytes, blobUriFor } from "@centraid/vault";

import { createTestVault } from "../helpers/factories.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/backup-restore.scale.test.ts";
const APP_META = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: "1",
  ontologyVersion: "1.2",
  sourceInstanceId: "scale-lane",
};

const PARTY_COUNT = 500;
const BLOB_COUNT = 160;
const BLOB_BYTES = 1024 * 1024;

const DURATION_BUDGET_MS = 12_000;

function blobBytes(index: number): Buffer {
  let state = (458 + index * 2_654_435_761) >>> 0;
  const result = Buffer.allocUnsafe(BLOB_BYTES);
  for (let offset = 0; offset < BLOB_BYTES; offset += 4) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    result.writeUInt32LE(state, offset);
  }
  return result;
}

describe("backup-restore.scale", () => {
  test("backup restores a realistic populated vault byte- and row-faithfully", async () => {
    const sourceDir = await tempDir("backup-scale-source-");
    const providerDir = await tempDir("backup-scale-provider-");
    const keyDir = await tempDir("backup-scale-key-");
    const restoreDir = await tempDir("backup-scale-restore-");
    await rm(restoreDir, { recursive: true, force: true });

    const db = await createTestVault({ dir: sourceDir });
    const fixture = generateVolumeFixture({
      seed: 458,
      parties: PARTY_COUNT,
      photos: BLOB_COUNT,
    });
    const cas = new FsBlobStore(path.join(sourceDir, "blobs"));

    const insertParty = db.vault.prepare(
      `INSERT INTO core_party
       (party_id, kind, display_name, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`
    );
    const insertContent = db.vault.prepare(
      `INSERT INTO core_content_item
       (content_id, media_type, content_uri, sha256, byte_size, created_at)
     VALUES (?, 'application/octet-stream', ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    const blobShas: string[] = [];
    db.vault.exec("BEGIN IMMEDIATE");
    for (const party of fixture.parties) {
      insertParty.run(party.id, party.displayName, 0, 0);
    }
    for (let index = 0; index < BLOB_COUNT; index += 1) {
      const bytes = blobBytes(index);
      const sha = sha256OfBytes(bytes);
      cas.putSync(sha, bytes);
      insertContent.run(
        `content-${index}`,
        blobUriFor(sha),
        sha,
        bytes.length,
        now
      );
      blobShas.push(sha);
    }
    db.vault.exec("COMMIT");

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
        walGeneration: "11".repeat(16),
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
    const { targetId } = await provider.createTarget({ label: "scale-lane" });
    const keyring = await createKeyring(path.join(keyDir, "keyring.json"));

    const started = performance.now();
    const snapshot = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "scale-vault",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(snapshot).not.toBeNull();
    await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "scale-vault",
      destDir: restoreDir,
      current: {
        gatewayVersion: "0.1.0",
        vaultUserVersion: "1",
        ontologyVersion: "1.2",
      },
    });
    const durationMs = performance.now() - started;

    const restoredVaultBytes = await readFile(
      path.join(restoreDir, "vault.db")
    );
    const restoredVaultHash = createHash("sha256")
      .update(restoredVaultBytes)
      .digest("hex");

    const restored = new DatabaseSync(path.join(restoreDir, "vault.db"));
    const partyRows = (
      restored.prepare("SELECT count(*) AS n FROM core_party").get() as {
        n: number;
      }
    ).n;
    const contentRows = (
      restored.prepare("SELECT count(*) AS n FROM core_content_item").get() as {
        n: number;
      }
    ).n;
    restored.close();

    const spotIndices = [0, Math.floor(BLOB_COUNT / 2), BLOB_COUNT - 1];
    const blobHashesMatch = await Promise.all(
      spotIndices.map(async (index) => {
        const sha = blobShas[index]!;
        const restoredBlob = await readFile(
          path.join(restoreDir, "blobs", "sha256", sha.slice(0, 2), sha)
        );
        return createHash("sha256").update(restoredBlob).digest("hex") === sha;
      })
    );

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const passed =
      restoredVaultHash === sourceVaultHash &&
      partyRows >= PARTY_COUNT &&
      contentRows === BLOB_COUNT &&
      blobHashesMatch.every(Boolean) &&
      durationMs < DURATION_BUDGET_MS;
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Backup restore of a ${BLOB_COUNT} MiB populated vault`,
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          budget: DURATION_BUDGET_MS,
        },
        {
          name: "restored vault bytes",
          value: restoredVaultBytes.length,
          unit: "bytes",
        },
        { name: "party rows restored", value: partyRows, unit: "rows" },
        { name: "content rows restored", value: contentRows, unit: "rows" },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);

    expect(restoredVaultHash).toBe(sourceVaultHash);
    expect(partyRows).toBeGreaterThanOrEqual(PARTY_COUNT);
    expect(contentRows).toBe(BLOB_COUNT);
    expect(blobHashesMatch).toStrictEqual([true, true, true]);
    expect(durationMs).toBeLessThan(DURATION_BUDGET_MS);
  });
});
