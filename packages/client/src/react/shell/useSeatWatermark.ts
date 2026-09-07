// THE SHELL READS THE SEAT (#996, wave 2, behind the flag).
//
// One hook, one fact: how current this browser's copy of the vault is. It is
// the whole of what the shell takes from the new store in wave 2, and that is
// deliberate — the READ path (apps' queries over real tables, paged) is wave
// 4's, and the old store is not deleted until wave 5. What the flag switches
// on here is the FILE and the number that describes it, not where a screen
// gets its rows.
//
// WHY THE CUSTODY LINE IS THE FIRST PLACE IT SHOWS. It is where the old
// census record count was, and that number had stopped meaning anything under
// R1: every enrolled seat holds the same rows, so "41,208 records" said the
// same thing about every machine on the list. "Up to date" or "1,204 changes
// behind" is a fact about THIS one.
//
// AND IT FAILS QUIET. A browser with no OPFS, a gateway too old to serve the
// doors, a member who is offline — all of them answer `undefined`, and the
// line simply omits the clause. A seat's currency is not something to throw
// an error about on a settings screen.

import { useEffect, useState } from "react";

import { replicaStorageKey } from "../../replica/key.js";
import { browserSeatStoreFlag } from "../../replica/seat/flag.js";
import type { SeatWatermark } from "../../replica/seat/watermark.js";
import { WebSeat } from "../../replica/seat/web-seat.js";
import type { WebSeatOptions } from "../../replica/seat/web-seat.js";

export interface SeatWatermarkOptions {
  /** Everything but the flag; absent while the shell has no gateway yet. */
  readonly seat?: WebSeatOptions | undefined;
  /** Overrides the flag. Tests and hosts that have already decided. */
  readonly enabled?: boolean | undefined;
  /** Injected so a suite can drive the whole hook without a worker. */
  readonly open?: (options: WebSeatOptions) => Promise<{
    sync: () => Promise<SeatWatermark | undefined>;
    close: () => Promise<void>;
  }>;
}

export function useSeatWatermark(
  options: SeatWatermarkOptions = {}
): SeatWatermark | undefined {
  const [watermark, setWatermark] = useState<SeatWatermark | undefined>();
  const seat = options.seat;
  const enabled = browserSeatStoreFlag(options.enabled);
  const open = options.open ?? ((given) => WebSeat.open(given));

  useEffect(() => {
    if (!enabled || !seat) return undefined;
    let live = true;
    let held: { close: () => Promise<void> } | undefined;
    void (async () => {
      try {
        const opened = await open(seat);
        held = opened;
        const answer = await opened.sync();
        // The effect may have been torn down while the file was arriving; a
        // setState after that is a React warning and a leak.
        if (live) setWatermark(answer);
      } catch {
        // Quiet on purpose — see the note at the top of this file.
      }
    })();
    return () => {
      live = false;
      void held?.close().catch(() => undefined);
    };
    // `open` is a stable injection in practice; re-running on identity would
    // re-bootstrap a seat on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, seat]);

  return watermark;
}

/**
 * The seat's options, from the gateway auth the host already hands the shell.
 *
 * `undefined` until there is a gateway with a vault: a seat is a copy OF
 * something, and there is nothing to copy before the browser is paired.
 * The database name is namespaced by (gateway, vault) exactly as the old
 * store's is — two vaults in two tabs must not share a file — with `seat` in
 * the stem so the two stores cannot collide during the flag's lifetime.
 */
export async function seatOptionsFromHost(): Promise<
  WebSeatOptions | undefined
> {
  const api = (
    globalThis as { CentraidApi?: { getGatewayAuth?: () => Promise<unknown> } }
  ).CentraidApi;
  const auth = (await api?.getGatewayAuth?.().catch(() => undefined)) as
    | {
        baseUrl?: string;
        gatewayId?: string;
        vaultId?: string;
        token?: string;
        rememberDevice?: boolean;
      }
    | undefined;
  if (!auth?.baseUrl || !auth.vaultId || !auth.gatewayId) return undefined;
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
