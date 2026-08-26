/*
 * Hygiene, not authorization (#726 P3): meters how fast a LINKED peer may
 * ask. One bucket per proved EndpointId; elapsed-time refill.
 */

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
}

export interface TokenBucket {
  /** false ⇒ refuse as typed state; never queue or serve late. */
  take: (key: string, cost?: number) => boolean;
  retryAfterMs: (key: string, cost?: number) => number;
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

/** Generous burst; sustained rate bounds a runaway peer. */
export const PEER_PLANE_BUDGET: TokenBucketOptions = {
  capacity: 120,
  refillPerSecond: 8,
};
