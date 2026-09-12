// The custody outbox's END OF RETRY (#1014, B12) and the admission door's
// answer to an unreachable provider (#1014, B13). A row that can never upload
// used to retry once a minute for the life of the host, hold its cache pin,
// and report itself as backlog about to clear; and a provider that stopped
// answering used to stop the member's own ingest with an outbox-budget
// refusal that named the wrong wall.

import { describe, expect, test } from "vitest";

import { readBackupPolicy } from "../backup-policy.js";
import { openVaultDb } from "../db.js";
import { BlobCache } from "./cache.js";
import { pendingOutboxShas } from "./evict.js";
import { assertSpoolAdmission } from "./ingress-admission.js";
import { MemoryBlobStore } from "./local.js";
import { BlobOutboxRunner, OUTBOX_MAX_ATTEMPTS } from "./outbox-runner.js";
import { sha256OfBytes } from "./store.js";
import { BlobTransferState } from "./transfer-state.js";

async function refusingRunner(db: ReturnType<typeof openVaultDb>) {
  await db.blobTransfers.close();
  const local = new MemoryBlobStore();
  const remote = new MemoryBlobStore();
  remote.put = async () => {
    throw new Error("provider refused these bytes");
  };
  const state = new BlobTransferState(db.vault);
  const cache = new BlobCache(db.vault, local);
  const bytes = Buffer.from("a blob custody will never take");
  const sha = sha256OfBytes(bytes);
  local.putSync(sha, bytes);
  state.enqueue(sha, bytes.length);
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
  return { runner, state, sha };
}

describe("custody outbox quarantine", () => {
  test("a row that spends its attempts is quarantined, unpinned and uncounted", async () => {
    const db = openVaultDb();
    const { runner, state, sha } = await refusingRunner(db);
    try {
      // Retry windows are not the subject here; clear them and drain again.
      // Sequential by nature, so recursion rather than a loop with an await.
      const drainAgain = async (left: number): Promise<void> => {
        if (left === 0) return;
        db.vault.exec("UPDATE blob_outbox SET next_retry_at = NULL");
        await runner.drainDue();
        return drainAgain(left - 1);
      };
      await drainAgain(OUTBOX_MAX_ATTEMPTS);

      expect(state.quarantinedShas()).toStrictEqual([sha]);
      expect(state.dueOutbox()).toStrictEqual([]);
      const status = state.status();
      expect(status.pendingCount).toBe(0);
      expect(status.quarantinedCount).toBe(1);
      expect(status.lastError).toContain("provider refused");
      // The pin goes with the pending-ness that bought it.
      expect(pendingOutboxShas(db.vault).has(sha)).toBe(false);

      state.releaseOutboxQuarantine(sha);
      expect(state.dueOutbox().map((row) => row.sha256)).toStrictEqual([sha]);
      expect(state.status().pendingCount).toBe(1);
    } finally {
      await runner.close();
    }
  });
});

describe("ingress admission while custody is unreachable", () => {
  test("a stalled provider widens the logical ceiling instead of stopping ingest", () => {
    const db = openVaultDb();
    const state = new BlobTransferState(db.vault);
    const local = new MemoryBlobStore();
    const cache = new BlobCache(db.vault, local);
    const bytes = Buffer.from("already waiting on custody");
    const sha = sha256OfBytes(bytes);
    state.enqueue(sha, 900);
    const deps = {
      cache,
      state,
      policy: () => ({
        ...readBackupPolicy(db.vault),
        outboxBudgetBytes: 1_000,
      }),
      remoteConfigured: () => true,
    };

    // Healthy backlog: the budget is the budget.
    expect(state.custodyStalled()).toBe(false);
    expect(() => assertSpoolAdmission(deps, 500, true)).toThrow(
      /outbox budget/u
    );

    // The same backlog, failing: ingest continues into the widened ceiling.
    db.vault.exec("UPDATE blob_outbox SET attempt_count = 5");
    expect(state.custodyStalled()).toBe(true);
    expect(() => assertSpoolAdmission(deps, 500, true)).not.toThrow();
    expect(() => assertSpoolAdmission(deps, 5_000, true)).toThrow(
      /custody is unreachable/u
    );
  });
});
