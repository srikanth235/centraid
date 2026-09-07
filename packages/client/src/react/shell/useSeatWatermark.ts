// THE SHELL READS THE SEAT (#996; wave 2, unconditional since wave 4/W4-D1).
//
// One hook, one fact: how current this browser's copy of the vault is. It is
// the whole of what the shell takes from the new store so far; the READ path
// (apps' queries over real tables, paged) is wave 4's, and the old store's own
// files are deleted in wave 5.
//
// THERE IS NO FLAG (W4-D1). `seat/flag.ts`, `?seatStore=1` and the remembered
// preference are gone: the owner opened W5 — the old store's deletion — while
// wave 4 was in flight, so a switch between two stores is a switch one of whose
// positions is being removed. A seat opens whenever there is a vault to copy.
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
import type { SeatWatermark } from "../../replica/seat/watermark.js";
import { WebSeat } from "../../replica/seat/web-seat.js";
import type { WebSeatOptions } from "../../replica/seat/web-seat.js";

export interface SeatWatermarkOptions {
  /** Absent while the shell has no gateway yet — and then nothing opens. */
  readonly seat?: WebSeatOptions | undefined;
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
  const open = options.open ?? ((given) => WebSeat.open(given));

  useEffect(() => {
    if (!seat) return undefined;
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
  }, [seat]);

  return watermark;
}

/**
 * The seat's options, from the gateway auth the host already hands the shell.
 *
 * `undefined` until there is a gateway with a vault: a seat is a copy OF
 * something, and there is nothing to copy before the browser is paired.
 * The database name is namespaced by (gateway, vault) exactly as the old
 * store's is — two vaults in two tabs must not share a file — with `seat` in
 * the stem so the two stores cannot collide while both exist (wave 5 deletes
 * the old one).
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
