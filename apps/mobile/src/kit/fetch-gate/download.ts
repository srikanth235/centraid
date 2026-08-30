// The pin/download verb shared by Docs and Photos: pin → download → local
// read → eviction exemption. This file owns only that ORDER (#883).

import {
  enforceOfflineContentBudget,
  offlineContentUri,
  removeOfflineContent,
  storeOfflineContent,
  touchOfflineContent,
} from "./content-store";
import { fetchAccess } from "./gate";
import type { FetchAccess } from "./gate";
import { isPinned, pinContent, unpinContent } from "./pin";
import type { ContentRef } from "./pin";
import type { FetchPolicy } from "./policy";

export type OfflineContentOutcome =
  | { status: "stored"; uri: string; pinned: boolean }
  /** Metered, unanswered: never a fetch that starts itself. */
  | { status: "needs-choice" }
  | { status: "unavailable"; reason: string };

export const OFFLINE_UNREACHABLE_REASON =
  "These bytes are not on this phone and the gateway is out of reach.";
export const OFFLINE_FETCH_FAILED_REASON =
  "The gateway did not hand these bytes over, so they are not on this phone.";
export const OFFLINE_NO_STORAGE_REASON =
  "This phone has no durable place to keep offline bytes, so nothing was saved.";

export interface EnsureOfflineContentInput {
  ref: ContentRef;
  url: string | null;
  headers: Record<string, string>;
  networkType?: string;
  consented?: boolean;
  pin?: boolean;
  online?: boolean;
  policy?: FetchPolicy;
  budgetBytes?: number;
}

/** Local bytes first: asking the gate before disk spends the pin. */
export async function ensureOfflineContent(
  input: EnsureOfflineContentInput
): Promise<OfflineContentOutcome> {
  const { ref } = input;
  if (input.pin && !isPinned(ref)) pinContent(ref);
  const pinned = isPinned(ref);

  const local = offlineContentUri(ref);
  if (local) {
    touchOfflineContent(ref);
    return { status: "stored", uri: local, pinned };
  }

  if (input.online === false || !input.url)
    return { status: "unavailable", reason: OFFLINE_UNREACHABLE_REASON };

  const access: FetchAccess = fetchAccess(
    input.networkType,
    input.consented ?? false,
    input.policy
  );
  if (access === "needs-choice") return { status: "needs-choice" };

  const stored = await storeOfflineContent(ref, input.url, input.headers);
  if (!stored) {
    return {
      status: "unavailable",
      reason: OFFLINE_FETCH_FAILED_REASON,
    };
  }
  // Never selects a pin; may evict this download when unpinned.
  enforceOfflineContentBudget(input.budgetBytes);
  const settled = offlineContentUri(ref);
  return settled
    ? { status: "stored", uri: settled, pinned }
    : { status: "unavailable", reason: OFFLINE_NO_STORAGE_REASON };
}

/** The bytes go with the pin — a cache the member cannot see is not one. */
export function releaseOfflineContent(ref: ContentRef): void {
  unpinContent(ref);
  removeOfflineContent(ref);
}
