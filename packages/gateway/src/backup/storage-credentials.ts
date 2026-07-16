/*
 * The `s3Credentials` resolver every mounted vault's remote blob tier calls
 * on each use (issue #367 §C3) — bridges `BlobStoreSettings.connectionId` to
 * a live `StorageConnectionStore` row:
 *
 *   - `byo-s3`   resolves the sealed sidecar directly — cheap, no network.
 *   - `provider` resolves a short-lived `requestCasGrant`
 *     (`centraid-storage-provider/1`, packages/backup/PROTOCOL.md § Layer 1),
 *     cached per connection until near expiry so a busy replication sweep
 *     doesn't mint a fresh grant on every blob.
 */

import {
  openRemoteBackupProvider,
  requestCasGrant,
  requestDerivedGrant,
  requestStorageGrant,
  type S3Grant,
} from '@centraid/backup';
import type { BlobStoreSettings, S3Credentials } from '@centraid/vault';
import type { StorageConnectionStore } from './storage-connections.js';
import { opaqueLabel } from './backup-state.js';

/** Refresh a cached grant this long before it actually expires. */
const GRANT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedGrant {
  grant: S3Grant;
}

/**
 * Builds the resolver `VaultRegistryOptions.s3Credentials` wants. One
 * instance is shared across every mounted vault (the grant cache is keyed
 * by `connectionId`, so N vaults pointed at the same provider connection
 * share one live grant instead of each minting their own).
 */
export function makeStorageCredentialsResolver(
  store: StorageConnectionStore,
): (settings: BlobStoreSettings, storeClass?: 'cas' | 'derived') => Promise<S3Credentials> {
  // Keyed by `${connectionId}:${store}` (issue #425 Wave 2): a provider may
  // issue per-store-scoped credentials, so cas and derived grants cache apart.
  const grantCache = new Map<string, CachedGrant>();

  return async (
    settings: BlobStoreSettings,
    storeClass: 'cas' | 'derived' = 'cas',
  ): Promise<S3Credentials> => {
    const connectionId = settings.connectionId;
    if (!connectionId) {
      throw new Error(
        'blob_store.connectionId is not set — attach a storage connection before enabling the s3 tier (issue #367)',
      );
    }
    const kind = await store.kindOf(connectionId);
    if (kind === 'byo-s3') {
      // Own-S3 uses one credential for the whole bucket; the store class only
      // changes the key prefix, not the grant.
      return store.resolveS3Credentials(connectionId);
    }
    if (kind === 'provider') {
      const cacheKey = `${connectionId}:${storeClass}`;
      const cached = grantCache.get(cacheKey);
      if (cached && cached.grant.expiresAt * 1000 - Date.now() > GRANT_REFRESH_MARGIN_MS) {
        return toCredentials(cached.grant);
      }
      const connection = await store.get(connectionId);
      if (!connection?.targetId || !connection.baseUrl) {
        throw new Error(
          `storage connection "${connectionId}" has no provider target yet — the CAS-attach route must create one before this resolves`,
        );
      }
      const apiKey = await store.resolveProviderApiKey(connectionId);
      const grant = await requestStorageGrant({
        baseUrl: connection.baseUrl,
        apiKey,
        targetId: connection.targetId,
        store: storeClass,
        mode: 'read-write',
      });
      grantCache.set(cacheKey, { grant });
      return toCredentials(grant);
    }
    throw new Error(`unknown storage connection "${connectionId}"`);
  };
}

function toCredentials(grant: S3Grant): S3Credentials {
  return {
    accessKeyId: grant.accessKeyId,
    secretAccessKey: grant.secretAccessKey,
    ...(grant.sessionToken ? { sessionToken: grant.sessionToken } : {}),
  };
}

/**
 * Ensure a `provider`-kind connection has a Layer-1 target
 * (`POST /v1/backup/vaults`, PROTOCOL.md), then request one `cas` grant just
 * to learn `{endpoint, region, bucket, prefix}` — those are stable per
 * target+store (only credentials/expiry rotate on later grants), so the
 * CAS-attach route (`vault-routes.ts`) can denormalize them into the vault's
 * `blob_store` settings once, up front, instead of every mounted vault
 * re-deriving them from a grant on first use.
 */
export async function ensureProviderCasTarget(
  store: StorageConnectionStore,
  connectionId: string,
): Promise<{
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  /** The `derived` store prefix, present iff the provider advertises + grants it. */
  derivedPrefix?: string;
  /**
   * Storage classes the provider declared it accepts (issue #425 Wave 3),
   * learned from the same discovery document. Present iff discovery advertised a
   * non-empty list; the vault's direct-to-cold heuristic only engages when this
   * includes `STANDARD_IA`.
   */
  supportedStorageClasses?: string[];
}> {
  const connection = await store.get(connectionId);
  if (!connection || connection.kind !== 'provider' || !connection.baseUrl) {
    throw new Error(`connection "${connectionId}" is not a provider connection`);
  }
  const apiKey = await store.resolveProviderApiKey(connectionId);
  const provider = openRemoteBackupProvider({ baseUrl: connection.baseUrl, apiKey });
  let targetId = connection.targetId;
  if (!targetId) {
    const target = await provider.createTarget({ label: opaqueLabel() });
    targetId = target.targetId;
    await store.setTargetId(connectionId, targetId);
  }
  const grant = await requestCasGrant({
    baseUrl: connection.baseUrl,
    apiKey,
    targetId,
    mode: 'read-write',
  });
  // The `derived` store is opt-in per provider (issue #425 Wave 2): only learn +
  // stamp its prefix when discovery advertises the capability. A request for an
  // unadvertised store is a 400, so gate strictly on the discovery document.
  let derivedPrefix: string | undefined;
  const capabilities = await provider.capabilities().catch(() => undefined);
  if (capabilities?.capabilities.includes('derived')) {
    const derivedGrant = await requestDerivedGrant({
      baseUrl: connection.baseUrl,
      apiKey,
      targetId,
      mode: 'read-write',
    });
    derivedPrefix = derivedGrant.prefix;
  }
  // The declared storage-class list (issue #425 Wave 3) rides the SAME discovery
  // document; stamp it so the vault heuristic knows whether STANDARD_IA is safe.
  const supportedStorageClasses =
    capabilities?.storageClasses && capabilities.storageClasses.length > 0
      ? capabilities.storageClasses
      : undefined;
  return {
    endpoint: grant.endpoint,
    region: grant.region,
    bucket: grant.bucket,
    prefix: grant.prefix,
    ...(derivedPrefix ? { derivedPrefix } : {}),
    ...(supportedStorageClasses ? { supportedStorageClasses } : {}),
  };
}
