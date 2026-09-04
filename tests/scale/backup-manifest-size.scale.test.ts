// The backup manifest's size bound (issue #659 S6).
//
// `sealManifest` (packages/backup/src/manifest.ts) rebuilds the WHOLE
// `chunkIndex` — one `{id, size}` per chunk in the snapshot — into the public
// envelope of EVERY manifest, and the envelope is written out in full on
// every generation. That is O(vault) bytes uploaded per snapshot, and it is
// invisible until someone's vault is large: nothing in the suite measured it.
//
// Volume table (kept with the rig):
//
//   | Axis                | Value             | Why                          |
//   | ------------------- | ----------------- | ---------------------------- |
//   | chunk index entries | 25k / 50k / 100k  | ~16 MiB chunks ⇒ 100k ≈ 1.5 TB |
//   | manifest entries    | index / 8         | a file per ~8 chunks         |
//
// Two laws, both about GROWTH rather than a single number: the per-chunk cost
// stays inside a byte budget, and doubling the vault at most doubles the
// manifest. Either one breaking means a manifest that grows faster than the
// data it describes.

import path from "node:path";

import { describe, expect, test } from "vitest";

import { createKeyring, sealManifest } from "@centraid/backup";
import type { ManifestEntry } from "@centraid/backup";
import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";

const OWNER = "tests/scale/backup-manifest-size.scale.test.ts";
const VOLUMES = [25_000, 50_000, 100_000] as const;
/**
 * Bytes one chunk may cost in the stored manifest, measured 2026-07-31 at
 * 205 B/chunk on the volumes below: ~90 B for the public `chunkIndex` entry
 * (`{"id":"<64 hex>","size":16777216}`) plus ~115 B for that chunk's id
 * inside the base64 sealed payload. The ceiling is tighten-only, so it is set
 * just above the measurement — enough to absorb noise, not enough to hide a
 * third copy of the chunk list appearing in the envelope.
 */
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
    // Doubling the vault must at most double the manifest — anything above
    // ~2x means a term that is superlinear in vault size.
    const doublingRatio =
      (sizes.get(100_000) as number) / (sizes.get(50_000) as number);

    const passed =
      bytesPerChunk < BYTES_PER_CHUNK_BUDGET && doublingRatio < 2.2;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Backup manifest size at 100k chunk-index entries",
      status: passed ? "passed" : "failed",
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

    expect(bytesPerChunk).toBeLessThan(BYTES_PER_CHUNK_BUDGET);
    expect(doublingRatio).toBeLessThan(2.2);
    // And the smaller steps agree, so the bound is a curve rather than one
    // lucky point.
    expect(
      (sizes.get(50_000) as number) / (sizes.get(25_000) as number)
    ).toBeLessThan(2.2);
  });
});
