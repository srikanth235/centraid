// The readout every backup screen quotes, over the real store on node:sqlite
// so the aggregates under test are SQL's own answers.

import { rmSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import type { PendingUploadGroup } from "../../lib/replica/storage-accounting";
import { NodeSqliteFileDriver } from "../../lib/upload/node-sqlite-driver";
import { PENDING_PAGE_LIMIT, UploadQueueStore } from "../../lib/upload/store";
import type { NewUpload, UploadItem } from "../../lib/upload/store";
import { readTransferQueue, retryTransfer } from "./transfer-queue";

type NativeQueueModule = typeof import("../../lib/upload/native-queue");

interface FakeQueue {
  pending: () => UploadItem[];
  retrying: () => UploadItem[];
  failed: () => UploadItem[];
  poisonedFollowupCount: () => number;
  pendingStorageGroups: () => PendingUploadGroup[];
  retry: (itemId: string) => void;
  close: () => void;
}

// Hoisted so the (hoisted) `vi.mock` factory closes over it without a
// temporal-dead-zone reference.
const H = vi.hoisted(() => {
  const state: { queue?: FakeQueue; openError?: Error; closes: number } = {
    closes: 0,
  };
  return state;
});

vi.mock(import("../../lib/upload/native-queue"), () => ({
  // `UploadQueue` is nominally typed (private constructor), so no structural
  // stand-in is assignable; only `open()` is called, so assert that surface.
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
    // `close` counts rather than closes: `readTransferQueue` releases the
    // queue in a `finally`, and the assertions still need the store.
    H.queue = {
      pending: () => store.pending(),
      retrying: () => store.retrying(),
      failed: () => store.failed(),
      poisonedFollowupCount: () => store.poisonedFollowupCount(),
      pendingStorageGroups: () => store.pendingStorageGroups(),
      retry: (itemId: string) => store.retry(itemId),
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
        {
          itemId: "item-0",
          filename: "IMG-0.heic",
          lastError: "connection reset",
          terminal: false,
        },
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

    it("hands on a retryable failure's sentence untouched", () => {
      store.enqueue(upload(0, { filename: "IMG-0.heic" }));
      store.enqueue(upload(1));
      // The row is already member copy: the drainer built it from what
      // failed (`transfer-failure.ts`), and this readout is a readout
      // (#1015 R-NY-10).
      store.fail("item-0", "Your vault could not be reached", false);

      const counts = readTransferQueue("http://gw");

      expect(counts.failures).toStrictEqual([
        {
          itemId: "item-0",
          filename: "IMG-0.heic",
          lastError: "Your vault could not be reached",
          terminal: false,
        },
      ]);
      expect(counts.pending, "a retryable failure is still pending work").toBe(
        2
      );
    });

    // #1014 P7. A row that gave up left the pending set, and this list read
    // only the pending set — so the one failure a member must act on was in
    // no list at all, and there was nothing to act on it with.
    it("lists terminally failed rows first, and offers them a retry", () => {
      store.enqueue(upload(0, { filename: "IMG-0.heic" }));
      store.enqueue(upload(1, { filename: "IMG-1.heic" }));
      store.fail("item-0", "not a paired device", true);
      store.fail("item-1", "connection reset", false);

      const counts = readTransferQueue("http://gw");

      expect(counts.failures).toStrictEqual([
        {
          itemId: "item-0",
          filename: "IMG-0.heic",
          lastError: "not a paired device",
          terminal: true,
        },
        {
          itemId: "item-1",
          filename: "IMG-1.heic",
          lastError: "connection reset",
          terminal: false,
        },
      ]);
      expect(counts.pending, "a terminal row is no longer pending work").toBe(
        1
      );

      retryTransfer("http://gw", "item-0");

      expect(readTransferQueue("http://gw").failures).toStrictEqual([
        {
          itemId: "item-1",
          filename: "IMG-1.heic",
          lastError: "connection reset",
          terminal: false,
        },
      ]);
      expect(store.get("item-0")?.state).toBe("pending");
    });

    // A row inside its backoff window is hidden from the DRAIN by design;
    // hiding it here too would make a refusal vanish from Backup health.
    it("still reports a failure that is waiting out its backoff", () => {
      store.enqueue(upload(0, { filename: "IMG-0.heic" }));
      store.fail("item-0", "connection reset", false);
      store.deferUntil("item-0", "2099-01-01T00:00:00.000Z");

      expect(readTransferQueue("http://gw").failures).toHaveLength(1);
    });

    // The bytes are durable and the canonical write is quarantined: the vault
    // holds content it has no row for, and nothing read this count (P7).
    it("reports quarantined follow-ups", () => {
      const item = store.enqueue(upload(0));
      store.enqueueFollowup({
        itemId: item.itemId,
        shape: "photos",
        action: "upload",
        input: { staged_sha: item.sha256 },
      });
      store.settle(item.itemId, { casAck: "replicated" });
      store.poisonFollowup(
        store.pendingFollowups()[0]!.followupId,
        "the vault refused it five times"
      );

      expect(readTransferQueue("http://gw").poisonedFollowups).toBe(1);
    });

    it("fails closed to UNKNOWN when the queue cannot be opened", () => {
      H.openError = new Error("database is locked");

      expect(readTransferQueue("http://gw")).toStrictEqual({
        pending: 0,
        pendingVideos: 0,
        bytes: 0,
        failures: [],
        poisonedFollowups: 0,
        readable: false,
      });
      expect(H.closes, "nothing was opened, so nothing is closed").toBe(0);
    });
  });
});
