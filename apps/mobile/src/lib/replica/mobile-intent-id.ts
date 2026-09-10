import type { ReplicaIdFactory } from "@centraid/client/replica/native";

/**
 * ONE GESTURE, ONE INTENT ID (#1014, C24).
 *
 * This used to hash `appId | action | canonical(input)` and hand two writes
 * inside a two-second window the SAME id, so the gateway's idempotency
 * discarded the second. For a revisable edit that was merely a slow way to do
 * what `pendingIntentForInput` already does exactly — the outbox is asked
 * whether this input revises a pending write, by declared revision, before an
 * id is minted at all. For a NON-idempotent action it was loss by
 * construction: two "+1" taps, two glasses logged, one recorded. It also
 * trusted the wall clock, so a backwards step kept entries alive past their
 * window.
 *
 * Idempotency across RETRIES is not this class's job and never was: a retry
 * re-sends the intent already in `seat_outbox`, which carries the id the
 * gesture minted, and the gateway's retained outcome answers it. What this
 * has to guarantee is that two gestures are two ids — so it mints one per
 * call, from the host's id factory, with a per-session serial in front of it
 * so ids from one session are also ordered and can never collide with each
 * other even if the factory repeats.
 */
export class MobileIntentIds {
  #minted = 0;

  constructor(private readonly createId: ReplicaIdFactory) {}

  /**
   * `explicit` is a caller that owns its own id across restarts — the upload
   * queue keys on the file's digest — and is passed through untouched.
   */
  forWrite(explicit?: string): string {
    if (explicit) return explicit;
    this.#minted += 1;
    return `${this.#minted}-${this.createId()}`;
  }
}
