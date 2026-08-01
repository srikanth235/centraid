/**
 * Retry delays for work that fails because the gateway is unreachable.
 *
 * A fixed interval is the wrong shape for "the phone left wifi": the intent
 * drainer retried every 2 s forever, so a night out of coverage was thousands of
 * radio wake-ups that could not have succeeded. Doubling to a ceiling keeps the
 * first few retries fast — the common case is a blip — while an outage settles
 * into an idle poll. Reachability changes still reset the sequence, so a real
 * reconnect is not made to wait out the current delay.
 */
export interface BackoffSchedule {
  /** Delay to wait before the next attempt, then advance the sequence. */
  next: () => number;
  /** Return to the first delay; call when something has actually changed. */
  reset: () => void;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /**
   * Fraction of the delay to spread attempts over, so several queued scopes do
   * not all wake the radio on the same millisecond. `0` disables it.
   */
  jitter?: number;
  /** Injected so a test is not deciding between determinism and a real spread. */
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
