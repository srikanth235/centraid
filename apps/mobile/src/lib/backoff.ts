export interface BackoffSchedule {
  next: () => number;
  reset: () => void;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  jitter?: number;
  random?: () => number;
}

export function backoffSchedule(options: BackoffOptions): BackoffSchedule {
  const jitter = options.jitter ?? 0;
  const random = options.random ?? Math.random;
  let attempt = 0;
  return {
    next: () => {
      const delay = Math.min(options.baseMs * 2 ** attempt, options.maxMs);
      attempt += 1;
      if (jitter === 0) return delay;
      return Math.round(delay * (1 + jitter * (random() * 2 - 1)));
    },
    reset: () => {
      attempt = 0;
    },
  };
}
