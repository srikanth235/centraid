/*
 * Provider-observability helpers for the gateway backup engine (issue #414).
 * Policy declaration and inventory/audit collection live here so the service
 * remains the serialized lifecycle owner rather than growing wire-protocol
 * parsing inline.
 */

import {
  BackupProviderError,
  type BackupProvider,
  type ProviderAuditEvent,
  type ProviderCapabilities,
  type ProviderInventoryObject,
  type ProviderPolicy,
  type ProviderPolicyDeclaration,
  type StoreClass,
} from '@centraid/backup';
import type { BackupPolicy } from '@centraid/vault';

export type ProviderPolicySyncStatus =
  | 'pending'
  | 'synced'
  | 'drift'
  | 'rejected'
  | 'unsupported'
  | 'error';

/** Sticky provider-policy state persisted beside the target. */
export interface ProviderPolicySyncState {
  status: ProviderPolicySyncStatus;
  desired: ProviderPolicyDeclaration;
  checkedAt: string;
  echo?: ProviderPolicy;
  error?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export type InventorySource = 'provider' | 'bucket';

export interface CollectedInventory {
  source: InventorySource;
  providerAttested: boolean;
  objects: ProviderInventoryObject[];
  /** Set when an advertised attestation failed and raw LIST kept the safety pass alive. */
  attestationError?: string;
  /** Present for an explicit raw-LIST cross-check against provider attestation. */
  crossCheck?: {
    providerOnly: string[];
    bucketOnly: string[];
    /** Same live key, but the provider's attestation differs from raw LIST metadata. */
    metadataMismatch: string[];
  };
}

export interface CollectedAudit {
  source: 'provider' | 'unavailable';
  eventCount: number;
  recent: ProviderAuditEvent[];
  error?: string;
}

export function providerPolicyFor(policy: BackupPolicy): ProviderPolicyDeclaration {
  return {
    rpoSeconds: policy.rpoSeconds,
    snapshotIntervalHours: policy.snapshotIntervalHours,
    verifyEveryDays: policy.verifyEveryDays,
    casAck: policy.casAck,
  };
}

export function providerPolicyMatches(
  desired: ProviderPolicyDeclaration,
  echo: ProviderPolicyDeclaration,
): boolean {
  return (
    desired.rpoSeconds === echo.rpoSeconds &&
    desired.snapshotIntervalHours === echo.snapshotIntervalHours &&
    desired.verifyEveryDays === echo.verifyEveryDays &&
    desired.casAck === echo.casAck
  );
}

function errorFields(
  err: unknown,
): Pick<ProviderPolicySyncState, 'error' | 'errorCode' | 'details'> {
  const error = err instanceof Error ? err.message : String(err);
  if (!(err instanceof BackupProviderError)) return { error };
  return {
    error,
    errorCode: err.code,
    ...(err.details ? { details: err.details } : {}),
  };
}

async function capabilities(provider: BackupProvider): Promise<ProviderCapabilities> {
  return provider.capabilities();
}

/** PUT the desired policy and grade the provider's own response for drift. */
export async function pushProviderPolicy(opts: {
  provider: BackupProvider;
  targetId: string;
  desired: ProviderPolicyDeclaration;
  checkedAt: string;
}): Promise<ProviderPolicySyncState> {
  const base = { desired: opts.desired, checkedAt: opts.checkedAt };
  try {
    const caps = await capabilities(opts.provider);
    if (!caps.capabilities.includes('policy') || !opts.provider.putPolicy) {
      return { ...base, status: 'unsupported' };
    }
    const echo = await opts.provider.putPolicy(opts.targetId, opts.desired);
    return {
      ...base,
      status: providerPolicyMatches(opts.desired, echo) ? 'synced' : 'drift',
      echo,
    };
  } catch (err) {
    return {
      ...base,
      status:
        err instanceof BackupProviderError && err.code === 'policy_unmet' ? 'rejected' : 'error',
      ...errorFields(err),
    };
  }
}

/** GET the current echo without mutating it; used by the weekly audit. */
export async function inspectProviderPolicy(opts: {
  provider: BackupProvider;
  targetId: string;
  desired: ProviderPolicyDeclaration;
  checkedAt: string;
}): Promise<ProviderPolicySyncState> {
  const base = { desired: opts.desired, checkedAt: opts.checkedAt };
  try {
    const caps = await capabilities(opts.provider);
    if (!caps.capabilities.includes('policy') || !opts.provider.getPolicy) {
      return { ...base, status: 'unsupported' };
    }
    const echo = await opts.provider.getPolicy(opts.targetId);
    return {
      ...base,
      status: providerPolicyMatches(opts.desired, echo) ? 'synced' : 'drift',
      echo,
    };
  } catch (err) {
    return { ...base, status: 'error', ...errorFields(err) };
  }
}

async function providerInventory(
  provider: BackupProvider,
  targetId: string,
  store: StoreClass,
): Promise<ProviderInventoryObject[]> {
  if (!provider.listInventory) throw new Error('provider does not implement inventory');
  const objects: ProviderInventoryObject[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await provider.listInventory(targetId, {
      store,
      ...(cursor ? { cursor } : {}),
      limit: 1000,
    });
    if (page.store !== store) {
      throw new Error(`provider returned ${page.store} inventory for ${store}`);
    }
    objects.push(...page.objects);
    if (!page.nextCursor) break;
    if (seen.has(page.nextCursor)) throw new Error('provider repeated an inventory cursor');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return objects;
}

async function bucketInventory(
  provider: BackupProvider,
  targetId: string,
  store: StoreClass,
): Promise<ProviderInventoryObject[]> {
  const data = await provider.openDataPlane(targetId, store, 'read');
  const objects: ProviderInventoryObject[] = [];
  for await (const row of data.list('')) {
    objects.push({
      key: row.key,
      sizeBytes: row.size,
      etagOrHash: row.etagOrHash ?? '',
      storedAt: row.storedAt ?? 0,
      ...(row.storageClass ? { storageClass: row.storageClass } : {}),
      state: 'live',
    });
  }
  return objects;
}

function liveObjects(
  objects: readonly ProviderInventoryObject[],
): Map<string, ProviderInventoryObject> {
  return new Map(objects.filter((row) => row.state === 'live').map((row) => [row.key, row]));
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((key) => !right.has(key)).sort();
}

function normalizedObjectHash(value: string): string {
  return value.trim().replace(/^"|"$/g, '').toLowerCase();
}

/**
 * A key-only comparison can bless a provider attestation that names the right
 * object but reports stale/corrupt bytes. Raw LIST is the independent source:
 * size must match and, when both surfaces expose an ETag/hash, so must that
 * identity. Missing hashes do not manufacture drift; the exact-byte verifier
 * remains the authority for stores that cannot expose one through LIST.
 */
function metadataMismatches(
  reported: Map<string, ProviderInventoryObject>,
  raw: Map<string, ProviderInventoryObject>,
): string[] {
  const mismatches: string[] = [];
  for (const [key, attested] of reported) {
    const listed = raw.get(key);
    if (!listed) continue;
    const attestedHash = normalizedObjectHash(attested.etagOrHash);
    const listedHash = normalizedObjectHash(listed.etagOrHash);
    if (
      attested.sizeBytes !== listed.sizeBytes ||
      (attestedHash.length > 0 && listedHash.length > 0 && attestedHash !== listedHash)
    ) {
      mismatches.push(key);
    }
  }
  return mismatches.sort();
}

/**
 * Scheduled mode prefers provider attestation and falls back to a raw read
 * grant. Explicit bucket mode always LISTs raw objects and, when supported,
 * cross-checks the provider's attestation in the same run.
 */
export async function collectInventory(opts: {
  provider: BackupProvider;
  targetId: string;
  store: StoreClass;
  verifyBucket: boolean;
}): Promise<CollectedInventory> {
  const caps = await capabilities(opts.provider);
  const attested = caps.capabilities.includes('inventory') && !!opts.provider.listInventory;
  if (opts.verifyBucket) {
    const raw = await bucketInventory(opts.provider, opts.targetId, opts.store);
    if (!attested) return { source: 'bucket', providerAttested: false, objects: raw };
    try {
      const reported = await providerInventory(opts.provider, opts.targetId, opts.store);
      const providerObjects = liveObjects(reported);
      const bucketObjects = liveObjects(raw);
      const providerKeys = new Set(providerObjects.keys());
      const bucketKeys = new Set(bucketObjects.keys());
      return {
        source: 'bucket',
        providerAttested: false,
        objects: raw,
        crossCheck: {
          providerOnly: difference(providerKeys, bucketKeys),
          bucketOnly: difference(bucketKeys, providerKeys),
          metadataMismatch: metadataMismatches(providerObjects, bucketObjects),
        },
      };
    } catch (err) {
      return {
        source: 'bucket',
        providerAttested: false,
        objects: raw,
        attestationError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (attested) {
    try {
      return {
        source: 'provider',
        providerAttested: true,
        objects: await providerInventory(opts.provider, opts.targetId, opts.store),
      };
    } catch (err) {
      return {
        source: 'bucket',
        providerAttested: false,
        objects: await bucketInventory(opts.provider, opts.targetId, opts.store),
        attestationError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return {
    source: 'bucket',
    providerAttested: false,
    objects: await bucketInventory(opts.provider, opts.targetId, opts.store),
  };
}

/** Collect the append-only audit feed, retaining only a bounded UI tail. */
export async function collectAudit(
  provider: BackupProvider,
  targetId: string,
): Promise<CollectedAudit> {
  try {
    const caps = await capabilities(provider);
    if (!caps.capabilities.includes('audit') || !provider.listEvents) {
      return { source: 'unavailable', eventCount: 0, recent: [] };
    }
    let eventCount = 0;
    let recent: ProviderAuditEvent[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await provider.listEvents(targetId, {
        ...(cursor ? { cursor } : {}),
        limit: 1000,
      });
      eventCount += page.events.length;
      recent = [...recent, ...page.events].slice(-50);
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor)) throw new Error('provider repeated an audit cursor');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return { source: 'provider', eventCount, recent };
  } catch (err) {
    return {
      source: 'unavailable',
      eventCount: 0,
      recent: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
