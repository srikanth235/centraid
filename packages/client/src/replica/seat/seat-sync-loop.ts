// KEEPING A SEAT CURRENT, ON WHATEVER SCHEDULE ITS HOST HAS (#996, W5).
//
// A seat catches up by asking the log door for pages until it is level. WHEN it
// asks is the host's business — the browser rides its session's sync, the phone
// rides the foreground and a wake frame — but what must not differ is that TWO
// CATCH-UPS NEVER RUN AT ONCE. They would both start from the same applied
// cursor, ask for the same pages, and apply them twice; the applier is
// idempotent so nothing would break, and the phone would simply spend the
// bytes twice on a metered connection.
//
// SO A SYNC IN FLIGHT ABSORBS THE ONES THAT ARRIVE BEHIND IT, and exactly one
// follow-up runs afterwards — a burst of wake frames during a bootstrap costs
// one extra pass, not one per frame. The same shape the Photos engine's read
// coalescing has, for the same reason, and it is here rather than in each host
// because a host that got it wrong would look correct.

import { isSeatAuthorizationRevoked } from "./seat-authorization-revoked-error.js";
import { isSeatTerminalError } from "./seat-drift-parked-error.js";
import type { SeatWatermark } from "./watermark.js";

export interface SeatSyncTarget {
  sync: () => Promise<SeatWatermark | undefined>;
}

export interface SeatSyncLoopOptions {
  /**
   * WHAT SWALLOWED THE CATCH-UP, SAID OUT LOUD (#1011).
   *
   * `sync()` still never rejects — a seat that could not reach the gateway is
   * a seat with a slightly older copy — but "did not land" and "why" are two
   * different answers, and only the first of them was ever reported. A phone
   * whose every pull failed on the same refused socket therefore drew an empty
   * library with nothing anywhere naming the refusal: not on the device, and
   * not on the gateway, whose seat doors were never reached to log a thing.
   *
   * So the failure is HANDED OVER rather than dropped. The loop still decides
   * nothing with it; the host does.
   */
  readonly onError?: (error: unknown) => void;
}

export class SeatSyncLoop {
  #running: Promise<SeatWatermark | undefined> | undefined;
  #again = false;
  #closed = false;

  constructor(
    private readonly seat: SeatSyncTarget,
    private readonly options: SeatSyncLoopOptions = {}
  ) {}

  /**
   * Catch up, or join the catch-up already running.
   *
   * Rejects for exactly three failures and swallows every other one. An outage
   * is not an error a screen can act on — a seat that could not reach the
   * gateway is a seat with a slightly older copy, which is the normal state of
   * the thing. Out of room, a parked drift and a REVOKED device ARE (#1014,
   * C13, C14, X8): all three fail identically on every retry, and the host has
   * a state to show for each. Swallowing them made the phone's storage-full
   * park unreachable code (`native-session.ts`), left the drift re-bootstrap
   * loop unbounded, and let a read-only seat keep a copy the gateway had
   * already refused it.
   */
  /**
   * THE HOST IS GONE (#1014, P17).
   *
   * Nothing used to stop this loop: a follow-up scheduled by the `finally`
   * below fired after `close()` or `purge()` had already unlinked the file,
   * so a pass ran against a closed driver — and a caller that had joined the
   * earlier pass was answered with ITS watermark as the verdict for a seat
   * that no longer exists. A closed loop absorbs nothing and starts nothing.
   */
  close(): void {
    this.#closed = true;
    this.#again = false;
  }

  sync(): Promise<SeatWatermark | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    let terminal = false;
    const run = this.seat.sync().catch((error: unknown) => {
      this.options.onError?.(error);
      // REVOCATION STOPS THE LOOP TOO (#1014, X8). It fails identically on
      // every retry and the host has a state to show for it — one that is not
      // "try again" but "this copy must go".
      if (!isSeatTerminalError(error) && !isSeatAuthorizationRevoked(error))
        return undefined;
      terminal = true;
      throw error;
    });
    this.#running = run;
    void run
      .finally(() => {
        this.#running = undefined;
        const again = this.#again;
        this.#again = false;
        // A PARKED SEAT GETS NO FOLLOW-UP PASS (#1014, C13, C14). The absorbed
        // callers behind this one would each be one more doomed attempt, which
        // is the loop the park exists to end.
        if (again && !terminal && !this.#closed)
          void this.sync().catch(() => undefined);
      })
      // The rejection is the CALLER's to handle; this arm exists only so the
      // bookkeeping above is not itself an unhandled rejection.
      .catch(() => undefined);
    return run;
  }
}
