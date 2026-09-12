// Per-vault dedupe, the failure surface, backoff windows and retention — the
// queue behaviour #1014 added, kept out of `store.test.ts` so both files stay
// under the governance line cap.
import { rmSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { NodeSqliteFileDriver } from "./node-sqlite-driver";
import { UploadQueueStore } from "./store";
import type { NewUpload } from "./store";

let dir: string;
let driver: NodeSqliteFileDriver;
let store: UploadQueueStore;

function upload(overrides: Partial<NewUpload> = {}): NewUpload {
  return {
    itemId: "item-1",
    sha256: "a".repeat(64),
    localUri: "file://a.jpg",
    plaintextSize: 100,
    sealedSize: 227,
    frameCount: 1,
    partCount: 1,
    ...overrides,
  };
}

describe("the upload queue's vault scope and retention", () => {
  beforeEach(() => {
    dir = tempDirSync("centraid-queue-scope-");
    driver = new NodeSqliteFileDriver(path.join(dir, "uploads.db"));
    store = UploadQueueStore.create(driver);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // #1014 P3. The queue's key was the content sha ALONE, so a phone holding
  // two vaults queued one photograph for both and the second enqueue was
  // handed the FIRST row: one upload, one vault, and the other vault never
  // got the picture.
  it("queues the same bytes once per target vault", () => {
    const family = store.enqueue(
      upload({ itemId: "item-family", targetVaultId: "vault-family" })
    );
    const personal = store.enqueue(
      upload({ itemId: "item-personal", targetVaultId: "vault-personal" })
    );

    expect(personal.itemId).not.toBe(family.itemId);
    expect(store.bySha(family.sha256, "vault-family")?.itemId).toBe(
      "item-family"
    );
    expect(store.bySha(family.sha256, "vault-personal")?.itemId).toBe(
      "item-personal"
    );
    expect(
      store.bySha(family.sha256),
      "no unassigned row exists for these bytes"
    ).toBeUndefined();
    expect(store.pendingCount()).toBe(2);
  });

  it("is still idempotent within one vault", () => {
    const first = store.enqueue(
      upload({ itemId: "item-a", targetVaultId: "vault-family" })
    );
    const again = store.enqueue(
      upload({ itemId: "item-b", targetVaultId: "vault-family" })
    );
    expect(again.itemId).toBe(first.itemId);
    expect(store.pendingCount()).toBe(1);
  });

  // #1014 P7: a terminally failed row is the only place its reason is
  // written down, and nothing surfaced it or offered a retry.
  it("lists failed rows until they are dismissed, and retries one", () => {
    const item = store.enqueue(upload({ targetVaultId: "vault-family" }));
    store.fail(item.itemId, "gateway refused", true);

    expect(store.failedCount()).toBe(1);
    expect(store.failed()[0]?.lastError).toBe("gateway refused");

    store.retry(item.itemId);
    expect(store.failedCount()).toBe(0);
    expect(store.get(item.itemId)?.state).toBe("pending");
    expect(store.get(item.itemId)?.attempts).toBe(0);

    store.fail(item.itemId, "gateway refused again", true);
    store.dismissFailed(item.itemId);
    expect(store.failedCount(), "dismissed rows stop being offered").toBe(0);
    expect(store.get(item.itemId)?.state).toBe("failed");
  });

  // #1014: a retryable failure is deferred, not re-tried microseconds later.
  it("hides a deferred row from the drain until its window opens", () => {
    const item = store.enqueue(upload());
    store.fail(item.itemId, "gateway is offline", false);
    store.deferUntil(item.itemId, "2026-01-01T00:05:00.000Z");

    expect(store.pending(500, 0, "2026-01-01T00:00:00.000Z")).toStrictEqual([]);
    expect(
      store.pending(500, 0, "2026-01-01T00:06:00.000Z").map((r) => r.itemId)
    ).toStrictEqual([item.itemId]);
    expect(
      store.pendingCount(),
      "a deferred row is still pending work, and is still counted"
    ).toBe(1);
  });

  // #1014 P25: rows were never deleted, so Photos' timeline engine
  // materialized the whole roll's upload history on every refresh.
  it("prunes terminal rows nothing waits on, keeping the newest", () => {
    const settled = store.enqueue(
      upload({ itemId: "old", targetVaultId: "v1" })
    );
    store.settle(settled.itemId, { casAck: "replicated" });
    const held = store.enqueue(
      upload({ itemId: "held", sha256: "b".repeat(64), targetVaultId: "v1" })
    );
    store.enqueueFollowup({
      itemId: held.itemId,
      shape: "photos",
      action: "upload",
      input: { staged_sha: held.sha256 },
    });
    store.settle(held.itemId, { casAck: "replicated" });

    const dropped = store.sweepTerminal({
      olderThanMs: 0,
      keep: 0,
      now: Date.now() + 1_000,
    });

    expect(dropped).toBe(1);
    expect(store.get("old")).toBeUndefined();
    expect(
      store.get("held"),
      "a row whose canonical write has not landed is not history yet"
    ).toBeDefined();
    expect(store.pendingFollowups()).toHaveLength(1);
  });

  it("keeps the newest terminal rows however old they are", () => {
    const item = store.enqueue(upload());
    store.settle(item.itemId, { casAck: "replicated" });
    expect(
      store.sweepTerminal({ olderThanMs: 0, keep: 10, now: Date.now() + 1 })
    ).toBe(0);
    expect(store.recent()).toHaveLength(1);
  });
});
