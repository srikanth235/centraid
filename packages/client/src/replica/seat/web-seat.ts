// THE WEB SEAT (#996, wave 2, behind the flag).
//
// Everything above this file is host-neutral. This is the browser's assembly
// of it: open the worker, get the file if there is none, then tail the log
// door until the seat's cursor meets the gateway's head.
//
// THE LOOP IS SMALL AND ITS EXIT CONDITIONS ARE ALL EXPLICIT, which is the
// only interesting thing about it:
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

import { ROUTES } from "@centraid/core/protocol";
import type { SeatLogPageWire } from "@centraid/core/protocol";

import { SeatDriftError } from "./seat-drift-error.js";
import { SeatRebootstrapRequiredError } from "./seat-rebootstrap-required-error.js";
import {
  defaultSeatWorkerFactory,
  SeatWorkerClient,
} from "./seat-worker-client.js";
import type {
  SeatWorkerFactory,
  SeatWorkerListeners,
} from "./seat-worker-client.js";
import type { SeatState } from "./state.js";
import { seatWatermark } from "./watermark.js";
import type { SeatWatermark } from "./watermark.js";

/** How many log rows to ask for at a time. The door's ceiling is 10,000. */
const PAGE = 1_000;
/** A catch-up is bounded; a seat that is further behind asks again. */
const MAX_PAGES_PER_SYNC = 200;

export interface WebSeatOptions {
  readonly vaultId: string;
  /** Absolute and vault-namespaced, the same rule the old worker enforces. */
  readonly dbName: string;
  /** The "Keep an offline copy" switch (R9). */
  readonly remember: boolean;
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly workerFactory?: SeatWorkerFactory;
  readonly fetch?: typeof globalThis.fetch;
  readonly listeners?: SeatWorkerListeners;
  /** Metered: skip a commit that crossed the byte threshold (R7). */
  readonly deferOverThreshold?: boolean;
}

export class WebSeat {
  #state: SeatState | undefined;

  private constructor(
    private readonly client: SeatWorkerClient,
    private readonly options: WebSeatOptions
  ) {}

  static async open(options: WebSeatOptions): Promise<WebSeat> {
    const factory = options.workerFactory ?? defaultSeatWorkerFactory;
    const client = new SeatWorkerClient(factory(), options.listeners ?? {});
    const seat = new WebSeat(client, options);
    seat.#state = await client.open({
      vaultId: options.vaultId,
      dbName: options.dbName,
      remember: options.remember,
    });
    return seat;
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
      try {
        await this.client.apply({
          page: answer,
          ...(this.options.deferOverThreshold === undefined
            ? {}
            : { deferOverThreshold: this.options.deferOverThreshold }),
        });
      } catch (error) {
        if (error instanceof SeatDriftError && !rebootstrapped) {
          rebootstrapped = true;
          await this.bootstrap();
          continue;
        }
        throw error;
      }
      this.#state = await this.client.state();
      if (!answer.hasMore) break;
    }
    return this.watermark();
  }
  /* oxlint-enable no-await-in-loop */

  close(): Promise<void> {
    return this.client.close();
  }

  private async bootstrap(): Promise<void> {
    await this.client.bootstrap({
      vaultId: this.options.vaultId,
      snapshotUrl: this.url(ROUTES.vaultSeatSnapshot),
      ...(this.options.headers ? { headers: this.options.headers } : {}),
    });
    this.#state = await this.client.state();
  }

  private url(path: string, search?: Record<string, string>): string {
    const url = new URL(path, this.options.baseUrl);
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
    return body as unknown as SeatLogPageWire;
  }
}
