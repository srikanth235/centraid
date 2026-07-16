// The property the issue asks for: kill the drainer at random points — including
// mid-PUT byte offsets — reconstruct the queue from SQLite alone, and let it
// run again. No duplicates, no loss, ever.
//
// The CAS object is not merely counted: it is unsealed with the VAULT's own
// reader, so "no loss" means the exact original plaintext came back out of an
// object assembled from parts that may have been sealed across many different
// process lifetimes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  decodeHeader,
  decodeTrailer,
  HEADER_BYTES,
  openDirectory,
  TRAILER_BYTES,
  unsealFrame,
} from '../../../../../packages/vault/src/blob/seal-frames.js';

import { webCryptoUploadCrypto } from './crypto';
import { enqueueLocalFile } from './enqueue';
import {
  FAKE_GATEWAY,
  FakeGateway,
  FakeProvider,
  Killer,
  UploadKillSignalError,
  fakeBlobStoreFetch,
} from './fake-direct-transfer';
import { bytesFileSource } from './file-source';
import { NodeSqliteFileDriver } from './node-sqlite-driver';
import { UploadQueueStore } from './store';
import { UploadDrainer } from './uploader';

const crypto = webCryptoUploadCrypto();
const fetchImpl = fakeBlobStoreFetch();

/**
 * Frames are 4 MiB, so a realistic multi-part object would make this suite
 * seal hundreds of MiB. The kernel's logic is frame-count-driven, not
 * byte-driven, so tests use small files and assert part/frame structure
 * directly; `cbsf.test.ts` covers the real 4 MiB boundaries.
 */
const FILES = [
  { name: 'a.jpg', bytes: bytesOf(3_000, 11) },
  { name: 'b.mp4', bytes: bytesOf(17, 29) },
  { name: 'c.png', bytes: bytesOf(0, 0) },
];

function bytesOf(size: number, seed: number): Uint8Array {
  return new Uint8Array(size).map((_, index) => (index * seed + 7) & 0xff);
}

/** Deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'centraid-upload-'));
  readonly killer = new Killer();
  readonly provider = new FakeProvider(this.killer);
  readonly gateway = new FakeGateway(this.provider, this.killer);
  private driver = new NodeSqliteFileDriver(join(this.dir, 'uploads.db'));
  store = UploadQueueStore.create(this.driver);

  private readonly files = new Map(FILES.map((file) => [`file://${file.name}`, file.bytes]));

  openFile = async (localUri: string) => {
    const bytes = this.files.get(localUri);
    if (!bytes) throw new Error(`no such fake file ${localUri}`);
    return bytesFileSource(bytes);
  };

  /** Simulate process death: drop every handle and reopen from disk alone. */
  remount(): void {
    this.driver.close();
    this.driver = new NodeSqliteFileDriver(join(this.dir, 'uploads.db'));
    this.store = UploadQueueStore.create(this.driver);
  }

  drainer(partConcurrency = 1): UploadDrainer {
    return new UploadDrainer({
      store: this.store,
      client: this.gateway,
      crypto,
      openFile: this.openFile,
      putPart: ({ url, body }) => this.provider.put(url, body),
      gatewayBaseUrl: FAKE_GATEWAY,
      fetchImpl,
      partConcurrency,
    });
  }

  async enqueueAll(): Promise<void> {
    let counter = 0;
    for (const file of FILES) {
      await enqueueLocalFile(
        { store: this.store, openFile: this.openFile, newId: () => `item-${++counter}` },
        {
          localUri: `file://${file.name}`,
          plaintextSize: file.bytes.byteLength,
          filename: file.name,
        },
      );
    }
  }

  dispose(): void {
    this.driver.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Unseal a committed CAS object with the vault's reader; returns plaintext. */
function vaultUnseal(sealed: Uint8Array, sha256: string, key: Uint8Array): Buffer {
  const buf = Buffer.from(sealed);
  decodeHeader(buf.subarray(0, HEADER_BYTES), sha256);
  const trailer = decodeTrailer(buf.subarray(buf.length - TRAILER_BYTES));
  const directoryStart = buf.length - TRAILER_BYTES - trailer.directoryLength;
  const directory = openDirectory(
    Buffer.from(key),
    sha256,
    trailer.frameCount,
    buf.subarray(directoryStart, buf.length - TRAILER_BYTES),
  );
  const framesEnd =
    HEADER_BYTES + directory.sealedLens.reduce((total, length) => total + length, 0);
  expect(framesEnd).toBe(directoryStart);
  const frames: Buffer[] = [];
  for (let index = 0; index < directory.frameCount; index += 1) {
    const start = directory.offsets[index]!;
    frames.push(
      unsealFrame(
        Buffer.from(key),
        sha256,
        index,
        directory.frameCount,
        buf.subarray(start, start + directory.sealedLens[index]!),
      ),
    );
  }
  return Buffer.concat(frames);
}

function assertNoLossNoDupes(harness: Harness): void {
  // Every enqueued item reached a settled receipt.
  for (const file of FILES) {
    const item = harness.store
      .pending()
      .find((pending) => pending.localUri === `file://${file.name}`);
    expect(item, `${file.name} never settled`).toBeUndefined();
  }

  // Exactly one CAS object per sha — no duplicates.
  expect(harness.provider.cas.size).toBe(FILES.length);
  expect(harness.gateway.completeLog.length).toBe(new Set(harness.gateway.completeLog).size);

  // And the bytes are the bytes: unseal each object with the vault's reader.
  for (const file of FILES) {
    const entries = [...harness.provider.cas.entries()];
    const match = entries.find(([sha]) => {
      const recovered = vaultUnseal(
        harness.provider.cas.get(sha)!,
        sha,
        harness.gateway.keyFor(sha),
      );
      return recovered.equals(Buffer.from(file.bytes));
    });
    expect(match, `${file.name} did not survive round-trip`).toBeDefined();
  }
}

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe('durable upload queue under process death', () => {
  it('settles cleanly with no kills (baseline)', async () => {
    harness = new Harness();
    await harness.enqueueAll();
    const summary = await harness.drainer().drainOnce();
    expect(summary.settled).toBe(FILES.length);
    expect(summary.failed).toBe(0);
    assertNoLossNoDupes(harness);
  });

  // The seeded sweep: kill at a random step, reconstruct from SQLite, repeat
  // until everything settles. Steps include mid-PUT byte offsets, the gap
  // between a stored PUT and its receipt, and the gap between a committed CAS
  // object and its persisted receipt.
  for (const seed of [1, 7, 42, 1337, 90_210]) {
    it(`survives randomized kills and settles exactly once (seed ${seed})`, async () => {
      harness = new Harness();
      await harness.enqueueAll();
      const next = rng(seed);
      let rounds = 0;
      for (; rounds < 200; rounds += 1) {
        harness.killer.budget = Math.floor(next() * 25);
        try {
          await harness.drainer(1 + Math.floor(next() * 3)).drainOnce();
        } catch (error) {
          if (!(error instanceof UploadKillSignalError)) throw error;
        }
        harness.remount();
        if (harness.store.pending().length === 0) break;
      }
      expect(rounds, 'queue never reached a settled state').toBeLessThan(200);
      assertNoLossNoDupes(harness);
    });
  }

  // Exhaustive rather than random: kill at EVERY step index in turn. This is
  // the strongest form of the property — no reachable seam is left untested.
  it('survives a kill at every single step index', async () => {
    for (let budget = 0; budget < 40; budget += 1) {
      const local = new Harness();
      try {
        await local.enqueueAll();
        local.killer.budget = budget;
        try {
          await local.drainer().drainOnce();
        } catch (error) {
          if (!(error instanceof UploadKillSignalError)) throw error;
        }
        // Unlimited budget from here: the queue must recover on its own.
        local.killer.budget = Number.POSITIVE_INFINITY;
        for (let round = 0; round < 10; round += 1) {
          local.remount();
          if (local.store.pending().length === 0) break;
          await local.drainer().drainOnce();
        }
        local.remount();
        assertNoLossNoDupes(local);
      } finally {
        local.dispose();
      }
    }
  });

  it('replays the receipt when a PUT lands but recordPart never does', async () => {
    // The interesting case, pinned deterministically rather than left to the
    // sweep: stop exactly at the first `record`, when the provider holds the
    // bytes and the queue has persisted the ETag.
    harness = new Harness();
    await harness.enqueueAll();
    harness.killer.budget = 0;
    const killAt = 'record:1';
    // Walk the budget forward until the kill lands on the first recordPart.
    let budget = 0;
    for (; budget < 40; budget += 1) {
      const probe = new Harness();
      try {
        await probe.enqueueAll();
        probe.killer.budget = budget;
        try {
          await probe.drainer().drainOnce();
        } catch (error) {
          if (error instanceof UploadKillSignalError && error.at === killAt) break;
        }
      } finally {
        probe.dispose();
      }
    }
    expect(budget, 'no reachable kill point at the PUT/recordPart gap').toBeLessThan(40);

    harness.killer.budget = budget;
    await expect(harness.drainer().drainOnce()).rejects.toThrow(UploadKillSignalError);

    // The ETag is on disk even though the gateway never acknowledged it.
    harness.remount();
    const item = harness.store.pending()[0]!;
    const put = harness.store.parts(item.itemId).filter((part) => part.state === 'put');
    expect(put.length, 'the PUT ETag was not durable before the receipt').toBeGreaterThan(0);

    const putsBefore = harness.provider.putLog.length;
    harness.killer.budget = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 10; round += 1) {
      harness.remount();
      if (harness.store.pending().length === 0) break;
      await harness.drainer().drainOnce();
    }
    harness.remount();
    assertNoLossNoDupes(harness);

    // The recovered part was NOT re-uploaded: the receipt was replayed from
    // the durable ETag instead.
    const reUploads = harness.provider.putLog
      .slice(putsBefore)
      .filter(
        (entry) => entry.partNumber === put[0]!.partNumber && entry.tempId === 'direct-session-1',
      );
    expect(reUploads, 'a durable ETag should replay, not re-upload').toHaveLength(0);
  });

  it('dedupes via alreadyPresent instead of transferring again', async () => {
    harness = new Harness();
    await harness.enqueueAll();
    await harness.drainer().drainOnce();
    const putsAfterFirst = harness.provider.putLog.length;
    expect(putsAfterFirst).toBeGreaterThan(0);

    // Re-enqueue the same bytes under a fresh item id; begin must short-circuit.
    harness.remount();
    await enqueueLocalFile(
      { store: harness.store, openFile: harness.openFile, newId: () => 'item-dupe' },
      { localUri: 'file://a.jpg', plaintextSize: FILES[0]!.bytes.byteLength },
    );
    // Same sha as an already-settled item, so the queue itself dedupes it.
    expect(harness.store.pending()).toHaveLength(0);
    expect(harness.provider.putLog.length).toBe(putsAfterFirst);
    expect(harness.provider.cas.size).toBe(FILES.length);
  });
});
