/*
 * ONE DURABLE COMMIT PER TOOL BATCH (#922 B.1, root ruling 2026-09-05).
 *
 * A gateway read is a writer: it appends an `access.receipt`, and SQLite
 * commits each one on its own, so an automation whose model turn issues five
 * reads pays five fsyncs and five copies of the same b-tree leaf pages.
 * `Gateway.readBatch` already puts a contiguous run of reads in one commit —
 * the question B.1 left open was what "contiguous" may mean for an automation.
 *
 * The two answers this file REFUSES, and why:
 *
 *   - Wrapping the whole fire holds `BEGIN IMMEDIATE` — the vault's write lock
 *     — across model turns and network I/O. Every other writer on the same
 *     handle (the group-commit queue, the sweep, the replica apply) then
 *     throws "cannot start a transaction within a transaction". That is a
 *     fault, not a slowdown.
 *   - Buffering the receipts and flushing at the end defers the audit band
 *     past a crash window, which is exactly what makes a refusal's receipt
 *     trustworthy.
 *
 * So the window is ONE TURN OF THE EVENT LOOP, and it is closed by
 * `setImmediate` rather than by anything the handler says. Every read a tool
 * batch issues together lands in one commit; the transaction opens and closes
 * inside a single synchronous drain, so no await is ever inside it and no
 * model turn can be; and every receipt is committed BEFORE its own reply is
 * settled, so a crash after a reply cannot lose the evidence for it. A read
 * that arrives alone still commits alone — the batch is an optimisation, never
 * a delay the caller can observe as a missing receipt.
 */

import type { VaultCallResult } from "../engine/handlers/vault-bridge.js";

/** A gateway read already reduced to its result; `asVaultCallResult` catches. */
export type SyncVaultRead = () => VaultCallResult;

export interface ReadBatchHost {
  readBatch: <T>(body: () => T) => T;
}

interface Pending {
  readonly run: SyncVaultRead;
  readonly settle: (result: VaultCallResult) => void;
}

function asError(error: unknown): VaultCallResult {
  return {
    ok: false,
    code: "VAULT_ERROR",
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The coalescer belongs to the HANDLE, not to a bridge: `readBatch` refuses to
 * nest, and every bridge this plane hands out shares one `vault.db`.
 */
export function createReadCoalescer(
  host: ReadBatchHost
): (run: SyncVaultRead) => Promise<VaultCallResult> {
  let pending: Pending[] = [];

  function drain(): void {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    if (batch.length === 1) {
      // One read is its own commit. Opening a transaction around it would buy
      // nothing and would take the write lock for no reason.
      batch[0]!.settle(batch[0]!.run());
      return;
    }
    let results: VaultCallResult[];
    try {
      results = host.readBatch(() => batch.map((call) => call.run()));
    } catch (error) {
      // `readBatch` throws before running anything when it cannot open (a
      // nested batch), and its COMMIT runs in a `finally`. Either way no
      // caller may be told a read succeeded whose receipt is not durable.
      for (const call of batch) call.settle(asError(error));
      return;
    }
    for (const [index, call] of batch.entries())
      call.settle(results[index] ?? asError(new Error("batch lost a result")));
  }

  return (run) =>
    new Promise<VaultCallResult>((resolve) => {
      // The FIRST arrival of a window schedules its close. `setImmediate`, not
      // `queueMicrotask`: the worker's vault calls arrive as separate message
      // events in the same poll phase, and a microtask boundary falls between
      // two of them while the check phase does not.
      if (pending.length === 0) setImmediate(drain);
      pending.push({ run, settle: resolve });
    });
}
