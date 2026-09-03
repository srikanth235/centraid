import { rmSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import type { PendingUploadGroup } from "../../lib/replica/storage-accounting";
import { NodeSqliteFileDriver } from "../../lib/upload/node-sqlite-driver";
import { PENDING_PAGE_LIMIT, UploadQueueStore } from "../../lib/upload/store";
import type { NewUpload, UploadItem } from "../../lib/upload/store";
import { readTransferQueue } from "./transfer-queue";

type NativeQueueModule = typeof import("../../lib/upload/native-queue");

interface FakeQueue {
  pending: () => UploadItem[];
  pendingStorageGroups: () => PendingUploadGroup[];
  close: () => void;
}

const H = vi.hoisted(() => {
  const state: { queue?: FakeQueue; openError?: Error; closes: number } = {
    closes: 0,
  };
  return state;
});

vi.mock(import("../../lib/upload/native-queue"), () => ({
  UploadQueue: {
    open: () => {
      if (H.openError) throw H.openError;
      return H.queue;
    },
  } as unknown as NativeQueueModule["UploadQueue"],
}));
vi.mock(import("../../lib/gateway"), () => ({ authHeader: () => ({}) }));

let dir: string;
let driver: NodeSqliteFileDriver;
let store: UploadQueueStore;

function upload(index: number, overrides: Partial<NewUpload> = {}): NewUpload {
  return {
    itemId: `item-${index}`,
    sha256: index.toString(16).padStart(64, "0"),
    localUri: `file://cam/IMG-${index}.heic`,
    plaintextSize: 100,
    sealedSize: 227,
    frameCount: 1,
    partCount: 1,
    ...overrides,
  };
}

describe("transfer-queue", () => {
  beforeEach(() => {
    dir = tempDirSync("centraid-transfer-queue-");
    driver = new NodeSqliteFileDriver(path.join(dir, "uploads.db"));
    store = UploadQueueStore.create(driver);
    H.openError = undefined;
    H.closes = 0;
    H.queue = {
      pending: () => store.pending(),
      pendingStorageGroups: () => store.pendingStorageGroups(),
      close: () => {
        H.closes += 1;
      },
    };
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe(readTransferQueue, () => {
    it("counts and sizes the whole queue, not one page of it", () => {
      const deep = PENDING_PAGE_LIMIT + 7;
      for (let index = 0; index < deep; index += 1) {
        store.enqueue(
          upload(index, {
            targetVaultId: index % 2 === 0 ? "vault-personal" : "vault-family",
            ...(index % 5 === 0 ? { mediaType: "video/quicktime" } : {}),
          })
        );
      }
      store.settle("item-0", { casAck: "replicated" });
      store.fail("item-1", "no route to the vault host", true);

      const counts = readTransferQueue("http://gw");

      expect(counts.readable).toBe(true);
      expect(
        counts.pending,
        "the whole backlog, not the page a row read would have stopped at"
      ).toBe(deep - 2);
      expect(
        counts.bytes,
        "bytes come from the same SQL aggregate as the count"
      ).toBe((deep - 2) * 100);
      expect(
        counts.pendingVideos,
        "every fifth row is a video, and item-0 has settled out of the queue"
      ).toBe(Math.ceil(deep / 5) - 1);
      expect(H.closes, "the queue is released once").toBe(1);
    });

    it("still finds an errored row under a page-deep backlog", () => {
      for (let index = 0; index < PENDING_PAGE_LIMIT + 7; index += 1)
        store.enqueue(upload(index, { filename: `IMG-${index}.heic` }));
      store.fail("item-0", "connection reset", false);

      const counts = readTransferQueue("http://gw");

      expect(
        counts.failures,
        "the drainer walks created_order ascending and an attempt leaves a row settled, terminally failed or errored — so errored rows are a prefix of the pending order, inside the page this reads"
      ).toStrictEqual([
        { filename: "IMG-0.heic", lastError: "connection reset" },
      ]);
    });

    it("reports unassigned legacy rows in the same totals", () => {
      store.enqueue(upload(0, { targetVaultId: "vault-personal" }));
      store.enqueue(upload(1, { plaintextSize: 7 }));

      const counts = readTransferQueue("http://gw");

      expect(counts.pending).toBe(2);
      expect(
        counts.bytes,
        "a row targeting no vault is still on this phone"
      ).toBe(107);
    });

    it("surfaces retryable failures with member-facing wording", () => {
      store.enqueue(upload(0, { filename: "IMG-0.heic" }));
      store.enqueue(upload(1));
      store.fail("item-0", "the gateway refused the part", false);

      const counts = readTransferQueue("http://gw");

      expect(counts.failures).toStrictEqual([
        {
          filename: "IMG-0.heic",
          lastError: "the vault host refused the part",
        },
      ]);
      expect(counts.pending, "a retryable failure is still pending work").toBe(
        2
      );
    });

    it("drops terminally failed rows from the failure list", () => {
      store.enqueue(upload(0, { filename: "IMG-0.heic" }));
      store.fail("item-0", "not a paired device", true);

      const counts = readTransferQueue("http://gw");

      expect(
        counts.failures,
        "terminal rows are no longer queued"
      ).toStrictEqual([]);
      expect(counts.pending).toBe(0);
    });

    it("fails closed to UNKNOWN when the queue cannot be opened", () => {
      H.openError = new Error("database is locked");

      expect(readTransferQueue("http://gw")).toStrictEqual({
        pending: 0,
        pendingVideos: 0,
        bytes: 0,
        failures: [],
        readable: false,
      });
      expect(H.closes, "nothing was opened, so nothing is closed").toBe(0);
    });
  });
});
