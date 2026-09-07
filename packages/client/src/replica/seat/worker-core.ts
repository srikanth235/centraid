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
import { readSeatCarryOver, writeSeatCarryOver } from "./carry-over.js";
import type { SeatCarryOver } from "./carry-over.js";
import type { SeatSqliteDriver } from "./driver.js";
import { openSeatFile } from "./driver.js";
import { SeatDriftError } from "./seat-drift-error.js";
import { SeatWorkerNotOpenError } from "./seat-worker-not-open-error.js";
import { readSeatState, seatStatePresent } from "./state.js";
import type { SeatState } from "./state.js";
import type {
  SeatApplySummary,
  SeatWorkerApplyOptions,
  SeatWorkerBootstrapOptions,
  SeatWorkerOpenOptions,
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
}

export interface SeatWorkerSink {
  readonly onChange?: (notice: SeatChangeNotice) => void;
  readonly onBootstrapProgress?: (progress: SeatBootstrapProgress) => void;
}

export class SeatWorkerCore {
  #driver: SeatSqliteDriver | undefined;
  #open: SeatWorkerOpenOptions | undefined;

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
    openSeatFile(driver);
    this.#driver = driver;
    return seatStatePresent(driver) ? readSeatState(driver) : undefined;
  }

  async bootstrap(
    options: SeatWorkerBootstrapOptions
  ): Promise<SeatBootstrapResult> {
    const open = this.#open;
    if (!open) throw new SeatWorkerNotOpenError();
    // THE CARRY-OVER COMES OUT BEFORE THE SWAP, NOT AFTER (R23). The queued
    // intents, the held blobs and the pins exist nowhere but this file; a
    // window in which a crash loses them is a repair that destroys the
    // member's work, and unlike every row here, none of it can be re-fetched.
    const carried: SeatCarryOver | undefined = this.#driver
      ? readSeatCarryOver(this.#driver)
      : undefined;
    // The handle is released BEFORE the install: a file cannot be replaced
    // underneath an open SQLite connection on any of the three hosts, and the
    // one that tolerates it does so by keeping the deleted inode alive, which
    // is worse — the seat would go on reading the file it just replaced.
    this.#driver?.close();
    this.#driver = undefined;
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
      onProgress: (progress) => this.sink.onBootstrapProgress?.(progress),
    });
    const driver = await this.host.openDatabase(open);
    openSeatFile(driver);
    if (carried) writeSeatCarryOver(driver, carried);
    this.#driver = driver;
    return result;
  }

  state(): SeatState | undefined {
    const driver = this.required();
    return seatStatePresent(driver) ? readSeatState(driver) : undefined;
  }

  apply(options: SeatWorkerApplyOptions): SeatApplySummary {
    const driver = this.required();
    const result = applySeatLogPage(driver, options.page, {
      ...(options.deferOverThreshold === undefined
        ? {}
        : { deferOverThreshold: options.deferOverThreshold }),
      onChange: (notice) => this.sink.onChange?.(notice),
    });
    return result;
  }

  query(request: SeatWorkerQuery): object[] {
    return this.required().all(request.sql, request.bind ?? []);
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
