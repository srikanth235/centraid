// Direct edge-sealed upload unit tests (issue #545 B6) — mocked remote tier.

import { createHash, randomBytes } from "node:crypto";

import { afterEach, assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb, type VaultDb } from "../db.js";
import { VaultBlobRemoteUnavailableError } from "../errors.js";
import { BlobCache } from "./cache.js";
import { BlobContentKeyRegistry } from "./content-keys.js";
import type { CustodyState, RemoteTier } from "./custody-types.js";
import { DirectBlobTransfers } from "./direct-transfers.js";
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
