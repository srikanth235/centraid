// The standing sentence on the shell's one status line (issue #707,
// invariant 5) — extracted from App so the rule can be read, and tested,
// without mounting the whole shell.
//
// The reachability half of it used to be a two-way ternary: "up" said "Synced"
// and EVERYTHING ELSE said "Ready". That made the line lie in the one state
// where the shell knows least. "unknown" is not a short blip on the web host —
// an Iroh dial times out at 15s and is tried three times with backoff, so the
// window is roughly half a minute — and for all of it a member reading "Ready"
// was being told an affirmative thing about a gateway we had not reached.
// Worse, it is the same word the line shows when everything is fine but idle,
// so the state that most needs to be visible was the state that looked normal.
//
// Three statuses, three sentences. Saying "Checking…" costs nothing when the
// probe comes back in 200ms and is the truth when it does not.
import { OFFLINE_COMMIT_REASON } from "./commitAvailability.js";

export interface AmbientStatusInput {
  /** The heartbeat monitor's verdict; `undefined` before the first read. */
  gatewayStatus: "unknown" | "up" | "down" | undefined;
  /** Approvals waiting on a human decision. */
  blockingCount: number;
  /** Unread notices in the inbox. */
  hasUnreadNotices: boolean;
}

/**
 * What the line says when nothing transient is showing.
 *
 * Work waiting on the member outranks reachability: a decision does not stop
 * being waiting because the gateway is slow to answer, and it is the one of the
 * three a member can act on.
 */
export function ambientStatusFor(input: AmbientStatusInput): string {
  const { blockingCount, gatewayStatus, hasUnreadNotices } = input;
  if (blockingCount > 0)
    return `${blockingCount} ${blockingCount === 1 ? "decision" : "decisions"} waiting on you`;
  if (hasUnreadNotices) return "New notices to read";
  if (gatewayStatus === "up") return "Synced";
  // The same sentence the offline banner and a refused commit control carry —
  // one condition, one explanation.
  if (gatewayStatus === "down") return OFFLINE_COMMIT_REASON;
  return "Checking…";
}
