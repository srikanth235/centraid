import type { S3Grant, StoreClass } from "./provider.js";
import { callProviderRoute } from "./wire-client.js";
import type { WireClientOptions } from "./wire-client.js";

const DEFAULT_GRANT_TTL_SECONDS = 3600;

export interface RequestStorageGrantOptions extends WireClientOptions {
  targetId: string;
  store: StoreClass;
  mode: "read" | "read-write";
  ttlSeconds?: number;
}

export async function requestStorageGrant(
  opts: RequestStorageGrantOptions
): Promise<S3Grant> {
  return callProviderRoute<S3Grant>(
    opts,
    "POST",
    `/v1/storage/vaults/${encodeURIComponent(opts.targetId)}/credentials`,
    {
      ttlSeconds: opts.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS,
      mode: opts.mode,
      store: opts.store,
    }
  );
}

export type RequestCasGrantOptions = Omit<RequestStorageGrantOptions, "store">;

export async function requestCasGrant(
  opts: RequestCasGrantOptions
): Promise<S3Grant> {
  return requestStorageGrant({ ...opts, store: "cas" });
}

export type RequestDerivedGrantOptions = Omit<
  RequestStorageGrantOptions,
  "store"
>;

export async function requestDerivedGrant(
  opts: RequestDerivedGrantOptions
): Promise<S3Grant> {
  return requestStorageGrant({ ...opts, store: "derived" });
}
