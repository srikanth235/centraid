import type { ConnectionKind, FetchPolicy } from "./policy";
import { defaultFetchPolicy } from "./policy";

export type FetchAccess = "granted" | "needs-choice";

export function fetchAccess(
  networkType: string | undefined,
  consented: boolean,
  policy: FetchPolicy = defaultFetchPolicy
): FetchAccess {
  if (consented) return "granted";
  const kind: ConnectionKind = policy.connectionKind(networkType);
  return kind === "metered" ? "needs-choice" : "granted";
}

export function isMeteredConnection(
  networkType: string | undefined,
  policy: FetchPolicy = defaultFetchPolicy
): boolean {
  return policy.connectionKind(networkType) === "metered";
}
