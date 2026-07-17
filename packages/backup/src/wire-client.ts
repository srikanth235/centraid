/*
 * Shared HTTP + JSON-envelope handling for `centraid-storage-provider/1`
 * clients (PROTOCOL.md § Error envelope): `{ "data": … }` on success,
 * `{ "error": { type, code, message, details? } }` on failure, mapped to
 * `BackupProviderError`. `RemoteBackupProvider` uses this for the full
 * workload surface; `cas-grant.ts`'s `requestStorageGrant` uses it standalone
 * so a CAS consumer never needs to construct a `BackupProvider`.
 */

import { BackupProviderError, type BackupProviderErrorCode } from './provider.js';

export interface WireClientOptions {
  /** e.g. "https://api.clawgnition.com" — no trailing slash required. */
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Transient-failure backpressure handling (PROTOCOL/issue #412). Two classes
   * of response are retryable, with deliberately different budgets:
   *   - **429** — explicit rate-limit backpressure. The client respects a
   *     `Retry-After` header when present, otherwise backs off exponentially,
   *     and is willing to wait out a full rate window (`rateLimit` budget).
   *   - **5xx / non-JSON** — a transient provider-internal failure
   *     (`provider_error` / `internal_error`, or a bare overload page that
   *     isn't even a JSON envelope). Retried on a SHORT, jittered budget
   *     (`serverError`): these clear fast, and prolonging retries only piles
   *     more load onto an already-struggling provider. A deterministic failure
   *     exhausts the small budget and surfaces unchanged.
   * Client-caused failures (4xx other than 429) are never retried. Full jitter
   * de-correlates concurrent clients. Overridable for tests; defaults are
   * production-safe.
   */
  retry?: {
    rateLimit?: RetryBudget;
    serverError?: RetryBudget;
    /** Injectable sleep for tests. Defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable jitter in [0,1). Defaults to `Math.random`. */
    random?: () => number;
  };
}

interface RetryBudget {
  /** Max attempts (incl. the first) before surfacing the error. */
  maxAttempts?: number;
  /** Base backoff in ms (before jitter) when no `Retry-After` is present. */
  baseDelayMs?: number;
  /** Per-attempt backoff ceiling in ms (before jitter). */
  maxDelayMs?: number;
  /** Cap on total time spent waiting across retries, in ms. */
  maxTotalWaitMs?: number;
}

const RATE_LIMIT_DEFAULTS: Required<RetryBudget> = {
  // A rate limiter that counts every request (including the ones it rejects)
  // only drains once the client goes quiet, so retries must be SPARSE: a high
  // ceiling makes later attempts wait tens of seconds, letting a saturated
  // window age out instead of being kept full by the retries themselves.
  maxAttempts: 12,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  maxTotalWaitMs: 150_000,
};
const SERVER_ERROR_DEFAULTS: Required<RetryBudget> = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  maxTotalWaitMs: 8_000,
};

function budget(
  override: RetryBudget | undefined,
  defaults: Required<RetryBudget>,
): Required<RetryBudget> {
  return {
    maxAttempts: override?.maxAttempts ?? defaults.maxAttempts,
    baseDelayMs: override?.baseDelayMs ?? defaults.baseDelayMs,
    maxDelayMs: override?.maxDelayMs ?? defaults.maxDelayMs,
    maxTotalWaitMs: override?.maxTotalWaitMs ?? defaults.maxTotalWaitMs,
  };
}

interface ErrorEnvelope {
  error: { type: string; code: string; message: string; details?: Record<string, unknown> };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header — integer seconds or an HTTP-date — into ms. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export async function callProviderRoute<T>(
  opts: WireClientOptions,
  method: string,
  routePath: string,
  body?: unknown,
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const rateLimit = budget(opts.retry?.rateLimit, RATE_LIMIT_DEFAULTS);
  const serverError = budget(opts.retry?.serverError, SERVER_ERROR_DEFAULTS);
  const sleep = opts.retry?.sleep ?? defaultSleep;
  const random = opts.retry?.random ?? Math.random;

  let rateLimitAttempts = 0;
  let serverErrorAttempts = 0;
  let rateLimitWaited = 0;
  let serverErrorWaited = 0;
  for (;;) {
    const res = await fetchImpl(`${baseUrl}${routePath}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    // The body is normally a JSON envelope, but a provider under duress can
    // return a bare plaintext overload page (not JSON) — tolerate that instead
    // of throwing a SyntaxError that would defeat the retry path below.
    let parsed: { data?: unknown } | ErrorEnvelope = {};
    let parseFailed = false;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as { data?: unknown } | ErrorEnvelope;
      } catch {
        parseFailed = true;
      }
    }

    // Backpressure (issue #412): 429 = explicit rate-limit (patient budget);
    // 5xx or an unparseable body = transient provider-internal failure (short,
    // jittered budget — don't pile load onto a struggling provider). 4xx with a
    // valid envelope are client faults and never retried.
    const isRateLimit = res.status === 429;
    const isServerError = res.status >= 500 || (parseFailed && !res.ok);
    const active = isRateLimit ? rateLimit : isServerError ? serverError : null;
    if (active) {
      const attempts = isRateLimit ? rateLimitAttempts : serverErrorAttempts;
      const waited = isRateLimit ? rateLimitWaited : serverErrorWaited;
      const header = isRateLimit ? retryAfterMs(res.headers.get('retry-after')) : undefined;
      const ceiling = Math.min(active.baseDelayMs * 2 ** attempts, active.maxDelayMs);
      // Rate limits get *equal* jitter (a floor of half the ceiling) so every
      // retry waits a meaningful amount and actually drains a saturated window
      // — the provider sends no Retry-After on the auth limiter, so a full-jitter
      // near-zero sleep would burn an attempt without helping. Transient 5xx
      // gets *full* jitter [0, ceiling] to de-correlate and clear fast.
      const jittered = isRateLimit
        ? Math.round(ceiling / 2 + random() * (ceiling / 2))
        : Math.round(random() * ceiling);
      const backoff = header ?? jittered;
      if (attempts < active.maxAttempts - 1 && waited + backoff <= active.maxTotalWaitMs) {
        if (isRateLimit) {
          rateLimitAttempts++;
          rateLimitWaited += backoff;
        } else {
          serverErrorAttempts++;
          serverErrorWaited += backoff;
        }
        await sleep(backoff);
        continue;
      }
    }

    if (!res.ok) {
      const envelope = parsed as ErrorEnvelope;
      const code = (envelope.error?.code ?? 'provider_error') as BackupProviderErrorCode;
      throw new BackupProviderError({
        status: res.status,
        code,
        message: envelope.error?.message ?? `request failed with ${res.status}`,
        ...(envelope.error?.details ? { details: envelope.error.details } : {}),
      });
    }
    return (parsed as { data: T }).data;
  }
}
