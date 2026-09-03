import { BackupProviderError } from "@centraid/backup";
import type {
  BackupProvider,
  ProviderAuditEvent,
  ProviderCapabilities,
  ProviderInventoryObject,
  ProviderPolicy,
  ProviderPolicyDeclaration,
  StoreClass,
} from "@centraid/backup";
import type { BackupPolicy } from "@centraid/vault";

export type ProviderPolicySyncStatus =
  | "pending"
  | "synced"
  | "drift"
  | "rejected"
  | "unsupported"
  | "error";

export interface ProviderPolicySyncState {
  status: ProviderPolicySyncStatus;
  desired: ProviderPolicyDeclaration;
  checkedAt: string;
  echo?: ProviderPolicy;
  error?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export type InventorySource = "provider" | "bucket";

export interface CollectedInventory {
  source: InventorySource;
  providerAttested: boolean;
  objects: ProviderInventoryObject[];
  attestationError?: string;
  crossCheck?: {
    providerOnly: string[];
    bucketOnly: string[];
    metadataMismatch: string[];
  };
}

export interface CollectedAudit {
  source: "provider" | "unavailable";
  eventCount: number;
  recent: ProviderAuditEvent[];
  error?: string;
}

export function providerPolicyFor(
  policy: BackupPolicy
): ProviderPolicyDeclaration {
  return {
    rpoSeconds: policy.rpoSeconds,
    snapshotIntervalHours: policy.snapshotIntervalHours,
    verifyEveryDays: policy.verifyEveryDays,
    casAck: policy.casAck,
  };
}

export function providerPolicyMatches(
  desired: ProviderPolicyDeclaration,
  echo: ProviderPolicyDeclaration
): boolean {
  return (
    desired.rpoSeconds === echo.rpoSeconds &&
    desired.snapshotIntervalHours === echo.snapshotIntervalHours &&
    desired.verifyEveryDays === echo.verifyEveryDays &&
    desired.casAck === echo.casAck
  );
}

function errorFields(
  err: unknown
): Pick<ProviderPolicySyncState, "error" | "errorCode" | "details"> {
  const error = err instanceof Error ? err.message : String(err);
  if (!(err instanceof BackupProviderError)) return { error };
  return {
    error,
    errorCode: err.code,
    ...(err.details ? { details: err.details } : {}),
  };
}

async function capabilities(
  provider: BackupProvider
): Promise<ProviderCapabilities> {
  return provider.capabilities();
}

export async function pushProviderPolicy(opts: {
  provider: BackupProvider;
  targetId: string;
  desired: ProviderPolicyDeclaration;
  checkedAt: string;
}): Promise<ProviderPolicySyncState> {
  const base = { desired: opts.desired, checkedAt: opts.checkedAt };
  try {
    const caps = await capabilities(opts.provider);
    if (!caps.capabilities.includes("policy") || !opts.provider.putPolicy) {
      return { ...base, status: "unsupported" };
    }
    const echo = await opts.provider.putPolicy(opts.targetId, opts.desired);
    return {
      ...base,
      status: providerPolicyMatches(opts.desired, echo) ? "synced" : "drift",
      echo,
    };
  } catch (error) {
    return {
      ...base,
      status:
        error instanceof BackupProviderError && error.code === "policy_unmet"
          ? "rejected"
          : "error",
      ...errorFields(error),
    };
  }
}

export async function inspectProviderPolicy(opts: {
  provider: BackupProvider;
  targetId: string;
  desired: ProviderPolicyDeclaration;
  checkedAt: string;
}): Promise<ProviderPolicySyncState> {
  const base = { desired: opts.desired, checkedAt: opts.checkedAt };
  try {
    const caps = await capabilities(opts.provider);
    if (!caps.capabilities.includes("policy") || !opts.provider.getPolicy) {
      return { ...base, status: "unsupported" };
    }
    const echo = await opts.provider.getPolicy(opts.targetId);
    return {
      ...base,
      status: providerPolicyMatches(opts.desired, echo) ? "synced" : "drift",
      echo,
    };
  } catch (error) {
    return { ...base, status: "error", ...errorFields(error) };
  }
}

async function providerInventory(
  provider: BackupProvider,
  targetId: string,
  store: StoreClass
): Promise<ProviderInventoryObject[]> {
  const listInventory = provider.listInventory;
  if (!listInventory) throw new Error("provider does not implement inventory");
  const objects: ProviderInventoryObject[] = [];
  const seen = new Set<string>();
  const readPage = async (cursor?: string): Promise<void> => {
    const page = await listInventory(targetId, {
      store,
      ...(cursor ? { cursor } : {}),
      limit: 1000,
    });
    if (page.store !== store) {
      throw new Error(`provider returned ${page.store} inventory for ${store}`);
    }
    objects.push(...page.objects);
    if (!page.nextCursor) return;
    if (seen.has(page.nextCursor))
      throw new Error("provider repeated an inventory cursor");
    seen.add(page.nextCursor);
    return readPage(page.nextCursor);
  };
  await readPage();
  return objects;
}

async function bucketInventory(
  provider: BackupProvider,
  targetId: string,
  store: StoreClass
): Promise<ProviderInventoryObject[]> {
  const data = await provider.openDataPlane(targetId, store, "read");
  const objects: ProviderInventoryObject[] = [];
  for await (const row of data.list("")) {
    objects.push({
      key: row.key,
      sizeBytes: row.size,
      etagOrHash: row.etagOrHash ?? "",
      storedAt: row.storedAt ?? 0,
      ...(row.storageClass ? { storageClass: row.storageClass } : {}),
      state: "live",
    });
  }
  return objects;
}

function liveObjects(
  objects: readonly ProviderInventoryObject[]
): Map<string, ProviderInventoryObject> {
  return new Map(
    objects.filter((row) => row.state === "live").map((row) => [row.key, row])
  );
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((key) => !right.has(key)).sort();
}

function normalizedObjectHash(value: string): string {
  return value.trim().replace(/^"|"$/gu, "").toLowerCase();
}

function metadataMismatches(
  reported: Map<string, ProviderInventoryObject>,
  raw: Map<string, ProviderInventoryObject>
): string[] {
  const mismatches: string[] = [];
  for (const [key, attested] of reported) {
    const listed = raw.get(key);
    if (!listed) continue;
    const attestedHash = normalizedObjectHash(attested.etagOrHash);
    const listedHash = normalizedObjectHash(listed.etagOrHash);
    if (
      attested.sizeBytes !== listed.sizeBytes ||
      (attestedHash.length > 0 &&
        listedHash.length > 0 &&
        attestedHash !== listedHash)
    ) {
      mismatches.push(key);
    }
  }
  return mismatches.sort();
}

export async function collectInventory(opts: {
  provider: BackupProvider;
  targetId: string;
  store: StoreClass;
  verifyBucket: boolean;
}): Promise<CollectedInventory> {
  const caps = await capabilities(opts.provider);
  const attested =
    caps.capabilities.includes("inventory") && !!opts.provider.listInventory;
  if (opts.verifyBucket) {
    const raw = await bucketInventory(opts.provider, opts.targetId, opts.store);
    if (!attested)
      return { source: "bucket", providerAttested: false, objects: raw };
    try {
      const reported = await providerInventory(
        opts.provider,
        opts.targetId,
        opts.store
      );
      const providerObjects = liveObjects(reported);
      const bucketObjects = liveObjects(raw);
      const providerKeys = new Set(providerObjects.keys());
      const bucketKeys = new Set(bucketObjects.keys());
      return {
        source: "bucket",
        providerAttested: false,
        objects: raw,
        crossCheck: {
          providerOnly: difference(providerKeys, bucketKeys),
          bucketOnly: difference(bucketKeys, providerKeys),
          metadataMismatch: metadataMismatches(providerObjects, bucketObjects),
        },
      };
    } catch (error) {
      return {
        source: "bucket",
        providerAttested: false,
        objects: raw,
        attestationError:
          error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (attested) {
    try {
      return {
        source: "provider",
        providerAttested: true,
        objects: await providerInventory(
          opts.provider,
          opts.targetId,
          opts.store
        ),
      };
    } catch (error) {
      return {
        source: "bucket",
        providerAttested: false,
        objects: await bucketInventory(
          opts.provider,
          opts.targetId,
          opts.store
        ),
        attestationError:
          error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    source: "bucket",
    providerAttested: false,
    objects: await bucketInventory(opts.provider, opts.targetId, opts.store),
  };
}

export async function collectAudit(
  provider: BackupProvider,
  targetId: string
): Promise<CollectedAudit> {
  try {
    const caps = await capabilities(provider);
    const listEvents = provider.listEvents;
    if (!caps.capabilities.includes("audit") || !listEvents) {
      return { source: "unavailable", eventCount: 0, recent: [] };
    }
    let eventCount = 0;
    let recent: ProviderAuditEvent[] = [];
    const seen = new Set<string>();
    const readPage = async (cursor?: string): Promise<void> => {
      const page = await listEvents(targetId, {
        ...(cursor ? { cursor } : {}),
        limit: 1000,
      });
      eventCount += page.events.length;
      recent = [...recent, ...page.events].slice(-50);
      if (!page.nextCursor) return;
      if (seen.has(page.nextCursor))
        throw new Error("provider repeated an audit cursor");
      seen.add(page.nextCursor);
      return readPage(page.nextCursor);
    };
    await readPage();
    return { source: "provider", eventCount, recent };
  } catch (error) {
    return {
      source: "unavailable",
      eventCount: 0,
      recent: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
