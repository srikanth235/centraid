import { rmSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  FAKE_GATEWAY,
  FakeGateway,
  FakeProvider,
  Killer,
  fakeBlobStoreFetch,
} from "../../../test/fixtures/fake-direct-transfer";
import { frameCountFor, partCountFor, sealedSizeFor } from "./cbsf";
import { webCryptoUploadCrypto } from "./crypto";
import { bytesFileSource } from "./file-source";
import { DirectTransferError } from "./gateway-client";
import type { DirectTransferClient } from "./gateway-client";
import { NodeSqliteFileDriver } from "./node-sqlite-driver";
import { PENDING_PAGE_LIMIT, UploadQueueStore } from "./store";
import { UploadDrainer } from "./uploader";
import type { PartPutter } from "./uploader";

const crypto = webCryptoUploadCrypto();
const fetchImpl = fakeBlobStoreFetch();
const BYTES = new Uint8Array(2_048).map((_, index) => index & 0xff);
const SHA = "d".repeat(64);

let dir: string;
let driver: NodeSqliteFileDriver;
let store: UploadQueueStore;
let killer: Killer;
let provider: FakeProvider;
let gateway: FakeGateway;

const openFile = async () => bytesFileSource(BYTES);

function enqueue(sha = SHA): void {
  const frameCount = frameCountFor(BYTES.byteLength);
  store.enqueue({
    itemId: `item-${sha.slice(0, 4)}`,
    sha256: sha,
    localUri: "file://a.jpg",
    plaintextSize: BYTES.byteLength,
    sealedSize: sealedSizeFor(BYTES.byteLength, frameCount),
    frameCount,
    partCount: partCountFor(frameCount),
  });
}

function drainer(
  overrides: Partial<{
    putPart: PartPutter;
    client: DirectTransferClient;
    policy: { canTransfer: () => boolean };
  }> = {}
): UploadDrainer {
  return new UploadDrainer({
    store,
    client: overrides.client ?? gateway,
    crypto,
    openFile,
    putPart: overrides.putPart ?? (({ url, body }) => provider.put(url, body)),
    gatewayBaseUrl: FAKE_GATEWAY,
    fetchImpl,
    partConcurrency: 1,
    ...(overrides.policy ? { policy: overrides.policy } : {}),
  });
}

describe("uploader", () => {
  beforeEach(() => {
    dir = tempDirSync("centraid-drain-");
    driver = new NodeSqliteFileDriver(path.join(dir, "uploads.db"));
    store = UploadQueueStore.create(driver);
    killer = new Killer();
    provider = new FakeProvider(killer);
    gateway = new FakeGateway(provider, killer);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe(UploadDrainer, () => {
    it("settles an item and persists the casAck receipt", async () => {
      enqueue();
      const summary = await drainer().drainOnce();
      expect(summary).toMatchObject({ settled: 1, failed: 0, halted: false });
      const item = store.bySha(SHA)!;
      expect(item.state).toBe("settled");
      expect(item.receipt).toMatchObject({
        casAck: "replicated",
        custody: "remote-only",
      });
    });

    describe("the URL gate", () => {
      it("refuses to PUT to a URL the gateway did not mint", async () => {
        enqueue();
        const putPart = vi.fn<PartPutter>(async () => '"etag"');
        const evil: DirectTransferClient = {
          begin: async (input) => ({
            ...(await gateway.begin(input)),
            sessionId: "session-evil",
            upload: {
              kind: "multipart",
              uploadId: "u1",
              parts: [
                {
                  partNumber: 1,
                  url: "https://evil.example.test/centraid-blobs/vault1/tmp/blobs/x?X-Amz-Signature=a&X-Amz-Expires=900",
                },
              ],
            },
          }),
          recordPart: async () => undefined,
          complete: async () => ({}),
        };

        await drainer({ client: evil, putPart }).drainOnce();

        expect(
          putPart,
          "no bytes may leave before the URL is pinned"
        ).toHaveBeenCalledTimes(0);
        expect(store.bySha(SHA)?.lastError).toMatch(/not the active provider/u);
      });

      it.each([
        [
          "off-origin",
          "https://evil.example.test/centraid-blobs/vault1/tmp/blobs/x",
        ],
        [
          "outside the blob scope",
          "https://s3.example.test/centraid-blobs/vault1/other/x",
        ],
        [
          "wrong bucket",
          "https://s3.example.test/other-bucket/vault1/tmp/blobs/x",
        ],
        [
          "unsigned",
          "https://s3.example.test/centraid-blobs/vault1/tmp/blobs/x?X-Amz-Expires=900",
        ],
      ])("rejects a %s URL before any PUT", async (_label, href) => {
        enqueue();
        const putPart = vi.fn<PartPutter>(async () => '"etag"');
        const evil: DirectTransferClient = {
          begin: async (input) => ({
            ...(await gateway.begin(input)),
            sessionId: "session-evil",
            upload: {
              kind: "multipart",
              uploadId: "u1",
              parts: [
                {
                  partNumber: 1,
                  url: `${href}?X-Amz-Signature=a&X-Amz-Expires=900`,
                },
              ],
            },
          }),
          recordPart: async () => undefined,
          complete: async () => ({}),
        };
        await drainer({ client: evil, putPart }).drainOnce();
        expect(putPart).toHaveBeenCalledTimes(0);
      });
    });

    it("transfers nothing when the gateway reports the blob is already present", async () => {
      enqueue();
      await drainer().drainOnce();

      driver.run(
        `UPDATE upload_item SET state = 'pending', receipt_json = NULL WHERE sha256 = ?`,
        [SHA]
      );
      const putPart = vi.fn<PartPutter>(async () => '"etag"');
      const summary = await drainer({ putPart }).drainOnce();

      expect(summary.deduped).toBe(1);
      expect(
        putPart,
        "alreadyPresent must skip the transfer entirely"
      ).toHaveBeenCalledTimes(0);
      expect(store.bySha(SHA)?.receipt).toMatchObject({
        alreadyPresent: true,
        casAck: "replicated",
        custody: "remote-only",
      });
    });

    it("persists an unreplicated settlement verbatim instead of fabricating a casAck", async () => {
      enqueue();
      const localOnly: DirectTransferClient = {
        begin: async (input) => ({
          ...(await gateway.begin(input)),
          alreadyPresent: true,
          custody: "local-only",
          sessionId: undefined,
          upload: undefined,
          settlement: {
            alreadyPresent: true,
            sha256: input.sha256,
            casAck: "receipt",
            custody: "local-only",
            acknowledged: false,
          },
        }),
        recordPart: async () => undefined,
        complete: async () => ({}),
      };
      const putPart = vi.fn<PartPutter>(async () => '"etag"');
      const summary = await drainer({ client: localOnly, putPart }).drainOnce();

      expect(summary.deduped).toBe(1);
      expect(putPart).toHaveBeenCalledTimes(0);
      expect(store.bySha(SHA)?.receipt).toStrictEqual({
        alreadyPresent: true,
        sha256: SHA,
        casAck: "receipt",
        custody: "local-only",
        acknowledged: false,
      });
    });

    it("reconciles gateway-completed parts into the queue and skips re-uploading them", async () => {
      enqueue();
      const item = store.bySha(SHA)!;
      const plan = await gateway.begin({
        sha256: SHA,
        plaintextSize: BYTES.byteLength,
        sealedSize: item.sealedSize,
        partCount: item.partCount,
      });
      const url = (
        plan.upload as { parts: { partNumber: number; url: string }[] }
      ).parts[0]!.url;
      const etag = await provider.put(
        url,
        await sealedPartOne(item.sealedSize)
      );
      await gateway.recordPart(plan.sessionId!, 1, etag);

      const putPart = vi.fn<PartPutter>(async () => '"etag"');
      await drainer({ putPart }).drainOnce();

      expect(
        putPart,
        "a part the gateway already has must not be re-uploaded"
      ).toHaveBeenCalledTimes(0);
      expect(store.parts(item.itemId)[0]?.state).toBe("recorded");
    });

    it("retries a transient failure but gives up on a terminal one", async () => {
      enqueue();
      const flaky: DirectTransferClient = {
        begin: async () => {
          throw new DirectTransferError("gateway is offline", 503);
        },
        recordPart: async () => undefined,
        complete: async () => ({}),
      };
      await drainer({ client: flaky }).drainOnce();
      expect(store.bySha(SHA)?.state, "503 is retryable").toBe("pending");

      const refused: DirectTransferClient = {
        begin: async () => {
          throw new DirectTransferError("not a paired device", 403);
        },
        recordPart: async () => undefined,
        complete: async () => ({}),
      };
      await drainer({ client: refused }).drainOnce();
      expect(store.bySha(SHA)?.state, "403 will not fix itself").toBe("failed");
    });

    it("gives up after MAX_ATTEMPTS transient failures", async () => {
      enqueue();
      const flaky: DirectTransferClient = {
        begin: async () => {
          throw new DirectTransferError("offline", 503);
        },
        recordPart: async () => undefined,
        complete: async () => ({}),
      };
      const drainAttempt = async (attempt: number): Promise<void> => {
        if (attempt >= 5) return;
        await drainer({ client: flaky }).drainOnce();
        return drainAttempt(attempt + 1);
      };
      await drainAttempt(0);
      expect(store.bySha(SHA)?.state).toBe("failed");
    });

    it("drains a queue deeper than one page, one bounded read at a time", async () => {
      const DEPTH = 1_000;
      for (let index = 0; index < DEPTH; index += 1) {
        const sha = index.toString(16).padStart(64, "0");
        const frameCount = frameCountFor(BYTES.byteLength);
        store.enqueue({
          itemId: `item-${index}`,
          sha256: sha,
          localUri: "file://a.jpg",
          plaintextSize: BYTES.byteLength,
          sealedSize: sealedSizeFor(BYTES.byteLength, frameCount),
          frameCount,
          partCount: partCountFor(frameCount),
        });
      }
      const totals: number[] = [];
      const settling: DirectTransferClient = {
        begin: async (input) => ({
          alreadyPresent: true,
          custody: "remote-only",
          keyBase64: "",
          completedParts: [],
          settlement: { alreadyPresent: true, sha256: input.sha256 },
        }),
        recordPart: async () => undefined,
        complete: async () => ({}),
      };
      const pages: number[] = [];
      const pending = store.pending.bind(store);
      store.pending = (limit?: number, afterOrder?: number) => {
        const page = pending(limit, afterOrder);
        pages.push(page.length);
        return page;
      };

      const drain = new UploadDrainer({
        store,
        client: settling,
        crypto,
        openFile,
        putPart: async () => '"etag"',
        gatewayBaseUrl: FAKE_GATEWAY,
        fetchImpl,
        partConcurrency: 1,
        onProgress: (progress) => totals.push(progress.total),
      });
      const summary = await drain.drainOnce();

      expect(summary.settled, "every queued item drains in one pass").toBe(
        DEPTH
      );
      expect(store.pendingCount()).toBe(0);
      expect(
        Math.max(...pages),
        "no read materializes more than one page"
      ).toBeLessThanOrEqual(PENDING_PAGE_LIMIT);
      expect(
        new Set(totals),
        "progress reports the SQL total, not the page size"
      ).toStrictEqual(new Set([DEPTH]));
      expect(
        pages,
        "the queue is walked in pages, not read once in full"
      ).toHaveLength(Math.ceil(DEPTH / PENDING_PAGE_LIMIT) + 1);
    });

    it("halts cleanly when policy denies transfer, leaving the item recoverable", async () => {
      enqueue();
      const putPart = vi.fn<PartPutter>(async () => '"etag"');
      const summary = await drainer({
        putPart,
        policy: { canTransfer: () => false },
      }).drainOnce();
      expect(summary.halted).toBe(true);
      expect(putPart).toHaveBeenCalledTimes(0);
      expect(store.bySha(SHA)?.state).toBe("pending");
    });

    it("refuses a local file that changed under the queue", async () => {
      enqueue();
      driver.run(
        "UPDATE upload_item SET plaintext_size = 999 WHERE sha256 = ?",
        [SHA]
      );
      await drainer().drainOnce();
      expect(store.bySha(SHA)?.state).toBe("failed");
      expect(store.bySha(SHA)?.lastError).toMatch(/expected 999/u);
    });
  });
});

async function sealedPartOne(sealedSize: number): Promise<Uint8Array> {
  const { sealDirectory, sealPart } = await import("./cbsf");
  const key = gateway.keyFor(SHA);
  const frameCount = frameCountFor(BYTES.byteLength);
  const directory = await sealDirectory(
    crypto,
    key,
    SHA,
    BYTES.byteLength,
    frameCount
  );
  const body = await sealPart({
    crypto,
    key,
    sha256: SHA,
    plaintextSize: BYTES.byteLength,
    frameCount,
    partNumber: 1,
    directory,
    read: async (offset, length) => BYTES.subarray(offset, offset + length),
  });
  expect(body.byteLength).toBe(sealedSize);
  return body;
}
