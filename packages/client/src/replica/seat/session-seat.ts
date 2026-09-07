/*
 * THE SESSION'S ONE SEAT (#996 wave 4).
 *
 * A seat is a FILE, and a file admits one writer. The applier's correctness
 * argument is "one commit, one transaction, cursor included"; a second worker
 * on the same OPFS handles makes that argument false, and the failure mode is a
 * corrupted seat rather than an error anyone sees. So the seat is owned once,
 * by the thing that is already scoped and refcounted per (gateway, vault) — the
 * replica shell session — and every consumer asks it rather than opening one.
 *
 * WHY THAT IS NOT JUST A MEMOISED PROMISE. It nearly is; the part that matters
 * is that the memo is installed BEFORE the first `await`. Two consumers that
 * ask in the same tick — the watermark line mounting while an app's first read
 * runs — both see "not open yet" and both open, and the second one loses the
 * race for the access handles. The promise is stored synchronously, so the
 * second caller joins the first open instead of starting another.
 *
 * IT FAILS QUIET, AND IT DOES NOT RETRY. A browser with no OPFS, a gateway too
 * old to serve the seat doors, a member who has not paired yet: all of them are
 * "no seat", which callers render as an absent clause and not as an error. A
 * failed open is remembered as failed for the life of the session rather than
 * retried on every read, because a read path that re-attempts a broken open on
 * every keystroke is how a quiet failure becomes a loud one.
 */

import type { GatewayAuth } from "../../gateway-auth.js";
import { replicaStorageKey } from "../key.js";
import type { SeatWatermark } from "./watermark.js";
import { WebSeat } from "./web-seat.js";
import type { WebSeatOptions } from "./web-seat.js";
import type { SeatWorkerQuery } from "./worker-protocol.js";

/**
 * What a consumer may do with the session's seat.
 *
 * Structurally typed rather than `WebSeat` itself so a suite can drive the
 * whole ownership rule without a worker, and so the read path depends on the
 * one method it uses (`SeatQueryPort` in `seat-page-reader.ts` is the same
 * discipline).
 */
export interface SessionSeatHandle {
  sync: () => Promise<SeatWatermark | undefined>;
  /** The read path's one method — the same seam `SeatQueryPort` names. */
  query: <T extends object>(request: SeatWorkerQuery) => Promise<T[]>;
  close: () => Promise<void>;
}

export type SeatOpener = (
  options: WebSeatOptions
) => Promise<SessionSeatHandle>;

/**
 * The seat's file name and credentials, from the gateway auth the session
 * already holds.
 *
 * `undefined` until there is a gateway with a vault: a seat is a copy OF
 * something, and there is nothing to copy before the browser is paired. The
 * name is namespaced by (gateway, vault) exactly as the old store's is — two
 * vaults in two tabs must not share a file — with `seat` in the stem so the two
 * stores cannot collide while both exist (wave 5 deletes the old one).
 */
export async function seatOptionsFor(
  auth: GatewayAuth
): Promise<WebSeatOptions | undefined> {
  if (!auth.baseUrl || !auth.vaultId || !auth.gatewayId) return undefined;
  const stem = await replicaStorageKey({
    gatewayId: auth.gatewayId,
    vaultId: auth.vaultId,
  });
  return {
    vaultId: auth.vaultId,
    dbName: `/centraid-seat-${stem}.sqlite3`,
    remember: auth.rememberDevice === true,
    baseUrl: auth.baseUrl,
    ...(auth.token
      ? { headers: { Authorization: `Bearer ${auth.token}` } }
      : {}),
  };
}

export class SessionSeat {
  #opening: Promise<SessionSeatHandle | undefined> | undefined;
  #held: SessionSeatHandle | undefined;
  #watermark: SeatWatermark | undefined;
  #closed = false;

  constructor(
    private readonly auth: GatewayAuth,
    private readonly opener: SeatOpener = (options) => WebSeat.open(options)
  ) {}

  /** The one seat, opened on first ask. `undefined` means "there is none". */
  open(): Promise<SessionSeatHandle | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    // Stored BEFORE the first await: two callers in one tick must not race.
    this.#opening ??= this.begin();
    return this.#opening;
  }

  /** Catch the seat up and report how current it is. Quiet on failure. */
  async sync(): Promise<SeatWatermark | undefined> {
    const seat = await this.open();
    if (!seat) return undefined;
    try {
      this.#watermark = await seat.sync();
    } catch {
      // An older copy is not an error; the caller draws no clause.
    }
    return this.#watermark;
  }

  /** How current this seat is, or `undefined` before it has said. */
  watermark(): SeatWatermark | undefined {
    return this.#watermark;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const held = this.#held;
    this.#held = undefined;
    this.#opening = undefined;
    await held?.close().catch(() => undefined);
  }

  private async begin(): Promise<SessionSeatHandle | undefined> {
    try {
      const options = await seatOptionsFor(this.auth);
      if (!options) return undefined;
      const seat = await this.opener(options);
      // The session may have closed while the file was arriving; a seat nobody
      // owns any more is closed here rather than left holding its handles.
      if (this.#closed) {
        await seat.close().catch(() => undefined);
        return undefined;
      }
      this.#held = seat;
      return seat;
    } catch {
      return undefined;
    }
  }
}
