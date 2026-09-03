import path from "node:path";

import { describe, expect, test } from "vitest";

import { createKeyring, sealManifest } from "@centraid/backup";
import type { ManifestEntry } from "@centraid/backup";
import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/backup-manifest-size.scale.test.ts";
const VOLUMES = [25_000, 50_000, 100_000] as const;
const BYTES_PER_CHUNK_BUDGET = 230;

function chunkIndexOf(count: number): { id: string; size: number }[] {
  const index: { id: string; size: number }[] = [];
  for (let i = 0; i < count; i += 1)
    index.push({
      id: i.toString(16).padStart(64, "0"),
      size: 16 * 1024 * 1024,
    });
  return index;
}

function entriesOf(chunkCount: number): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < chunkCount; i += 8) {
    entries.push({
      path: `blobs/sha256/${i.toString(16).padStart(64, "0")}`,
      kind: "blob",
      size: 8 * 16 * 1024 * 1024,
      mtimeMs: 1_780_000_000_000,
      chunks: Array.from({ length: 8 }, (_unused, k) =>
        (i + k).toString(16).padStart(64, "0")
      ),
    });
  }
  return entries;
}

describe("backup-manifest-size.scale", () => {
  test("manifest bytes grow no faster than the vault they describe", async () => {
    const keyDir = await tempDir("manifest-size-keys-");
    const keyring = await createKeyring(path.join(keyDir, "keyring.json"));

    const sizes = new Map<number, number>();
    let sealMs = 0;
    for (const volume of VOLUMES) {
      const started = performance.now();
      const sealed = sealManifest({
        keyring,
        vaultId: "scale-vault",
        keyEpoch: 1,
        generation: 1,
        prevManifestHash: null,
        chunkIndex: chunkIndexOf(volume),
        appMeta: { gatewayVersion: "0.1.0" },
        entries: entriesOf(volume),
        createdAt: "2026-07-31T00:00:00.000Z",
      });
      sealMs += performance.now() - started;
      sizes.set(volume, sealed.bytes.byteLength);
    }

    const largest = VOLUMES[VOLUMES.length - 1] as number;
    const bytesPerChunk = (sizes.get(largest) as number) / largest;
    const doublingRatio =
      (sizes.get(100_000) as number) / (sizes.get(50_000) as number);

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const passed =
      bytesPerChunk < BYTES_PER_CHUNK_BUDGET && doublingRatio < 2.2;
    const withinDrift = drift === null || bytesPerChunk <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Backup manifest size at 100k chunk-index entries",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "bytes per chunk",
          value: bytesPerChunk,
          unit: "bytes",
          budget: BYTES_PER_CHUNK_BUDGET,
        },
        {
          name: "manifest bytes at 100k chunks",
          value: sizes.get(100_000) as number,
          unit: "bytes",
        },
        { name: "50k→100k growth", value: doublingRatio, unit: "x" },
        { name: "seal wall clock", value: sealMs, unit: "ms" },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${bytesPerChunk} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);

    expect(bytesPerChunk).toBeLessThan(BYTES_PER_CHUNK_BUDGET);
    expect(doublingRatio).toBeLessThan(2.2);
    expect(
      (sizes.get(50_000) as number) / (sizes.get(25_000) as number)
    ).toBeLessThan(2.2);
  });
});
