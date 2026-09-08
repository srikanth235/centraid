// THE ONE RETRY LOOP FOR A PURGE THAT COULD NOT FINISH (#599, #922 C6).
//
// A terminal purge — unpair, revoke, remove a gateway — is scheduled durably
// before anything is deleted, so a crash between the two does not leave a
// member's data on a device they revoked. Whatever could not finish is retried
// by this loop.
//
// A MODULE OF ITS OWN because both halves of the shell session need to wake it:
// the SESSION, when its own purge fails, and the SCOPE REGISTRY, when it drops
// an entry. Holding it in either half would make the other import that half,
// and the two would then be one file again.

import { TerminalReplicaPurgeRetryLoop } from "./terminal-purge-retry.js";

export const terminalPurgeRetryLoop = new TerminalReplicaPurgeRetryLoop();

/**
 * Drop this browser's cached bytes for a scope that is going away.
 *
 * The service worker's tunnel caches are not the replica, and nothing else
 * clears them: a revoked vault whose thumbnails are still in Cache Storage is
 * exactly the data the revocation was about.
 */
export function purgeBrowserReplicaCaches(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "centraid:purge-tunnel-cache",
    });
  } catch {
    /* Desktop and hardened browsers have no service-worker cache lane. */
  }
  // Cache Storage can throw on access even when the global is present, and
  // `keys()` / `delete()` reject; one promise chain captures both.
  void Promise.resolve()
    .then(() => (typeof caches === "undefined" ? [] : caches.keys()))
    .then((names) =>
      Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("centraid-tunnel-assets-") ||
              name.startsWith("centraid-tunnel-blobs-")
          )
          .map((name) => caches.delete(name))
      )
    )
    .catch(() => undefined);
}
