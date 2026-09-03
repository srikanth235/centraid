import {
  HOME_PROFILE_CAPABILITIES,
  openRemoteBackupProvider,
  requestCasGrant,
  requestDerivedGrant,
  requestStorageGrant,
} from "@centraid/backup";
import type {
  ProviderCapabilityFlag,
  ProviderProfile,
  S3Grant,
} from "@centraid/backup";
import type { BlobStoreSettings, S3Credentials } from "@centraid/vault";

import { opaqueLabel } from "./backup-state.js";
import { StorageConnectionError } from "./storage-connections.js";
import type { StorageConnectionStore } from "./storage-connections.js";

const GRANT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedGrant {
  grant: S3Grant;
}

export function makeStorageCredentialsResolver(
  store: StorageConnectionStore
): (
  settings: BlobStoreSettings,
  storeClass?: "cas" | "derived"
) => Promise<S3Credentials> {
  const grantCache = new Map<string, CachedGrant>();

  return async (
    settings: BlobStoreSettings,
    storeClass: "cas" | "derived" = "cas"
  ): Promise<S3Credentials> => {
    const connectionId = settings.connectionId;
    if (!connectionId) {
      throw new Error(
        "blob_store.connectionId is not set — attach a storage connection before enabling the s3 tier (issue #367)"
      );
    }
    const cacheKey = `${connectionId}:${storeClass}`;
    const cached = grantCache.get(cacheKey);
    if (
      cached &&
      cached.grant.expiresAt * 1000 - Date.now() > GRANT_REFRESH_MARGIN_MS
    ) {
      return toCredentials(cached.grant);
    }
    const connection = await store.get(connectionId);
    if (!connection)
      throw new Error(`unknown storage connection "${connectionId}"`);
    if (!connection.targetId || !connection.baseUrl) {
      throw new Error(
        `storage connection "${connectionId}" has no provider target yet — the CAS-attach route must create one before this resolves`
      );
    }
    const apiKey = await store.resolveProviderApiKey(connectionId);
    const grant = await requestStorageGrant({
      baseUrl: connection.baseUrl,
      apiKey,
      targetId: connection.targetId,
      store: storeClass,
      mode: "read-write",
    });
    grantCache.set(cacheKey, { grant });
    return toCredentials(grant);
  };
}

export interface ProviderProfileStatus {
  profiles: ProviderProfile[];
  isHome: boolean;
  missingCapabilities: ProviderCapabilityFlag[];
}

export async function fetchProviderProfileStatus(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch
): Promise<ProviderProfileStatus> {
  const provider = openRemoteBackupProvider({
    baseUrl,
    apiKey,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const caps = await provider.capabilities();
  const profiles = caps.profiles ?? [];
  const isHome = profiles.includes("home");
  const declared = new Set<ProviderCapabilityFlag>(caps.capabilities);
  const missingCapabilities = HOME_PROFILE_CAPABILITIES.filter(
    (c) => !declared.has(c)
  );
  return { profiles, isHome, missingCapabilities };
}

export async function assertProviderHomeProfile(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch
): Promise<ProviderProfileStatus> {
  const status = await fetchProviderProfileStatus(baseUrl, apiKey, fetchImpl);
  if (!status.isHome) {
    const missing =
      status.missingCapabilities.length > 0
        ? ` (missing ${status.missingCapabilities.join(", ")})`
        : "";
    throw new StorageConnectionError(
      "provider_not_home_profile",
      `this provider does not advertise the "home" profile${missing} — a Centraid home connection ` +
        "requires a provider that carries the full home bundle (snapshots, cas, derived, usage, " +
        "policy, inventory, audit)"
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

export async function ensureProviderCasTarget(
  store: StorageConnectionStore,
  connectionId: string
): Promise<{
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  derivedPrefix?: string;
  supportedStorageClasses?: string[];
}> {
  const connection = await store.get(connectionId);
  if (!connection || connection.kind !== "provider" || !connection.baseUrl) {
    throw new Error(
      `connection "${connectionId}" is not a provider connection`
    );
  }
  const apiKey = await store.resolveProviderApiKey(connectionId);
  const provider = openRemoteBackupProvider({
    baseUrl: connection.baseUrl,
    apiKey,
  });
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
    mode: "read-write",
  });
  let derivedPrefix: string | undefined;
  const capabilities = await provider.capabilities().catch(() => undefined);
  if (capabilities?.capabilities.includes("derived")) {
    const derivedGrant = await requestDerivedGrant({
      baseUrl: connection.baseUrl,
      apiKey,
      targetId,
      mode: "read-write",
    });
    derivedPrefix = derivedGrant.prefix;
  }
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
