// THE SHELL READS THE SEAT (#996; wave 2, session-owned since wave 4).
//
// One hook, one fact: how current this browser's copy of the vault is.
//
// THE HOOK NO LONGER OWNS THE SEAT. It used to open its own `WebSeat` from this
// effect, which was right while the seat's only job was a number. Wave 4 adds a
// second consumer — the read path — and two owners of one file means two
// workers, two sets of OPFS access handles and two appliers, which makes the
// applier's "one commit, one transaction" argument false and corrupts the seat
// rather than raising an error. The session owns it now
// (`replica/seat/session-seat.ts`); this hook asks.
//
// THERE IS NO FLAG (W4-D1). `seat/flag.ts`, `?seatStore=1` and the remembered
// preference are gone: the owner opened W5 — the old store's deletion — while
// wave 4 was in flight, so a switch between two stores is a switch one of whose
// positions is being removed.
//
// WHY THE CUSTODY LINE IS THE FIRST PLACE IT SHOWS. It is where the old census
// record count was, and that number had stopped meaning anything under R1:
// every enrolled seat holds the same rows, so "41,208 records" said the same
// thing about every machine on the list. "Up to date" or "1,204 changes behind"
// is a fact about THIS one.
//
// AND IT FAILS QUIET. A browser with no OPFS, a gateway too old to serve the
// doors, a member who is offline — all of them answer `undefined`, and the line
// simply omits the clause. A seat's currency is not something to throw an error
// about on a settings screen.

import { useEffect, useState } from "react";

import type { SeatWatermark } from "../../replica/seat/watermark.js";
import { getReplicaShellSession } from "../../replica/shell-session.js";

/** The one thing this hook needs of a session; injected whole in tests. */
export interface SeatWatermarkSource {
  syncSeat: () => Promise<SeatWatermark | undefined>;
}

export interface SeatWatermarkOptions {
  /**
   * The session to ask. Defaults to the shell's own, which is `undefined`
   * until the browser is paired — and then nothing is asked and nothing opens.
   */
  readonly session?: () => Promise<SeatWatermarkSource | undefined>;
}

export function useSeatWatermark(
  options: SeatWatermarkOptions = {}
): SeatWatermark | undefined {
  const [watermark, setWatermark] = useState<SeatWatermark | undefined>();
  const session = options.session;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const held = await (session
          ? session()
          : getReplicaShellSession().catch(() => undefined));
        const answer = await held?.syncSeat();
        // The effect may have been torn down while the file was arriving; a
        // setState after that is a React warning and a leak.
        if (live) setWatermark(answer);
      } catch {
        // Quiet on purpose — see the note at the top of this file.
      }
    })();
    return () => {
      live = false;
    };
    // The session accessor is a stable injection; re-running on identity would
    // re-sync a seat on every render. The seat itself is NOT closed here — the
    // session owns it and outlives this screen.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return watermark;
}
