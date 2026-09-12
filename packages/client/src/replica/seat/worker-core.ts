// THE SEAT WORKER, MINUS ITS HOST (#996, wave 2).
//
// Everything the worker actually does — open, bootstrap, apply, read, close —
// with the two platform facts injected: how to open a SQLite handle over the
// seat file, and where a downloading artifact is staged. The wasm entry point
// (`seat-worker.ts`) supplies OPFS and sqlite-wasm; the suites supply
// `node:fs` and `node:sqlite`, and run the SAME program the browser runs.
//
// A HOST-NEUTRAL CORE IS NOT A TESTING CONVENIENCE HERE. Three seats run this
// (browser, desktop, phone) against three SQLite builds, and the one thing
// that must not differ between them is the order of statements inside a
// transaction. Writing it once is how that stays true.

import { applySeatLogPage } from "./applier.js";
import type { SeatChangeNotice } from "./applier.js";
import { bootstrapSeatFile } from "./bootstrap.js";
import type {
  SeatBootstrapProgress,
  SeatBootstrapResult,
  SeatBootstrapStaging,
  SeatSnapshotTransport,
} from "./bootstrap.js";
import {
  parseSeatCarryOver,
  readSeatCarryOver,
  seatCarryOverApplied,
  seatCarryOverIsEmpty,
  serializeSeatCarryOver,
  writeSeatCarryOver,
} from "./carry-over.js";
import type { SeatCarryOver, SeatCarryOverSidecar } from "./carry-over.js";
import type { SeatSqliteDriver } from "./driver.js";
import { openSeatFile } from "./driver.js";
import { createSeatOutbox } from "./outbox.js";
import { overlaySeatRows, seatPendingOverlay } from "./read-overlay.js";
import { SeatDriftError } from "./seat-drift-error.js";
import {
  SeatIntentStore,
  seatOverlayClearingHook,
} from "./seat-intent-store.js";
import { SeatWorkerNotOpenError } from "./seat-worker-not-open-error.js";
import { readSeatState, seatStatePresent } from "./state.js";
import type { SeatState } from "./state.js";
import type {
  SeatApplySummary,
  SeatWorkerApplyOptions,
  SeatWorkerBootstrapOptions,
  SeatWorkerOpenOptions,
  SeatWorkerOutboxCall,
  SeatWorkerQuery,
  SeatWorkerRequest,
} from "./worker-protocol.js";

/** What the core needs from whichever platform it is running on. */
export interface SeatWorkerHost {
  /**
   * Open the seat's database file. Called on `open` and again after a
   * bootstrap installs a new one — the old handle points at a file that is no
   * longer there.
   */
  readonly openDatabase: (
    options: SeatWorkerOpenOptions
  ) => SeatSqliteDriver | Promise<SeatSqliteDriver>;
  readonly staging: (
    options: SeatWorkerBootstrapOptions
  ) => SeatBootstrapStaging | Promise<SeatBootstrapStaging>;
  readonly transport: (
    options: SeatWorkerBootstrapOptions
  ) => SeatSnapshotTransport | Promise<SeatSnapshotTransport>;
  /** Unlink the seat's file. Absent where there is no file to unlink. */
  readonly destroyDatabase?: (
    options: SeatWorkerOpenOptions
  ) => void | Promise<void>;
  /**
   * Where this seat's carry-over waits out a re-bootstrap (#1014, C5/T6).
   *
   * Absent in a host with nowhere durable to put it — a suite over `:memory:`
   * has no file to lose and nothing to lose it to. Every host that HAS a file
   * must have one: without it the queue is a heap object across the download,
   * which is the bug this seam exists to close.
   */
  readonly carryOver?: (
    options: SeatWorkerOpenOptions
  ) => SeatCarryOverSidecar | Promise<SeatCarryOverSidecar>;
}

export interface SeatWorkerSink {
  readonly onChange?: (notice: SeatChangeNotice) => void;
  readonly onBootstrapProgress?: (progress: SeatBootstrapProgress) => void;
  /**
   * Intents whose overlay this apply cleared (#996, R24). Told separately from
   * `onChange` because the shell does two different things with them: a
   * changed table is a re-read, and a cleared intent is a pending badge that
   * goes and an outbox the drain loop no longer owes anything for.
   */
  readonly onOverlaysCleared?: (intentIds: readonly string[]) => void;
}

export class SeatWorkerCore {
  #driver: SeatSqliteDriver | undefined;
  #open: SeatWorkerOpenOptions | undefined;
  #outbox: { driver: SeatSqliteDriver; store: SeatIntentStore } | undefined;

  constructor(
    private readonly host: SeatWorkerHost,
    private readonly sink: SeatWorkerSink = {}
  ) {}

  async dispatch(request: SeatWorkerRequest): Promise<unknown> {
    switch (request.op) {
      case "open":
        return this.open(request.payload);
      case "bootstrap":
        return this.bootstrap(request.payload);
      case "state":
        return this.state();
      case "apply":
        return this.apply(request.payload);
      case "query":
        return this.query(request.payload);
      case "outbox":
        return this.outboxCall(request.payload);
      case "purge":
        await this.purge();
        return undefined;
      case "close":
        this.close();
        return undefined;
    }
  }

  /**
   * Open the file this seat already holds, if it holds one.
   *
   * Answers `undefined` rather than throwing when the file is absent or was
   * never bootstrapped: "this seat has no copy yet" is a normal state — it is
   * every seat's first state — and the caller's next move is `bootstrap`,
   * not error handling.
   */
  async open(options: SeatWorkerOpenOptions): Promise<SeatState | undefined> {
    this.close();
    this.#open = options;
    const driver = await this.host.openDatabase(options);
    this.#adopt(driver);
    await this.#replayCarryOver(options, driver);
    return seatStatePresent(driver) ? readSeatState(driver) : undefined;
  }

  /**
   * FINISH A SWAP THAT WAS KILLED PART-WAY (#1014, C5/T6).
   *
   * A sidecar still sitting beside the seat means one of two things: the file
   * under it is the old one (the kill landed before the install) and the rows
   * are already in it, or it is the new one and they are not. Both are the
   * same move — replay, which is `ON CONFLICT DO NOTHING` per intent id — so
   * this does not try to tell them apart. What it DOES tell apart is a stash
   * this file has already taken, by the token stamped in `seat_carry_over`
   * during the write-back: replaying that would resurrect intents the seat has
   * since drained and settled, which is the one way this repair could itself
   * lose the member's work.
   */
  async #replayCarryOver(
    options: SeatWorkerOpenOptions,
    driver: SeatSqliteDriver
  ): Promise<void> {
    const sidecar = await this.host.carryOver?.(options);
    if (!sidecar) return;
    const payload = await sidecar.read();
    if (payload === undefined) return;
    const stash = parseSeatCarryOver(payload, options.vaultId);
    // An unparseable stash, or one belonging to another vault, is DROPPED: it
    // can never be replayed into this file, and leaving it would have every
    // open from here on try again.
    if (!stash) {
      await sidecar.clear();
      return;
    }
    if (!seatCarryOverApplied(driver, stash.token))
      writeSeatCarryOver(driver, stash, stash.token);
    await sidecar.clear();
  }

  async bootstrap(
    options: SeatWorkerBootstrapOptions
  ): Promise<SeatBootstrapResult> {
    const open = this.#open;
    if (!open) throw new SeatWorkerNotOpenError();
    const sidecar = await this.host.carryOver?.(open);
    let released = false;
    let carried: SeatCarryOver | undefined;
    let stashed: string | undefined;
    /**
     * THE LAST MOMENT BEFORE THE DESTINATION IS TOUCHED (#1014, C5/T6).
     *
     * Everything that has to happen while this seat's file is still open, in
     * the order it has to happen in — and it runs when the download is DONE
     * rather than before it starts (`beforeInstall`). The seat therefore keeps
     * answering reads and, above all, keeps its outbox reachable for the whole
     * of a multi-minute download; the window in which `SeatWorkerNotOpenError`
     * is the honest answer is now the install alone.
     *
     * THE CARRY-OVER COMES OUT BEFORE THE SWAP, NOT AFTER (R23). The queued
     * intents, the held blobs and the pins exist nowhere but this file; a
     * window in which a crash loses them is a repair that destroys the
     * member's work, and unlike every row here, none of it can be re-fetched.
     * Read HERE rather than at the top, so an intent the member queued DURING
     * the download travels too.
     *
     * AND IT GOES SOMEWHERE DURABLE BEFORE THE HANDLE IS RELEASED (#1014,
     * C5/T6). Reading it into a local was never the guarantee the member was
     * given: `install()` deletes the old file before it moves the new one in,
     * and a process killed anywhere in there had the queue in nothing but a
     * heap object. The stash is on disk before the file it came out of is
     * closed, and it is removed only after the write-back has committed into
     * the new one.
     */
    const release = async (): Promise<void> => {
      carried = this.#driver ? readSeatCarryOver(this.#driver) : undefined;
      stashed =
        sidecar && carried && !seatCarryOverIsEmpty(carried)
          ? serializeSeatCarryOver(carried, open.vaultId)
          : undefined;
      if (sidecar && stashed !== undefined) await sidecar.write(stashed);
      // A file cannot be replaced underneath an open SQLite connection on any
      // of the three hosts, and the one that tolerates it does so by keeping
      // the deleted inode alive, which is worse — the seat would go on reading
      // the file it just replaced.
      this.#driver?.close();
      this.#driver = undefined;
      released = true;
    };
    try {
      const [staging, transport] = await Promise.all([
        this.host.staging(options),
        this.host.transport(options),
      ]);
      const result = await bootstrapSeatFile({
        transport,
        staging,
        vaultId: options.vaultId,
        open: () => this.host.openDatabase(open),
        ...(options.expansion === undefined
          ? {}
          : { expansion: options.expansion }),
        beforeInstall: release,
        onProgress: (progress) => this.sink.onBootstrapProgress?.(progress),
      });
      const driver = await this.host.openDatabase(open);
      this.#adopt(driver);
      const token = stashed
        ? parseSeatCarryOver(stashed, open.vaultId)?.token
        : undefined;
      if (carried) writeSeatCarryOver(driver, carried, token);
      // ONLY NOW. The stash is the queue's only copy from the close above until
      // this line; dropping it before the write-back commits is the window all
      // of this exists to remove.
      if (sidecar && stashed !== undefined) await sidecar.clear();
      return result;
    } catch (error) {
      // A FAILED BOOTSTRAP MUST NOT COST THE MEMBER THEIR QUEUE'S DOOR
      // (#1014, C5). Once `release` has run there is no `finally` that puts
      // the handle back, so every later call on this worker — `outbox()` most
      // of all, which is where the member's unsent writes live — threw
      // `SeatWorkerNotOpenError` until something re-opened the file. On the
      // phone that is a refused download turning a queued write into an
      // unreachable one, and `NativeReplicaSession.close()` itself throwing.
      //
      // So the file is re-adopted on the way out, and the replay runs: if the
      // install DID land before the failure, the stash goes back into it here
      // rather than waiting for the next open. A failure BEFORE `release` left
      // the handle open and must not be given a second one — `#adopt` replaces
      // the field without closing what was there.
      if (released) await this.#reopen(open).catch(() => undefined);
      throw error;
    }
  }

  /** Put the handle back after a bootstrap that did not finish. */
  async #reopen(options: SeatWorkerOpenOptions): Promise<void> {
    const driver = await this.host.openDatabase(options);
    this.#adopt(driver);
    await this.#replayCarryOver(options, driver);
  }

  /**
   * Take a freshly opened handle: the pragmas, and THE SEAT'S OWN TABLES.
   *
   * The outbox is created here rather than by whoever first writes to it,
   * because a bootstrapped file is a copy of the GATEWAY's and the gateway has
   * never heard of it — and every read now composes the outbox over its answer
   * (`query`), so "the table exists once something has queued" would make the
   * member's first read on a fresh seat throw instead of return nothing.
   */
  #adopt(driver: SeatSqliteDriver): void {
    openSeatFile(driver);
    createSeatOutbox(driver);
    this.#driver = driver;
  }

  /**
   * The outbox over this seat's file — the queue's durable store, in the same
   * handle the applier writes through. That sharing is the whole point (R24):
   * it is what lets an executed answer's overlay clear in the transaction that
   * carries its commit. Re-opened after a bootstrap, because the file it named
   * is not there any more.
   */
  outbox(): SeatIntentStore {
    const driver = this.required();
    if (this.#outbox?.driver !== driver)
      this.#outbox = { driver, store: SeatIntentStore.create(driver) };
    return this.#outbox.store;
  }

  /**
   * One outbox method, by name (#996, R24).
   *
   * The far side of `worker-protocol.ts`'s `outbox` op, and the only reason it
   * exists: the browser's store is behind a `postMessage`, and the queue that
   * drives it runs on the thread that paints. `SeatOutboxMethod` is derived
   * from `IntentRecordStore` itself, so a method that grows on the interface
   * cannot be forgotten here — this dispatches whatever the type admits.
   */
  outboxCall(call: SeatWorkerOutboxCall): Promise<unknown> {
    const store = this.outbox();
    const method = store[call.method] as (
      ...args: unknown[]
    ) => Promise<unknown>;
    return method.apply(store, [...call.args]);
  }

  state(): SeatState | undefined {
    const driver = this.required();
    return seatStatePresent(driver) ? readSeatState(driver) : undefined;
  }

  apply(options: SeatWorkerApplyOptions): SeatApplySummary {
    const driver = this.required();
    const clearing = seatOverlayClearingHook(driver, (intentIds) =>
      this.sink.onOverlaysCleared?.(intentIds)
    );
    const result = applySeatLogPage(driver, options.page, {
      ...(options.deferOverThreshold === undefined
        ? {}
        : { deferOverThreshold: options.deferOverThreshold }),
      onChange: (notice) => this.sink.onChange?.(notice),
      // R24, AND THE REASON THE APPLIER HAS AN IN-TRANSACTION HOOK AT ALL. An
      // executed intent parks on its `commit_seq`; this is what reaches it.
      // Without it the overlay is never cleared by anything — the pending row
      // stays drawn over the very rows that settle it, forever.
      onCommitInTransaction: clearing.inTransaction,
      // The news, once the rows are durable (#1014, C10).
      afterCommit: clearing.afterCommit,
    });
    return result;
  }

  /**
   * The seat's read. `overlay` composes the outbox's pending rows over the
   * answer (`read-overlay.ts`) — without it the member cannot see a write
   * this file has not yet been told about, which is every write between the
   * save and the echo.
   */
  query(request: SeatWorkerQuery): object[] {
    const driver = this.required();
    const rows = driver.all(request.sql, request.bind ?? []);
    if (!request.overlay) return rows;
    return overlaySeatRows(
      rows,
      seatPendingOverlay(driver, request.overlay.entity),
      request.overlay.rowIdColumn
    );
  }

  /**
   * DELETE THIS SEAT'S FILE (#996, R9 and the revocation path).
   *
   * A closed seat still has the vault on disk, and "the member revoked this
   * device" has to mean the copy is gone — not that nothing is reading it. The
   * outbox goes with the file, which is the same fact R24 rests on read from
   * the other end.
   *
   * A host with no `destroyDatabase` (a suite over `:memory:`) closes and is
   * done: there is no file to unlink.
   */
  async purge(): Promise<void> {
    const open = this.#open;
    this.close();
    this.#outbox = undefined;
    if (open) {
      await this.host.destroyDatabase?.(open);
      // THE SIDECAR GOES WITH THE FILE (#1014, C5). It holds the same queued
      // intents the file did; leaving it would have the next bootstrap of this
      // seat replay a purged device's work back onto it.
      await (await this.host.carryOver?.(open))?.clear();
    }
    this.#open = undefined;
  }

  close(): void {
    this.#driver?.close();
    this.#driver = undefined;
  }

  /** Exposed for the shell's own reads; never for a second writer. */
  private required(): SeatSqliteDriver {
    if (!this.#driver) throw new SeatWorkerNotOpenError();
    return this.#driver;
  }
}

/** A drift refusal is the one error the shell must not merely surface. */
export function isSeatRebootstrapRequired(error: unknown): boolean {
  return error instanceof SeatDriftError;
}
