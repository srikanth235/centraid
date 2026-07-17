/*
 * The `s3Credentials` resolver every mounted vault's remote blob tier calls
 * on each use (issue #367 §C3) — bridges `BlobStoreSettings.connectionId` to
 * a live `StorageConnectionStore` row. Every connection is a provider
 * connection now (#436 §2): resolution is always a short-lived
 * `requestCasGrant` (`centraid-storage-provider/1`, packages/backup/PROTOCOL.md
 * § Layer 1), cached per connection until near expiry so a busy replication
 * sweep doesn't mint a fresh grant on every blob.
 */

import {
  HOME_PROFILE_CAPABILITIES,
  openRemoteBackupProvider,
  requestCasGrant,
  requestDerivedGrant,
  requestStorageGrant,
  type ProviderCapabilityFlag,
  type ProviderProfile,
  type S3Grant,
} from '@centraid/backup';
import type { BlobStoreSettings, S3Credentials } from '@centraid/vault';
import { StorageConnectionError, type StorageConnectionStore } from './storage-connections.js';
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
    const cacheKey = `${connectionId}:${storeClass}`;
    const cached = grantCache.get(cacheKey);
    if (cached && cached.grant.expiresAt * 1000 - Date.now() > GRANT_REFRESH_MARGIN_MS) {
      return toCredentials(cached.grant);
    }
    const connection = await store.get(connectionId);
    if (!connection) throw new Error(`unknown storage connection "${connectionId}"`);
    if (!connection.targetId || !connection.baseUrl) {
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
  };
}

/**
 * Home-profile status of a provider (issue #436 §1) — read from the discovery
 * document (`GET /v1/storage/provider`, PROTOCOL.md § Profiles). A connection
 * may only be created/attached against a provider that advertises the `home`
 * profile, i.e. a full managed household home carrying all of
 * `HOME_PROFILE_CAPABILITIES`. Surfaced whole (not just a boolean) so the Test
 * action can show exactly which capabilities a non-home provider is missing.
 */
export interface ProviderProfileStatus {
  profiles: ProviderProfile[];
  isHome: boolean;
  /** Home capabilities the provider does NOT declare — empty iff `isHome`. */
  missingCapabilities: ProviderCapabilityFlag[];
}

/** Fetch and evaluate a provider's home-profile status. Pure read — no target
 *  is minted. `fetchImpl` lets tests point at an in-process fake provider. */
export async function fetchProviderProfileStatus(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<ProviderProfileStatus> {
  const provider = openRemoteBackupProvider({
    baseUrl,
    apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const caps = await provider.capabilities();
  const profiles = caps.profiles ?? [];
  const isHome = profiles.includes('home');
  const declared = new Set<ProviderCapabilityFlag>(caps.capabilities);
  const missingCapabilities = HOME_PROFILE_CAPABILITIES.filter((c) => !declared.has(c));
  return { profiles, isHome, missingCapabilities };
}

/**
 * Assert a provider advertises the `home` profile, throwing a typed
 * `StorageConnectionError('provider_not_home_profile', …)` otherwise (issue
 * #436 §1). Returns the status on success so a caller (the Test action) can
 * still surface it.
 */
export async function assertProviderHomeProfile(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<ProviderProfileStatus> {
  const status = await fetchProviderProfileStatus(baseUrl, apiKey, fetchImpl);
  if (!status.isHome) {
    const missing =
      status.missingCapabilities.length > 0
        ? ` (missing ${status.missingCapabilities.join(', ')})`
        : '';
    throw new StorageConnectionError(
      'provider_not_home_profile',
      `this provider does not advertise the "home" profile${missing} — a Centraid home connection ` +
        'requires a provider that carries the full home bundle (snapshots, cas, derived, usage, ' +
        'policy, inventory, audit)',
    );
  }
  return status;
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
 * (`POST /v1/storage/vaults`, PROTOCOL.md), then request one `cas` grant just
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
