/*
 * Standalone Layer-1 grant issuance (PROTOCOL.md § Credential grant) for a
 * `cas`-store consumer — Centraid's vault `S3BlobStore` wants
 * `{endpoint, region, bucket, prefix, credentials, expiry}` and nothing
 * else; it has no business pulling in `BackupProvider`, the snapshot
 * registry, or generation fencing just to get an S3 grant. `RemoteBackupProvider`
 * uses the same route internally (with `store: "backup"`) via this module.
 */

import type { S3Grant, StoreClass } from './provider.js';
import { callProviderRoute, type WireClientOptions } from './wire-client.js';

const DEFAULT_GRANT_TTL_SECONDS = 3600;

export interface RequestStorageGrantOptions extends WireClientOptions {
  targetId: string;
  store: StoreClass;
  mode: 'read' | 'read-write';
  ttlSeconds?: number;
}

/** Generic grant path — any store class, against `POST
 *  /v1/backup/vaults/:id/credentials` (PROTOCOL.md § Layer 1). */
export async function requestStorageGrant(opts: RequestStorageGrantOptions): Promise<S3Grant> {
  return callProviderRoute<S3Grant>(
    opts,
    'POST',
    `/v1/backup/vaults/${encodeURIComponent(opts.targetId)}/credentials`,
    {
      ttlSeconds: opts.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS,
      mode: opts.mode,
      store: opts.store,
    },
  );
}

export type RequestCasGrantOptions = Omit<RequestStorageGrantOptions, 'store'>;

/** Convenience wrapper — fixes `store: "cas"`. */
export async function requestCasGrant(opts: RequestCasGrantOptions): Promise<S3Grant> {
  return requestStorageGrant({ ...opts, store: 'cas' });
}
