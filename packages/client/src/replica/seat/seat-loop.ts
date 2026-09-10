// THE SEAT LOOP, MINUS ITS HOST (#996, waves 2 and 4b).
//
// Bootstrap if there is no file, then tail the log door until the seat's
// cursor meets the gateway's head. Every seat does exactly this — the browser
// over a Worker, the phone in its own process over expo-sqlite — and the loop
// is the part that must not differ between them, because its exit conditions
// are the seat's whole correctness story:
//
//   - `hasMore` false means caught up. The watermark the page carries is the
//     gateway's head, so "caught up" is a fact, not an inference from an empty
//     page.
//   - A 409 `seat_rebootstrap_required` is the gateway saying the seat's
//     cursor is below the retention floor or from another epoch. The answer is
//     to bootstrap again — which is cheap, because a bootstrap is a file copy.
//   - A `SeatDriftError` from the APPLIER is the same conclusion reached from
//     the other side: the gateway shipped a row this file cannot take. Same
//     recovery, and it is bounded — one re-bootstrap per sync, never a loop
//     that re-downloads a 9 MB artifact until the tab is closed.
//
// AND IT NEVER THROWS AT THE SHELL FOR BEING OFFLINE. A seat that cannot
// reach the gateway is a seat with a slightly older copy, which is the normal
// state of the thing and not an error to render.
//
// WHAT IS INJECTED IS THE CHANNEL, NOT THE STORE. `SeatChannel` is the five
// calls `SeatWorkerCore` answers; the browser's implementation posts them to a
// worker and the phone's calls the core in process. Neither host gets to have
// its own opinion about the order they are made in.

import { ROUTES } from "@centraid/core/protocol";
import type { SeatLogPageWire } from "@centraid/core/protocol";

import { OnlineOnlyError } from "../errors.js";
import type { IntentRecordStore } from "../intent-record-store.js";
import { ReplicaProtocolError } from "../replica-protocol-error.js";
import type { SeatBootstrapResult } from "./bootstrap.js";
import type { SeatChannel } from "./seat-channel.js";
import { SeatDriftError } from "./seat-drift-error.js";
import {
  MAX_CONSECUTIVE_DRIFT_REBOOTSTRAPS,
  SeatDriftParkedError,
} from "./seat-drift-parked-error.js";
import { SeatRebootstrapRequiredError } from "./seat-rebootstrap-required-error.js";
import type { SeatState } from "./state.js";
import { seatWatermark } from "./watermark.js";
import type { SeatWatermark } from "./watermark.js";
import type { SeatApplySummary, SeatWorkerQuery } from "./worker-protocol.js";

/** How many log rows to ask for at a time. The door's ceiling is 10,000. */
const PAGE = 1_000;
/** A catch-up is bounded; a seat that is further behind asks again. */
const MAX_PAGES_PER_SYNC = 200;

export interface SeatLoopOptions {
  readonly vaultId: string;
  /** Absolute and vault-namespaced, the same rule the old worker enforces. */
  readonly dbName: string;
  /** The "Keep an offline copy" switch (R9). */
  readonly remember: boolean;
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  /** Metered: skip a commit that crossed the byte threshold (R7). */
  readonly deferOverThreshold?: boolean;
  /**
   * Every bootstrap this loop completes, handed to whoever can say it out
   * loud (#1014, C16).
   *
   * `vaultChecked` on the result is the reason this exists: a bootstrap that
   * verified neither the door's vault header nor the file's own identity row
   * is a bootstrap nothing checked, and the only honest place for that
   * sentence is the host's log — `packages/client` writes to no console.
   */
  readonly onBootstrapped?: (result: SeatBootstrapResult) => void;
}

export class SeatLoop {
  #state: SeatState | undefined;
  /**
   * Drift re-bootstraps since the last page that applied (#1014, C14).
   *
   * The loop bounds re-bootstraps to one per sync; nothing bounded the syncs,
   * and the host's retry timer re-enters `sync()` forever. Counted across
   * syncs and reset by the first page that lands, so a drift the gateway
   * resolves costs one download and a drift it cannot costs three.
   */
  #driftRebootstraps = 0;
  /*
   * THE BASE IS NOT A CONSTANT ON EVERY HOST (#996 follow-up).
   *
   * A browser seat's gateway origin is the page's own, fixed for the life of
   * the tab. A phone's is not: the seat is opened from disk BEFORE the network
   * — the outbox has to be durable for a write made offline — and the real
   * base only exists once the loopback tunnel over iroh comes up, on a port
   * chosen per launch. Held as a readonly option, the seat asked a dead
   * address for the snapshot and every log page, forever: bootstrap never
   * landed, the file stayed empty, and Home rendered a correct empty replica
   * over a vault full of rows.
   *
   * So the base is state, not configuration, and `updateGatewayBase` is the
   * seat's half of the rebase the change feed and the session already got.
   */
  #baseUrl: string;

  constructor(
    private readonly channel: SeatChannel,
    private readonly options: SeatLoopOptions
  ) {
    this.#baseUrl = options.baseUrl;
  }

  /** Point the snapshot and log doors at a new gateway base (see `#baseUrl`). */
  updateGatewayBase(baseUrl: string): void {
    this.#baseUrl = baseUrl;
  }

  /** Open the file this seat already holds, if it holds one. */
  async open(): Promise<void> {
    this.#state = await this.channel.open({
      vaultId: this.options.vaultId,
      dbName: this.options.dbName,
      remember: this.options.remember,
    });
  }

  /** What the shell shows, or `undefined` before the first file lands. */
  watermark(): SeatWatermark | undefined {
    return this.#state ? seatWatermark(this.#state) : undefined;
  }

  /**
   * Get the file if there is none, then tail until caught up.
   *
   * Returns the watermark it ended at. Safe to call repeatedly and safe to
   * call offline.
   */
  /* oxlint-disable no-await-in-loop -- a tail is sequential by definition: the next page's cursor is the previous page's answer */
  async sync(): Promise<SeatWatermark | undefined> {
    if (!this.#state) await this.bootstrap();
    let rebootstrapped = false;
    for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
      const state = this.#state;
      if (!state) return undefined;
      let answer: SeatLogPageWire;
      try {
        answer = await this.fetchPage(state.appliedSeq);
      } catch (error) {
        if (error instanceof SeatRebootstrapRequiredError && !rebootstrapped) {
          rebootstrapped = true;
          await this.bootstrap();
          continue;
        }
        throw error;
      }
      let summary: SeatApplySummary;
      try {
        summary = await this.channel.apply({
          page: answer,
          ...(this.options.deferOverThreshold === undefined
            ? {}
            : { deferOverThreshold: this.options.deferOverThreshold }),
        });
      } catch (error) {
        if (error instanceof SeatDriftError) {
          this.#driftRebootstraps += 1;
          // THE THIRD ONE PARKS (#1014, C14). Two re-bootstraps that did not
          // resolve the drift are a gateway and a seat that disagree about
          // something a third download will not change — and the host's retry
          // timer, which is what actually re-enters this loop, has no bound of
          // its own. Counted across syncs, because that is where the loop was.
          if (this.#driftRebootstraps >= MAX_CONSECUTIVE_DRIFT_REBOOTSTRAPS) {
            throw new SeatDriftParkedError(error, this.#driftRebootstraps);
          }
          if (!rebootstrapped) {
            rebootstrapped = true;
            await this.bootstrap();
            continue;
          }
        }
        throw error;
      }
      // A page that applied is the drift resolved: the count starts over.
      this.#driftRebootstraps = 0;
      this.#state = await this.channel.state();
      // A DEFERRED SPAN ENDS THE PASS (#1014, C1). The applier stops at the
      // owed commit and leaves the cursor before it, so the next page this
      // loop asked for would be the SAME page — and `hasMore` would keep it
      // asking. The span is owed until the seat is somewhere it will spend the
      // bytes; nothing this pass does changes that.
      if (summary.deferred > 0) break;
      if (!answer.hasMore) break;
    }
    return this.watermark();
  }
  /* oxlint-enable no-await-in-loop */

  /**
   * One read against this seat's file (#996 wave 4).
   *
   * Forwarded whole — the request object carries the overlay a list read needs
   * to show a member their own unsettled write (R23–R25), and a signature that
   * can drop it is one that will.
   */
  query<T extends object>(request: SeatWorkerQuery): Promise<T[]> {
    // ABSENT IS NEVER EMPTY (docs/mobile-offline.md). A seat with no copy has
    // the vault's DDL in its file — the baseline states it — so every table it
    // will ever hold is there and every read of one answers ZERO ROWS. That is
    // the worst answer available: a member is shown an empty library over a
    // vault full of rows and has no way to tell. So a seat that has not
    // bootstrapped REFUSES, with the code the inline runner already falls back
    // to the gateway on. The shell checks this on its own door too; it is here
    // as well because the phone's door is a different one.
    // REJECTED, never thrown: `query` is not `async`, and a synchronous throw
    // lands past the caller's `await` — the same trap the channel exists to
    // close for the core (see `in-process-channel.ts`).
    if (!this.#state)
      return Promise.reject(
        new OnlineOnlyError("this seat holds no copy of the vault")
      );
    return this.channel.query<T>(request);
  }

  /** The outbox in this seat's file — the queue's durable store (R24). */
  outbox(): IntentRecordStore {
    return this.channel.outbox();
  }

  /** Delete the file this seat holds. Terminal; the loop is done after it. */
  async purge(): Promise<void> {
    await this.channel.purge();
    this.#state = undefined;
  }

  close(): Promise<void> {
    return this.channel.close();
  }

  private async bootstrap(): Promise<void> {
    const result = await this.channel
      .bootstrap({
        vaultId: this.options.vaultId,
        snapshotUrl: this.url(ROUTES.vaultSeatSnapshot),
        ...(this.options.headers ? { headers: this.options.headers } : {}),
      })
      .catch((error: unknown) => {
        // A MIS-ADDRESSED DOOR PARKS AT ONCE (#1014, C16 + C14). Drift in a
        // PAGE is worth a re-bootstrap; an ARTIFACT for another vault is the
        // door itself answering wrongly, and it will answer the same way in
        // six seconds. That loop is R25: 135 KB a pass, 560 lines of gateway
        // log, and a battery drain with no user-visible cause.
        if (error instanceof SeatDriftError && error.reason === "wrong-vault")
          throw new SeatDriftParkedError(error, 1);
        throw error;
      });
    this.options.onBootstrapped?.(result);
    this.#state = await this.channel.state();
  }

  private url(path: string, search?: Record<string, string>): string {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(search ?? {}))
      url.searchParams.set(key, value);
    return url.toString();
  }

  private async fetchPage(since: number): Promise<SeatLogPageWire> {
    const call = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await call(
      this.url(ROUTES.vaultSeatLog, {
        since: String(since),
        limit: String(PAGE),
      }),
      { headers: { ...this.options.headers, Accept: "application/json" } }
    );
    const body = (await response.json()) as Record<string, unknown>;
    if (
      response.status === 409 &&
      body["error"] === "seat_rebootstrap_required"
    )
      throw new SeatRebootstrapRequiredError(
        String(body["reason"] ?? "unknown")
      );
    if (!response.ok) {
      throw new Error(
        `seat log door answered ${response.status}: ${String(body["error"] ?? "")}`
      );
    }
    return parseSeatLogPage(body);
  }
}

function integerAtLeast(value: unknown, floor: number): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= floor
  );
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

/**
 * THE PAGE IS CHECKED BEFORE IT IS APPLIED (#1014, C15).
 *
 * This was `body as unknown as SeatLogPageWire` — a cast, on JSON off the
 * wire, straight into `applySeatLogPage`, which writes it into the member's
 * file inside a transaction that also moves the cursor. The shaped route has
 * done better since it shipped (`parseOutcome`, `shell-transport.ts`), and
 * this door carries strictly more: a missing `rows`, a `watermark` that is a
 * string, a negative `seq` all reached the applier, where the best outcome is
 * a throw halfway through a page and the worst is a cursor moved over rows
 * that were not there.
 *
 * DELIBERATELY NOT A DEEP DECODER. It checks the fields the applier and the
 * cursor arithmetic depend on being what they claim; the row images
 * themselves are values the vault's own schema constrains on the way in.
 */
export function parseSeatLogPage(body: unknown): SeatLogPageWire {
  const refuse = (why: string): never => {
    throw new ReplicaProtocolError(`seat log page: ${why}`);
  };
  if (!body || typeof body !== "object") return refuse("is not an object");
  const page = body as Record<string, unknown>;
  if (!nonEmptyString(page["vaultId"])) return refuse("names no vault");
  if (!nonEmptyString(page["epoch"])) return refuse("names no epoch");
  for (const field of ["schemaEpoch", "ddlVersion"] as const) {
    if (!integerAtLeast(page[field], 0))
      return refuse(`${field} is not an integer`);
  }
  for (const field of ["floor", "watermark", "next"] as const) {
    if (!integerAtLeast(page[field], 0)) {
      return refuse(`${field} is not a position (got ${String(page[field])})`);
    }
  }
  if (typeof page["hasMore"] !== "boolean")
    return refuse("hasMore is not a boolean");
  const rows = page["rows"];
  if (!Array.isArray(rows)) return refuse("carries no rows array");
  for (const value of rows) {
    if (!value || typeof value !== "object")
      return refuse("has a row that is not an object");
    const row = value as Record<string, unknown>;
    if (
      !integerAtLeast(row["seq"], 0) ||
      !integerAtLeast(row["commitSeq"], 0)
    ) {
      return refuse(
        `has a row with a bad position (seq ${String(row["seq"])})`
      );
    }
    if (!nonEmptyString(row["table"]))
      return refuse("has a row naming no table");
    if (!SEAT_LOG_OPS.has(row["op"] as string)) {
      return refuse(`has a row with op ${String(row["op"])}`);
    }
    if (!Array.isArray(row["pk"]))
      return refuse("has a row with no primary key");
  }
  return page as unknown as SeatLogPageWire;
}

/** The four the wire admits; anything else is a door this seat cannot read. */
const SEAT_LOG_OPS = new Set(["insert", "update", "delete", "ddl"]);
