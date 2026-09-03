import { BackupProviderError } from "./provider.js";
import type { BackupProviderErrorCode } from "./provider.js";

export interface WireClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  retry?: {
    rateLimit?: RetryBudget;
    serverError?: RetryBudget;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  };
}

interface RetryBudget {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxTotalWaitMs?: number;
}

const RATE_LIMIT_DEFAULTS: Required<RetryBudget> = {
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
  defaults: Required<RetryBudget>
): Required<RetryBudget> {
  return {
    maxAttempts: override?.maxAttempts ?? defaults.maxAttempts,
    baseDelayMs: override?.baseDelayMs ?? defaults.baseDelayMs,
    maxDelayMs: override?.maxDelayMs ?? defaults.maxDelayMs,
    maxTotalWaitMs: override?.maxTotalWaitMs ?? defaults.maxTotalWaitMs,
  };
}

interface ErrorEnvelope {
  error: {
    type: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
  body?: unknown
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/u, "");
  const rateLimit = budget(opts.retry?.rateLimit, RATE_LIMIT_DEFAULTS);
  const serverError = budget(opts.retry?.serverError, SERVER_ERROR_DEFAULTS);
  const sleep = opts.retry?.sleep ?? defaultSleep;
  const random = opts.retry?.random ?? Math.random;

  let rateLimitAttempts = 0;
  let serverErrorAttempts = 0;
  let rateLimitWaited = 0;
  let serverErrorWaited = 0;
  const attempt = async (): Promise<T> => {
    const res = await fetchImpl(`${baseUrl}${routePath}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: { data?: unknown } | ErrorEnvelope = {};
    let parseFailed = false;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as { data?: unknown } | ErrorEnvelope;
      } catch {
        parseFailed = true;
      }
    }

    const isRateLimit = res.status === 429;
    const isServerError = res.status >= 500 || (parseFailed && !res.ok);
    const active = isRateLimit ? rateLimit : isServerError ? serverError : null;
    if (active) {
      const attempts = isRateLimit ? rateLimitAttempts : serverErrorAttempts;
      const waited = isRateLimit ? rateLimitWaited : serverErrorWaited;
      const header = isRateLimit
        ? retryAfterMs(res.headers.get("retry-after"))
        : undefined;
      const ceiling = Math.min(
        active.baseDelayMs * 2 ** attempts,
        active.maxDelayMs
      );
      const jittered = isRateLimit
        ? Math.round(ceiling / 2 + random() * (ceiling / 2))
        : Math.round(random() * ceiling);
      const backoff = header ?? jittered;
      if (
        attempts < active.maxAttempts - 1 &&
        waited + backoff <= active.maxTotalWaitMs
      ) {
        if (isRateLimit) {
          rateLimitAttempts++;
          rateLimitWaited += backoff;
        } else {
          serverErrorAttempts++;
          serverErrorWaited += backoff;
        }
        await sleep(backoff);
        return attempt();
      }
    }

    if (!res.ok) {
      const envelope = parsed as ErrorEnvelope;
      const code = (envelope.error?.code ??
        "provider_error") as BackupProviderErrorCode;
      throw new BackupProviderError({
        status: res.status,
        code,
        message: envelope.error?.message ?? `request failed with ${res.status}`,
        ...(envelope.error?.details ? { details: envelope.error.details } : {}),
      });
    }
    return (parsed as { data: T }).data;
  };
  return attempt();
}
