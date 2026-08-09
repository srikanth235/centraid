import type { NativeChangeFeed } from "./native-session";

/**
 * Borrowed replicas have no vault SSE stream: the audience gateway's peer
 * sweep is authoritative and the native session polls while foregrounded.
 */
export function borrowedChangeFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}
