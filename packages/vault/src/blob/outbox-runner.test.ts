import { describe, expect, test, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { openVaultDb } from "../db.js";
import { BlobCache } from "./cache.js";
import { MemoryBlobStore } from "./local.js";
import { BlobOutboxRunner } from "./outbox-runner.js";
import { sha256OfBytes } from "./store.js";
import { BlobTransferState } from "./transfer-state.js";

describe("outbox-runner", () => {
  test("custody drain never exceeds the configured replication concurrency", async () => {
    const db = openVaultDb();
    await db.blobTransfers.close();
    const local = new MemoryBlobStore();
    const remote = new MemoryBlobStore();
    const state = new BlobTransferState(db.vault);
    const cache = new BlobCache(db.vault, local, { replicationConcurrency: 2 });
    for (let index = 0; index < 4; index += 1) {
      const bytes = Buffer.from(`concurrent-outbox-${index}`);
      const sha = sha256OfBytes(bytes);
      local.putSync(sha, bytes);
      state.enqueue(sha, bytes.length);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    let ready!: () => void;
    let release!: () => void;
    const firstWaveReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = remote.put.bind(remote);
    remote.put = async (sha, bytes) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 2) ready();
      await gate;
      await put(sha, bytes);
      inFlight -= 1;
    };
    const runner = new BlobOutboxRunner({
      vault: db.vault,
      state,
      local,
      cache,
      remote: () => ({ store: remote }),
      remoteConfigured: () => true,
      onStatus: () => undefined,
      intervalMs: 60_000,
    });

    try {
      const draining = runner.drainDue();
      await firstWaveReady;
      expect(inFlight).toBe(2);
      expect(maxInFlight).toBe(2);
      release();
      await draining;
      expect(maxInFlight).toBe(2);
      expect(state.status().pendingCount).toBe(0);
    } finally {
      release();
      await runner.close();
      db.close();
    }
  });

  test("an unconfigured remote tier performs no fast polling (#456 I1)", async () => {
    const clock = useFakeClock();
    const db = openVaultDb();
    await db.blobTransfers.close();
    const state = new BlobTransferState(db.vault);
    const due = vi.spyOn(state, "dueOutbox");
    const runner = new BlobOutboxRunner({
      vault: db.vault,
      state,
      local: new MemoryBlobStore(),
      cache: new BlobCache(db.vault, new MemoryBlobStore()),
      remote: () => null,
      remoteConfigured: () => false,
      onStatus: () => undefined,
    });
    try {
      await clock.advance(53_000);
      expect(due).not.toHaveBeenCalled();
    } finally {
      await runner.close();
      db.close();
    }
  });

  test("an unconfigured remote still reaps expired local sessions and resources", async () => {
    const clock = useFakeClock();
    const db = openVaultDb();
    await db.blobTransfers.close();
    const state = new BlobTransferState(db.vault);
    state.createSession({
      sessionId: "expired-local",
      kind: "fallback",
      tempPath: "/tmp/centraid-expired-local-does-not-exist",
      expiresAt: new Date(0).toISOString(),
    });
    const expired: string[] = [];
    const local = new MemoryBlobStore();
    const runner = new BlobOutboxRunner({
      vault: db.vault,
      state,
      local,
      cache: new BlobCache(db.vault, local),
      remote: () => null,
      remoteConfigured: () => false,
      onExpireSession: (sessionId) => void expired.push(sessionId),
      onStatus: () => undefined,
    });
    try {
      await clock.advance(70_000);
      expect(expired).toStrictEqual(["expired-local"]);
      expect(state.session("expired-local")).toBeNull();
    } finally {
      await runner.close();
      db.close();
    }
  });

  test("a pressured host defers timer-driven replication but keeps its durable row", async () => {
    const clock = useFakeClock();
    const db = openVaultDb();
    await db.blobTransfers.close();
    const local = new MemoryBlobStore();
    const remote = new MemoryBlobStore();
    const state = new BlobTransferState(db.vault);
    const bytes = Buffer.from("defer-me");
    const sha = sha256OfBytes(bytes);
    local.putSync(sha, bytes);
    state.enqueue(sha, bytes.length);
    const runner = new BlobOutboxRunner({
      vault: db.vault,
      state,
      local,
      cache: new BlobCache(db.vault, local),
      remote: () => ({ store: remote }),
      remoteConfigured: () => true,
      shouldDeferBackgroundWork: () => true,
      onStatus: () => undefined,
      intervalMs: 1,
    });
    try {
      await clock.advance(2);
      expect(state.status().pendingCount).toBe(1);
      await expect(remote.has(sha)).resolves.toBe(false);
    } finally {
      await runner.close();
      db.close();
    }
  });
});
