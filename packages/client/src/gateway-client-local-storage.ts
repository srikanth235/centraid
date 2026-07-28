/*
 * Renderer-side client for the gateway's LOCAL disk surface (issue #544 —
 * `packages/gateway/src/routes/storage-routes.ts`). Sibling of
 * `gateway-client-storage.ts`, which speaks to the same route prefix but
 * about the PROVIDER: that file answers "what does my storage provider hold",
 * this one answers "what is Centraid using on this machine, and what ceiling
 * have I put on it".
 *
 *   GET     /centraid/_gateway/storage/local     (+ `?refresh=1` to re-walk)
 *   GET|PUT /centraid/_gateway/storage/limits
 *
 * Kept in its own module rather than appended to `gateway-client-storage.ts`
 * for the plain reason that the two have no shared types and that file is
 * already near the repo's file-size cap.
 */

import { auth, authHeaders, doFetch, readJson } from './gateway-client-core.js';

/** Stable component vocabulary — mirrors `serve/local-usage.ts`'s
 *  `LocalComponentId`. Renaming one of these is a wire change. */
export type LocalComponentId =
  | 'ledger'
  | 'vault-db'
  | 'attachments'
  | 'apps'
  | 'code'
  | 'backup'
  | 'logs'
  | 'cache'
  | 'templates'
  | 'storage';

export interface LocalComponentUsageDTO {
  component: LocalComponentId;
  bytes: number;
  /** File count for directory components; `null` for the DB-file components. */
  files: number | null;
  /** Set when part of the tree could not be read — `bytes` is a floor. */
  unreadable?: string;
}

export interface LocalVaultUsageDTO {
  vaultId: string;
  name?: string;
  bytes: number;
  components: LocalComponentUsageDTO[];
}

export interface StorageLimitsDTO {
  /** The owner's whole-of-Centraid disk budget, or `null` for unlimited. */
  totalLimitBytes: number | null;
  /** Percent of the budget at which the health component degrades. */
  warnAtPercent: number;
  /** `journal.db` size that triggers early archival, or `null` for off. */
  journalLimitBytes: number | null;
}

export interface StorageLimitEvaluationDTO {
  status: 'ok' | 'degraded' | 'error';
  /** `null` when no budget is set — nothing to be a fraction of. */
  fractionUsed: number | null;
  usedBytes: number;
  limitBytes: number | null;
}

export interface LocalUsageReportDTO {
  /** Epoch ms the walk behind these figures finished. */
  scannedAt: number;
  totalBytes: number;
  /** Gateway-level components, not attributable to one vault. */
  components: LocalComponentUsageDTO[];
  vaults: LocalVaultUsageDTO[];
  /** The volume the vault root sits on; `null` when statfs is unavailable. */
  disk: { freeBytes: number; totalBytes: number } | null;
  limits: StorageLimitsDTO;
  limit: StorageLimitEvaluationDTO;
  /** Set when the last refresh threw — figures are last-known-good. */
  error?: string;
}

/**
 * The local footprint report. A plain call is served from the gateway's TTL
 * cache; `refresh` forces a full re-walk and should only ever come from an
 * explicit owner action, never a poll — the walk covers the whole blob CAS.
 */
export async function getLocalStorageUsage(
  opts: { refresh?: boolean } = {},
): Promise<LocalUsageReportDTO> {
  const { baseUrl, token } = await auth();
  const path = opts.refresh
    ? '/centraid/_gateway/storage/local?refresh=1'
    : '/centraid/_gateway/storage/local';
  const res = await doFetch(baseUrl, path, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<LocalUsageReportDTO>(res, 'local storage usage');
}

export async function getStorageLimits(): Promise<StorageLimitsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/storage/limits', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ limits: StorageLimitsDTO }>(res, 'storage limits');
  return out.limits;
}

/** Partial patch — an explicit `null` on either limit clears it. Omitted
 *  fields are left alone, so the two controls never overwrite each other. */
export interface StorageLimitsPatchDTO {
  totalLimitBytes?: number | null;
  warnAtPercent?: number;
  journalLimitBytes?: number | null;
}

export async function updateStorageLimits(patch: StorageLimitsPatchDTO): Promise<StorageLimitsDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/storage/limits', {
    method: 'PUT',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(patch),
  });
  const out = await readJson<{ limits: StorageLimitsDTO }>(res, 'update storage limits');
  return out.limits;
}
