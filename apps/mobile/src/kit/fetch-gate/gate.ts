// The "may I fetch N bytes now?" answer: a policy-aware decision, with no
// opinion on UI. Generalised out of photos' `full-quality-gate.ts` so Docs'
// "available offline" pin fetch and Photos' "load the original" ask the same
// question through the same function.
//
// The answer is binary and stated, never silent: `needs-choice` means the
// caller must render the explicit-choice UI (see `FetchChoice.tsx`) and wait
// for a tap before spending the bytes — never a fetch that starts on its own
// because the caller "already knew" the connection was metered.

import type { ConnectionKind, FetchPolicy } from "./policy";
import { defaultFetchPolicy } from "./policy";

export type FetchAccess = "granted" | "needs-choice";

/**
 * `granted` means the fetch may start as soon as something asks for it.
 * `needs-choice` means the caller must hold off and show the explicit-choice
 * affordance until the member taps it.
 *
 * `consented` is the CALLER's state — per content ref, per session, exactly
 * how photos' viewer held one `fullQualityUnlocked` boolean next to the asset
 * identity so paging to a different photo asked again. This module has no
 * memory of its own on purpose: a shared "already asked" flag here would leak
 * consent across unrelated fetches (a Docs pin granting a Photos original, or
 * vice versa).
 */
export function fetchAccess(
  networkType: string | undefined,
  consented: boolean,
  policy: FetchPolicy = defaultFetchPolicy
): FetchAccess {
  if (consented) return "granted";
  const kind: ConnectionKind = policy.connectionKind(networkType);
  return kind === "metered" ? "needs-choice" : "granted";
}

/** Convenience predicate kept for call sites that only need a boolean. */
export function isMeteredConnection(
  networkType: string | undefined,
  policy: FetchPolicy = defaultFetchPolicy
): boolean {
  return policy.connectionKind(networkType) === "metered";
}
