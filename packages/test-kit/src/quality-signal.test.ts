import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "./quality-result.js";
import { forEachSequentially } from "./sequential.js";
import { tempDir } from "./temp-dir.js";
import { generateVolumeFixture } from "./volume-fixture.js";

/**
 * `quality-result.ts` and `volume-fixture.ts` are the
 * substrate the perf and scale rigs stand on: the first decides whether a rig
 * has a budget at all, the second decides what "volume" means. A bug in either
 * does not fail a test — it produces a *false green*, which is strictly worse
 * than a red one. These tests defend the properties whose violation would be
 * invisible.
 *
 * `test-kit.test.ts` owns the shallow happy paths (a budget appears after ten
 * samples; a fixture is reproducible). This file owns the failure modes.
 */

/**
 * `quality-result` resolves `artifacts/<lane>/` against the process cwd, so each
 * test runs inside its own scratch directory. `onTestFinished` restores the real
 * cwd even when the test fails, which a shared `afterEach` at file scope could
 * not do without living outside a describe block.
 */
async function scratchCwd(prefix: string): Promise<string> {
  const original = process.cwd();
  const scratch = await tempDir(prefix);
  onTestFinished(() => {
    process.chdir(original);
  });
  process.chdir(scratch);
  return scratch;
}

describe(recordQualityResult, () => {
  test("bounds retained history at thirty points, keeping the newest", async () => {
    const scratch = await scratchCwd("centraid-quality-bound-");
    await forEachSequentially(
      Array.from({ length: 35 }, (_, index) => index + 1),
      (value) =>
        recordQualityResult({
          lane: "scale",
          owner: "bounded",
          name: "wall",
          status: "passed",
          measurements: [{ name: "wall", value, unit: "ms" }],
        })
    );
    const body = JSON.parse(
      await readFile(
        path.join(scratch, "artifacts", "scale", "bounded.json"),
        "utf8"
      )
    ) as { history: Array<{ value: number }> };
    expect(body.history).toHaveLength(30);
    expect(body.history.map((point) => point.value)).toStrictEqual(
      Array.from({ length: 30 }, (_, index) => index + 6)
    );
  });

  test("records zero when a rig emits no measurements", async () => {
    const scratch = await scratchCwd("centraid-quality-empty-");
    await recordQualityResult({
      lane: "perf",
      owner: "empty",
      name: "wall",
      status: "failed",
      measurements: [],
    });
    const body = JSON.parse(
      await readFile(
        path.join(scratch, "artifacts", "perf", "empty.json"),
        "utf8"
      )
    ) as { status: string; history: Array<{ value: number }> };
    expect(body.status).toBe("failed");
    expect(body.history.map((point) => point.value)).toStrictEqual([0]);
  });

  test("a failed run still appends to history so the budget tracks reality", async () => {
    // Recording only passes would let a degrading rig re-baseline itself out
    // of its own failure the moment it passes again.
    const scratch = await scratchCwd("centraid-quality-failed-");
    await recordQualityResult({
      lane: "scale",
      owner: "degrading",
      name: "wall",
      status: "failed",
      measurements: [{ name: "wall", value: 900, unit: "ms" }],
    });
    const body = JSON.parse(
      await readFile(
        path.join(scratch, "artifacts", "scale", "degrading.json"),
        "utf8"
      )
    ) as { history: Array<{ value: number; at: string }> };
    expect(body.history.map((point) => point.value)).toStrictEqual([900]);
    expect(Number.isNaN(Date.parse(body.history[0]!.at))).toBe(false);
  });

  test("normalizes an owner path into one flat artifact filename", async () => {
    const scratch = await scratchCwd("centraid-quality-slug-");
    await recordQualityResult({
      lane: "perf",
      owner: "tests/perf/Blob Egress.perf",
      name: "wall",
      status: "passed",
      measurements: [{ name: "wall", value: 1, unit: "ms" }],
    });
    // No nested directories, no leading/trailing separator: an owner that
    // slugged into a path would silently write outside the lane directory and
    // the report would never find it.
    await expect(
      readFile(
        path.join(
          scratch,
          "artifacts",
          "perf",
          "tests-perf-Blob-Egress-perf.json"
        ),
        "utf8"
      )
    ).resolves.toContain('"lane": "perf"');
  });

  test("replaces the reported result while appending to history", async () => {
    const scratch = await scratchCwd("centraid-quality-replace-");
    await recordQualityResult({
      lane: "perf",
      owner: "replaced",
      name: "first",
      status: "failed",
      measurements: [{ name: "wall", value: 5, unit: "ms" }],
    });
    await recordQualityResult({
      lane: "perf",
      owner: "replaced",
      name: "second",
      status: "passed",
      measurements: [{ name: "wall", value: 6, unit: "ms", budget: 20 }],
    });
    const body = JSON.parse(
      await readFile(
        path.join(scratch, "artifacts", "perf", "replaced.json"),
        "utf8"
      )
    ) as {
      name: string;
      status: string;
      measurements: Array<{ budget?: number }>;
      history: Array<{ value: number }>;
    };
    expect(body.name).toBe("second");
    expect(body.status).toBe("passed");
    expect(body.measurements[0]?.budget).toBe(20);
    expect(body.history.map((point) => point.value)).toStrictEqual([5, 6]);
  });

  test("creates the lane directory when it does not exist", async () => {
    const scratch = await scratchCwd("centraid-quality-mkdir-");
    await rm(path.join(scratch, "artifacts"), { recursive: true, force: true });
    await recordQualityResult({
      lane: "scale",
      owner: "fresh",
      name: "wall",
      status: "passed",
      measurements: [{ name: "wall", value: 3, unit: "ms" }],
    });
    await expect(
      readFile(path.join(scratch, "artifacts", "scale", "fresh.json"), "utf8")
    ).resolves.toContain('"owner": "fresh"');
  });
});

describe(generateVolumeFixture, () => {
  test("a different seed produces different data at the same cardinality", () => {
    // Determinism is already owned by test-kit.test.ts. The complementary
    // property: the seed must actually be wired in, or every "seeded" rig run
    // in the fleet is secretly the identical corpus.
    const a = generateVolumeFixture({ seed: 1, photos: 4, parties: 2 });
    const b = generateVolumeFixture({ seed: 2, photos: 4, parties: 2 });
    expect(a.photos).toHaveLength(b.photos.length);
    expect(a.photos.map((photo) => photo.sha256)).not.toStrictEqual(
      b.photos.map((photo) => photo.sha256)
    );
  });

  test("content hashes are unique across the corpus", () => {
    // Scale rigs measure dedupe and blob GC. Colliding synthetic hashes would
    // make a 1,000-photo corpus behave like a 1-photo corpus and every
    // volume claim in the report would be a lie.
    const fixture = generateVolumeFixture({ seed: 7, photos: 250 });
    expect(new Set(fixture.photos.map((photo) => photo.sha256)).size).toBe(250);
  });

  test("blobs mirror the photo corpus one-for-one", () => {
    const fixture = generateVolumeFixture({ seed: 3, photos: 30 });
    expect(fixture.blobs.map((blob) => blob.sha256)).toStrictEqual(
      fixture.photos.map((photo) => photo.sha256)
    );
    expect(fixture.blobs.map((blob) => blob.bytes)).toStrictEqual(
      fixture.photos.map((photo) => photo.bytes)
    );
  });

  test("blob custody covers all three states so GC rigs exercise every branch", () => {
    const fixture = generateVolumeFixture({ seed: 3, photos: 9 });
    expect(fixture.blobs.map((blob) => blob.custody)).toStrictEqual([
      "local",
      "replicated",
      "pending",
      "local",
      "replicated",
      "pending",
      "local",
      "replicated",
      "pending",
    ]);
  });

  test("every photo and conversation is owned by a generated party", () => {
    const fixture = generateVolumeFixture({
      seed: 11,
      parties: 5,
      photos: 23,
      conversations: 7,
    });
    const ids = new Set(fixture.parties.map((party) => party.id));
    expect(fixture.photos.every((photo) => ids.has(photo.ownerId))).toBe(true);
    expect(
      fixture.conversations.every((conversation) =>
        ids.has(conversation.ownerId)
      )
    ).toBe(true);
  });

  test("timestamps increase monotonically within a corpus", () => {
    // Ledger and ontology rigs sort and window by time; a fixture whose
    // capture times were constant would make those queries trivially fast.
    const fixture = generateVolumeFixture({ seed: 5, photos: 50 });
    const captured = fixture.photos.map((photo) => photo.capturedAt);
    expect(captured).toStrictEqual([...captured].toSorted((a, b) => a - b));
    expect(new Set(captured).size).toBe(50);
  });

  test("turns are ordered within each conversation", () => {
    const fixture = generateVolumeFixture({
      seed: 5,
      conversations: 3,
      turnsPerConversation: 8,
    });
    for (const conversation of fixture.conversations) {
      const times = conversation.turns.map((turn) => turn.at);
      expect(times).toStrictEqual([...times].toSorted((a, b) => a - b));
    }
  });

  test("replicaRows default to the photo cardinality and can be sized apart", () => {
    expect(
      generateVolumeFixture({ seed: 2, photos: 12 }).replicaRows
    ).toHaveLength(12);
    expect(
      generateVolumeFixture({ seed: 2, photos: 12, replicaRows: 40 })
        .replicaRows
    ).toHaveLength(40);
  });

  test("replicaRows address the same content ids as the photo corpus", () => {
    const fixture = generateVolumeFixture({ seed: 4, photos: 6 });
    expect(fixture.replicaRows.map((row) => row.rowId)).toStrictEqual(
      fixture.photos.map((photo) => photo.id)
    );
  });

  test("a zero-party request does not crash or produce a photo corpus", () => {
    const fixture = generateVolumeFixture({ seed: 8, parties: 0, photos: 3 });
    expect(fixture.parties).toStrictEqual([]);
    expect(fixture.photos.map((photo) => photo.ownerId)).toStrictEqual([
      "owner",
      "owner",
      "owner",
    ]);
  });

  test("an empty corpus is representable", () => {
    const fixture = generateVolumeFixture({
      seed: 1,
      parties: 0,
      photos: 0,
      conversations: 0,
      replicaRows: 0,
    });
    expect([
      fixture.parties.length,
      fixture.photos.length,
      fixture.blobs.length,
      fixture.conversations.length,
      fixture.replicaRows.length,
    ]).toStrictEqual([0, 0, 0, 0, 0]);
  });

  test("photo sizes vary around the requested blob size", () => {
    // Fixed-size blobs would hide chunk-boundary behaviour in CBSF framing.
    const fixture = generateVolumeFixture({
      seed: 6,
      photos: 40,
      blobBytes: 1_024,
    });
    const sizes = fixture.photos.map((photo) => photo.bytes);
    expect(Math.min(...sizes)).toBe(1_024);
    expect(new Set(sizes).size).toBe(17);
  });

  test("the seed used is reported back on the fixture", () => {
    expect(generateVolumeFixture({ seed: 42 }).seed).toBe(42);
    expect(generateVolumeFixture().seed).toBe(458);
  });
});
