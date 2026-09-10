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
import type { IntentRecordStore } from "../intent-record-store.js";
import { replicaStorageKey } from "../key.js";
import type { SeatChangeNotice } from "./applier.js";
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
  /**
   * WHAT THE FILE ALREADY SAYS, BEFORE ANY SYNC (#1014, R1).
   *
   * A seat opened from disk knows its own `applied_seq` and
   * `applied_commit_seq` — the bootstrap or the previous session wrote them —
   * and the ack-after-delta sweep needs the second of those to notice an
   * intent whose commit the cursor has ALREADY passed. Reading it only from
   * `sync()` meant the sweep was skipped for the whole window between opening
   * a filled seat and its first successful catch-up, which is exactly the
   * window a relaunch-then-reconnect spends. Absent on a handle a suite drives
   * without a loop.
   */
  watermark?: () => SeatWatermark | undefined;
  /** The read path's one method — the same seam `SeatQueryPort` names. */
  query: <T extends object>(request: SeatWorkerQuery) => Promise<T[]>;
  /** The queue's durable store, in this seat's own file (#996, R24). */
  outbox: () => IntentRecordStore;
  /** Delete the file. Absent on a handle a suite drives without one. */
  purge?: () => Promise<void>;
  close: () => Promise<void>;
}

export interface SessionSeatOptions {
  readonly opener?: SeatOpener;
  /**
   * A batch landed. The session turns the notice into invalidations; the seat
   * only carries it, because WHICH screens care is not the seat's question.
   */
  readonly onChange?: (notice: SeatChangeNotice) => void;
  /** R24: the intents whose overlay this apply cleared, inside its transaction. */
  readonly onOverlaysCleared?: (intentIds: readonly string[]) => void;
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
  #filled = false;
  #watermark: SeatWatermark | undefined;
  #closed = false;

  constructor(
    private readonly auth: GatewayAuth,
    private readonly options: SessionSeatOptions = {}
  ) {}

  /**
   * The seat a READ may use: opened AND filled. `undefined` means "there is
   * none", which the read path answers ONLINE_ONLY.
   *
   * A SEAT IS A COPY, AND A COPY THAT HAS NOT ARRIVED IS NOT A SEAT (#996 wave
   * 4). Opening the file only opens the FILE: on a browser that has never held
   * this vault it is empty, with no `seat_state` and none of the vault's
   * tables, and the first app read against it does not come back empty — it
   * comes back `no such table: schedule_task`.
   */
  async open(): Promise<SessionSeatHandle | undefined> {
    const held = await this.file();
    return held && this.#filled ? held : undefined;
  }

  /**
   * The seat's FILE, filled or not — which is what the OUTBOX needs (#996,
   * R24, and this is the half wave 5 got wrong first).
   *
   * A queue must be durable from the member's FIRST write, and the first write
   * on a new device happens while the bootstrap is still downloading: a phone
   * opened on a train, an app used before the copy lands. Waiting for `sync`
   * would put those writes in memory and lose them on relaunch, which is the
   * one thing an outbox exists to prevent. `createSeatOutbox` runs when the
   * file is adopted, so `seat_outbox` is there on an empty file too.
   *
   * The READ path deliberately does not use this: an empty file answers a
   * statement with `no such table`, not with no rows.
   */
  file(): Promise<SessionSeatHandle | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    // Stored BEFORE the first await: two callers in one tick must not race.
    this.#opening ??= this.begin();
    return this.#opening;
  }

  /** The queue's durable store, or `undefined` when this seat holds no file. */
  async outbox(): Promise<IntentRecordStore | undefined> {
    return (await this.file())?.outbox();
  }

  /**
   * Get the copy if there is none, then tail until caught up.
   *
   * This is what FILLS the seat, so it is also what makes reads possible: the
   * first successful sync is the moment `open()` starts answering.
   */
  async sync(): Promise<SeatWatermark | undefined> {
    const seat = await this.file();
    if (!seat) return undefined;
    try {
      const watermark = await seat.sync();
      if (watermark !== undefined) {
        this.#watermark = watermark;
        this.#filled = true;
      }
    } catch {
      // An older copy is not an error, and neither is no copy yet: the caller
      // draws no clause and the read path refuses ONLINE_ONLY.
    }
    return this.#watermark;
  }

  /** How current this seat is, or `undefined` before it has said. */
  watermark(): SeatWatermark | undefined {
    return this.#watermark ?? this.#held?.watermark?.();
  }

  /**
   * Delete this seat's file and everything in it.
   *
   * Terminal: unpair, revoke, vault switch. The outbox goes with the file
   * because it IS part of the file — the same fact R24 rests on, read from the
   * other end.
   */
  async purge(): Promise<void> {
    const held = await this.file().catch(() => undefined);
    await held?.purge?.().catch(() => undefined);
    await this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const held = this.#held;
    this.#held = undefined;
    this.#opening = undefined;
    this.#filled = false;
    await held?.close().catch(() => undefined);
  }

  private async begin(): Promise<SessionSeatHandle | undefined> {
    try {
      const options = await seatOptionsFor(this.auth);
      if (!options) return undefined;
      const seat = await (
        this.options.opener ??
        ((open: WebSeatOptions) =>
          WebSeat.open({
            ...open,
            listeners: this.options.onChange
              ? { onChange: this.options.onChange }
              : {},
            ...(this.options.onOverlaysCleared
              ? { onOverlaysCleared: this.options.onOverlaysCleared }
              : {}),
          }))
      )(options);
      // The session may have closed while the file was opening; a seat nobody
      // owns any more is closed here rather than left holding its handles.
      if (this.#closed) {
        await seat.close().catch(() => undefined);
        return undefined;
      }
      this.#held = seat;
      // Seeded, never `#filled`: "the file says it stands here" and "a sync
      // landed" are different facts, and only the second one makes reads legal.
      this.#watermark ??= seat.watermark?.();
      return seat;
    } catch {
      return undefined;
    }
  }
}
