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
}

interface ErrorEnvelope {
  error: { type: string; code: string; message: string; details?: Record<string, unknown> };
}

export async function callProviderRoute<T>(
  opts: WireClientOptions,
  method: string,
  routePath: string,
  body?: unknown,
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${baseUrl}${routePath}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as { data?: unknown } | ErrorEnvelope) : {};
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
