/**
 * Shared outbound-fetch timeout (issue #351 Tier 4 hygiene) for the two
 * gateway paths that call out to a third party on the owner's behalf: the
 * connection broker's OAuth token refresh (`connection-broker.ts`) and the
 * outbox executor's external writes (`outbox-executor.ts`). Neither had a
 * bound before — a hung IdP token endpoint or a hung third-party write
 * endpoint would wedge the caller (a fire, a drain pass) indefinitely.
 *
 * Both callers already have a failure taxonomy that treats a network error
 * as transient (retry once / defer to the next drain, never a state flip).
 * `AbortSignal.timeout` makes `fetch` reject with a `TimeoutError` on
 * expiry — an ordinary rejected promise that lands in those SAME catch
 * blocks, so a timeout degrades exactly like a dropped connection would.
 * No new state, just a bound on how long the caller waits to find out.
 */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
