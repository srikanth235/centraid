// Direct edge-sealed upload unit tests (#545) — mocked remote tier.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, assert, beforeEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { VaultBlobRemoteUnavailableError } from "../errors.js";
import type { BlobCache } from "./cache.js";
import { BlobContentKeyRegistry } from "./content-keys.js";
import type { CustodyState, RemoteTier } from "./custody-types.js";
import { DirectBlobTransfers } from "./direct-transfers.js";
import { validExifJpeg } from "./exif-fixtures.js";
import {
  contributeIngressPreviews,
  INGRESS_PREVIEW_MAX_BYTES,
} from "./preview.js";
import type { IngressPreviewInput, PreviewCodec } from "./preview.js";
import { sealBlob } from "./seal.js";
import { sha256OfBytes } from "./store.js";
import { BlobTransferState } from "./transfer-state.js";

const SHA = createHash("sha256").update("direct-bytes").digest("hex");

let db: VaultDb;
let contentKeys: BlobContentKeyRegistry;
let state: BlobTransferState;
let deviceId: string;

describe("direct-transfers", () => {
  beforeEach(() => {
    db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    deviceId = boot.deviceId;
    contentKeys = new BlobContentKeyRegistry(db.vault, randomBytes(32));
    state = new BlobTransferState(db.vault);
  });

  afterEach(() => {
    db.close();
  });

  function makeTransfers(opts: {
    remote?: RemoteTier | null;
    preflight?: {
      exists: boolean;
      custody: CustodyState;
      remoteAvailable: boolean;
      byteSize?: number;
      mediaType?: string;
      contentId?: string;
    };
  }): DirectBlobTransfers {
    const remote = opts.remote ?? null;
    return new DirectBlobTransfers({
      vault: db.vault,
      cache: { dir: "/tmp" } as unknown as BlobCache,
      remote: () => remote,
      contentKeys,
      state,
      preflight: async () =>
        opts.preflight ?? {
          exists: false,
          custody: "local-only",
          remoteAvailable: true,
        },
      emit: () => undefined,
    });
  }

  function remoteWithTransfer(): RemoteTier {
    return {
      store: {} as never,
      transfer: {
        beginTemporaryUpload: async () => "upload-1",
        uploadTemporaryPart: async () => "etag-1",
        completeTemporaryUpload: async () => undefined,
        abortTemporaryUpload: async () => undefined,
        presignTemporaryPut: async () => new URL("https://upload.example/put"),
        presignTemporaryPart: async (_t: string, _u: string, part: number) =>
          new URL(`https://upload.example/part/${part}`),
        copyTemporaryToFinal: async () => undefined,
        deleteTemporary: async () => undefined,
      },
      keyFor: () => randomBytes(32),
    } as unknown as RemoteTier;
  }

  test("begin rejects when no encrypted S3 transfer tier is available", async () => {
    const transfers = makeTransfers({ remote: null });
    await expect(
      transfers.begin({
        sha256: SHA,
        plaintextSize: 12,
        sealedSize: 40,
        deviceId,
      })
    ).rejects.toBeInstanceOf(VaultBlobRemoteUnavailableError);
  });

  test("begin rejects out-of-range partCount", async () => {
    const transfers = makeTransfers({ remote: remoteWithTransfer() });
    await expect(
      transfers.begin({
        sha256: SHA,
        plaintextSize: 12,
        sealedSize: 40,
        partCount: 0,
        deviceId,
      })
    ).rejects.toThrow(/partCount must be between 1 and 10000/u);
    await expect(
      transfers.begin({
        sha256: SHA,
        plaintextSize: 12,
        sealedSize: 40,
        partCount: 10_001,
        deviceId,
      })
    ).rejects.toThrow(/partCount must be between 1 and 10000/u);
  });

  test("begin returns alreadyPresent settlement with casAck derived from custody", async () => {
    const transfers = makeTransfers({
      remote: remoteWithTransfer(),
      preflight: {
        exists: true,
        custody: "replicated",
        remoteAvailable: true,
        byteSize: 12,
        mediaType: "text/plain",
        contentId: "c1",
      },
    });
    const result = await transfers.begin({
      sha256: SHA,
      plaintextSize: 12,
      sealedSize: 40,
      deviceId,
    });
    expect(result.alreadyPresent).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.settlement).toStrictEqual({
      alreadyPresent: true,
      sha256: SHA,
      casAck: "replicated",
      custody: "replicated",
      acknowledged: true,
      byteSize: 12,
      mediaType: "text/plain",
      existingContentId: "c1",
    });
    expect(result.keyBase64.length).toBeGreaterThan(10);
  });

  test("begin settles local-only existing bytes as receipt (not free-to-delete)", async () => {
    const transfers = makeTransfers({
      remote: remoteWithTransfer(),
      preflight: {
        exists: true,
        custody: "local-only",
        remoteAvailable: true,
      },
    });
    const result = await transfers.begin({
      sha256: SHA,
      plaintextSize: 12,
      sealedSize: 40,
      deviceId,
    });
    expect(result.settlement?.casAck).toBe("receipt");
    expect(result.settlement?.acknowledged).toBe(false);
  });

  test("begin mints a single-part presigned put when the object is new", async () => {
    const transfers = makeTransfers({
      remote: remoteWithTransfer(),
      preflight: {
        exists: false,
        custody: "local-only",
        remoteAvailable: true,
      },
    });
    const result = await transfers.begin({
      sha256: SHA,
      plaintextSize: 12,
      sealedSize: 40,
      deviceId,
      mediaType: "image/jpeg",
      filename: "a.jpg",
    });
    expect(result.alreadyPresent).toBe(false);
    expect(result.sessionId).toBeTruthy();
    expect(result.custody).toBe("pending-offsite");
    expect(result.upload).toStrictEqual({
      kind: "single",
      url: "https://upload.example/put",
    });
  });

  test("begin mints multipart part URLs when partCount > 1", async () => {
    const transfers = makeTransfers({
      remote: remoteWithTransfer(),
      preflight: {
        exists: false,
        custody: "local-only",
        remoteAvailable: true,
      },
    });
    const result = await transfers.begin({
      sha256: SHA,
      plaintextSize: 50_000_000,
      sealedSize: 50_001_000,
      partCount: 3,
      deviceId,
    });
    expect(result.upload?.kind).toBe("multipart");
    assert(result.upload?.kind === "multipart");
    expect(result.upload.uploadId).toBe("upload-1");
    expect(result.upload.parts).toStrictEqual([
      { partNumber: 1, url: "https://upload.example/part/1" },
      { partNumber: 2, url: "https://upload.example/part/2" },
      { partNumber: 3, url: "https://upload.example/part/3" },
    ]);
  });
});

// The direct door's display rungs (#405/#1011). The phone seals at the edge and
// PUTs straight to the provider, so `/parts/N` carries only an ETag and there
// is no plaintext to spool: the door reads the sealed object back through the
// verified custody stream once custody is proven, and hands it to the same
// shared `contributePreview` contributor every streamed door uses.
describe("direct-transfers ingress previews", () => {
  interface PreviewHarness {
    db: VaultDb;
    transfers: DirectBlobTransfers;
    deviceId: string;
    contributed: IngressPreviewInput[];
    settled: () => Promise<void>;
    previewRoot: string;
    sealedSize: number;
  }

  const ONE_PIXEL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );

  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
  });

  function stubCodec(): PreviewCodec {
    return {
      // A real 1x1 PNG stands in for a raster encoder: the derivative
      // validator decodes what it is handed, and this test is about the door,
      // not the pixels.
      downscale: () => ({
        bytes: ONE_PIXEL_PNG,
        mediaType: "image/png",
        width: 1,
        height: 1,
      }),
      perceptualHash: () => "0".repeat(16),
      thumbhash: () => Buffer.from("thumbhash").toString("base64"),
    };
  }

  function openPreviewHarness(plain: Buffer): PreviewHarness {
    const dir = tempDirSync("direct-preview-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const harnessDb = openVaultDb({ dir });
    cleanups.push(() => harnessDb.close());
    const boot = bootstrapVault(harnessDb, { ownerName: "Asha" });
    const keys = new BlobContentKeyRegistry(harnessDb.vault, harnessDb.sealKey);
    const harnessState = new BlobTransferState(harnessDb.vault);
    const sha = sha256OfBytes(plain);
    const sealed = sealBlob(keys.getOrCreate(sha), sha, plain, 1024 * 1024);
    const objects = new Map<string, Buffer>();
    const store = {
      kind: "fake-direct",
      put: async (key: string, bytes: Buffer) =>
        void objects.set(key, Buffer.from(bytes)),
      get: async (key: string, range?: { start: number; end?: number }) => {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return range
          ? Buffer.from(
              bytes.subarray(range.start, (range.end ?? bytes.length - 1) + 1)
            )
          : Buffer.from(bytes);
      },
      has: async (key: string) => objects.has(key),
      delete: async (key: string) => void objects.delete(key),
      list: async () => [...objects.keys()],
      stat: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.length } : null;
      },
    };
    const remote = {
      store,
      transfer: {
        beginTemporaryUpload: async () => "upload-1",
        uploadTemporaryPart: async () => "etag-1",
        completeTemporaryUpload: async () => undefined,
        abortTemporaryUpload: async () => undefined,
        presignTemporaryPut: async () => new URL("https://upload.example/put"),
        presignTemporaryPart: async () => new URL("https://upload.example/p"),
        presignShaGet: async () => new URL("https://upload.example/get"),
        // The provider already holds the edge-sealed object: the client PUT it
        // out of band, exactly as the phone does.
        statTemporary: async () => ({ size: sealed.length }),
        getTemporary: async () => Buffer.from(sealed),
        copyTemporaryToSha: async (_temp: string, target: string) =>
          void objects.set(target, Buffer.from(sealed)),
        deleteTemporary: async () => undefined,
      },
      keyFor: (sha256: string) => keys.getOrCreate(sha256),
      frameSize: 1024 * 1024,
    } as unknown as RemoteTier;
    const contributed: IngressPreviewInput[] = [];
    const pending: Promise<unknown>[] = [];
    const codec = stubCodec();
    const transfers = new DirectBlobTransfers({
      vault: harnessDb.vault,
      cache: { replica: { mark: () => undefined } } as unknown as BlobCache,
      remote: () => remote,
      contentKeys: keys,
      state: harnessState,
      preflight: async () => ({
        exists: false,
        custody: "local-only" as CustodyState,
        remoteAvailable: true,
      }),
      contributePreview: (input) => {
        contributed.push(input);
        pending.push(contributeIngressPreviews(harnessDb, codec, input));
      },
      emit: () => undefined,
    });
    return {
      db: harnessDb,
      transfers,
      deviceId: boot.deviceId,
      contributed,
      settled: async () => {
        await Promise.all(pending);
      },
      previewRoot: path.join(dir, "blob-ingress-previews"),
      sealedSize: sealed.length,
    };
  }

  function stagedVariants(harnessDb: VaultDb, parentSha: string): string[] {
    return (
      harnessDb.vault
        .prepare(
          "SELECT variant FROM blob_staging WHERE variant_of = ? ORDER BY variant"
        )
        .all(parentSha) as { variant: string }[]
    ).map((row) => row.variant);
  }

  test("a completed direct JPEG upload contributes thumb + preview rungs", async () => {
    const plain = validExifJpeg();
    const harness = openPreviewHarness(plain);
    const sha = sha256OfBytes(plain);
    const sealedSize = harness.sealedSize;
    const begun = await harness.transfers.begin({
      sha256: sha,
      plaintextSize: plain.length,
      sealedSize,
      deviceId: harness.deviceId,
      mediaType: "image/jpeg",
      filename: "lena.jpg",
    });
    assert(begun.sessionId);
    const committed = await harness.transfers.complete(
      begun.sessionId,
      harness.deviceId
    );
    expect(committed.sha256).toBe(sha);
    await harness.settled();
    expect(harness.contributed).toHaveLength(1);
    expect(harness.contributed[0]!.mediaType).toBe("image/jpeg");
    expect(harness.contributed[0]!.bytes.equals(plain)).toBe(true);
    expect(stagedVariants(harness.db, sha)).toStrictEqual([
      "phash",
      "preview",
      "thumb",
      "thumbhash",
    ]);
    // No plaintext ever touches disk on this door: there is nothing to spool.
    expect(existsSync(harness.previewRoot)).toBe(false);
  });

  test("a non-image direct upload contributes nothing", async () => {
    const plain = Buffer.from("%PDF-1.7\nnot an image\n");
    const harness = openPreviewHarness(plain);
    const sha = sha256OfBytes(plain);
    const sealedSize = harness.sealedSize;
    const begun = await harness.transfers.begin({
      sha256: sha,
      plaintextSize: plain.length,
      sealedSize,
      deviceId: harness.deviceId,
      mediaType: "application/pdf",
      filename: "notes.pdf",
    });
    assert(begun.sessionId);
    await harness.transfers.complete(begun.sessionId, harness.deviceId);
    await harness.settled();
    expect(harness.contributed).toStrictEqual([]);
    expect(stagedVariants(harness.db, sha)).toStrictEqual([]);
  });

  test("an oversize image original is left to the sweep backstop", async () => {
    // Over INGRESS_PREVIEW_MAX_BYTES: the door declines before it reads a
    // single provider byte.
    const plain = Buffer.alloc(INGRESS_PREVIEW_MAX_BYTES + 1);
    validExifJpeg().copy(plain);
    const harness = openPreviewHarness(plain);
    const sha = sha256OfBytes(plain);
    const sealedSize = harness.sealedSize;
    const begun = await harness.transfers.begin({
      sha256: sha,
      plaintextSize: plain.length,
      sealedSize,
      deviceId: harness.deviceId,
      mediaType: "image/jpeg",
      filename: "huge.jpg",
    });
    assert(begun.sessionId);
    await harness.transfers.complete(begun.sessionId, harness.deviceId);
    await harness.settled();
    expect(harness.contributed).toStrictEqual([]);
    expect(stagedVariants(harness.db, sha)).toStrictEqual([]);
  });

  test("an abandoned direct session leaves no ingress preview temp file", async () => {
    const plain = validExifJpeg();
    const harness = openPreviewHarness(plain);
    const sha = sha256OfBytes(plain);
    const begun = await harness.transfers.begin({
      sha256: sha,
      plaintextSize: plain.length,
      sealedSize: 4096,
      deviceId: harness.deviceId,
      mediaType: "image/jpeg",
      filename: "lena.jpg",
    });
    assert(begun.sessionId);
    expect(harness.contributed).toStrictEqual([]);
    expect(existsSync(harness.previewRoot)).toBe(false);
    const row = harness.db.vault
      .prepare(
        "SELECT temp_path FROM blob_ingress_session WHERE session_id = ?"
      )
      .get(begun.sessionId) as { temp_path: string | null };
    expect(row.temp_path).toBeNull();
  });
});
