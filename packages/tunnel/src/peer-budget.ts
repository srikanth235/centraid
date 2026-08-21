/*
 * Per-link hygiene budget for the peer plane (issue #726 P3, threat 7).
 *
 * A link is a standing invitation to spend this gateway's CPU, disk and
 * bandwidth. The budget is hygiene, not authorization: it bounds how fast a
 * LINKED peer may ask, so a misbehaving or compromised peer degrades itself
 * rather than the host. Authorization is the link; this only meters it.
 *
 * One bucket per key (the peer's proved EndpointId). Refill is computed from
 * elapsed time rather than a timer, so an idle key costs nothing and the
 * store can be swept lazily.
 */

export interface TokenBucketOptions {
  /** Burst size: tokens available to a peer that has been quiet. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface TokenBucket {
  /**
   * Spend `cost` tokens for `key`. `false` means the caller must refuse the
   * request as a typed state — never queue it, never serve it late.
   */
  take: (key: string, cost?: number) => boolean;
  /** Milliseconds until `cost` tokens exist for `key`; 0 when they do. */
  retryAfterMs: (key: string, cost?: number) => number;
  /** Drop a key's state (link revoked / connection gone). */
  forget: (key: string) => void;
  size: () => number;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  if (options.capacity <= 0 || options.refillPerSecond <= 0) {
    throw new Error("peer budget: capacity and refill must be positive");
  }
  const now = options.now ?? Date.now;
  const states = new Map<string, BucketState>();

  const refreshed = (key: string): BucketState => {
    const at = now();
    const state = states.get(key) ?? {
      tokens: options.capacity,
      updatedAt: at,
    };
    const elapsedSeconds = Math.max(0, at - state.updatedAt) / 1000;
    state.tokens = Math.min(
      options.capacity,
      state.tokens + elapsedSeconds * options.refillPerSecond
    );
    state.updatedAt = at;
    states.set(key, state);
    return state;
  };

  return {
    take: (key, cost = 1) => {
      const state = refreshed(key);
      if (state.tokens < cost) return false;
      state.tokens -= cost;
      return true;
    },
    retryAfterMs: (key, cost = 1) => {
      const state = refreshed(key);
      if (state.tokens >= cost) return 0;
      return Math.ceil(
        ((cost - state.tokens) / options.refillPerSecond) * 1000
      );
    },
    forget: (key) => void states.delete(key),
    size: () => states.size,
  };
}

/**
 * Peer-plane defaults. A link's legitimate traffic is bursty (a give opens an
 * edge, fetches a closure, then pulls blobs by sha), so the burst is generous
 * and the sustained rate is what actually bounds a runaway peer.
 */
export const PEER_PLANE_BUDGET: TokenBucketOptions = {
  capacity: 120,
  refillPerSecond: 8,
};
