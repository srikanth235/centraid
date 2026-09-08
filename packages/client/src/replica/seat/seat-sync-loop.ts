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

import type { SeatWatermark } from "./watermark.js";

export interface SeatSyncTarget {
  sync: () => Promise<SeatWatermark | undefined>;
}

export class SeatSyncLoop {
  #running: Promise<SeatWatermark | undefined> | undefined;
  #again = false;

  constructor(private readonly seat: SeatSyncTarget) {}

  /**
   * Catch up, or join the catch-up already running.
   *
   * Never rejects: a seat that could not reach the gateway is a seat with a
   * slightly older copy, which is the normal state of the thing and not an
   * error a screen can act on.
   */
  sync(): Promise<SeatWatermark | undefined> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.seat
      .sync()
      .catch(() => undefined)
      .finally(() => {
        this.#running = undefined;
        if (!this.#again) return;
        this.#again = false;
        void this.sync();
      });
    return this.#running;
  }
}
