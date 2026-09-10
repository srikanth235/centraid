// A MOUNT THAT DID NOT HAPPEN, SAID ONCE (#1011).
//
// Two branches end a mount without a session: a seat file that would not open,
// and anything thrown on the way. They must publish the SAME shape — ready,
// not online, an error a screen can draw, and a refresh that starts the mount
// over — because the one thing a member must never get is a provider that
// keeps its loading value for the life of the app. Stating it once is how the
// two stay the same; the seat branch's copy of it was a `publish` that patched
// an entry which did not exist yet, and published nothing at all.

import type { ReplicaContextValue } from "./replica-context";
import type { ReplicaReachability } from "./replica-status";

export interface MountFailureOptions {
  /** What to tell the member; already a sentence, never an error object. */
  readonly error: string;
  /**
   * `device-offline` when nothing about the gateway was asked (no local file
   * to open), `gateway-asleep` when the mount died mid-flight.
   */
  readonly reachability: ReplicaReachability;
  /** Mounts again from the top. */
  readonly refresh: () => Promise<void>;
}

/** The context value for a mount that produced no session. */
export function mountFailureValue(
  options: MountFailureOptions
): ReplicaContextValue {
  return {
    scopes: [],
    ready: true,
    online: false,
    reachability: options.reachability,
    refresh: options.refresh,
    error: options.error,
  };
}
