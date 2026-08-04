// Whether a commit control may commit right now (issue #708, C7).
//
// The status line already knows the shell is offline and says why (#707). What
// it could not do was stop the buttons: every screen would have had to learn
// the gateway's status itself and reimplement the same refusal, which is how a
// product ends up with eleven slightly different ways of being offline.
//
// So the verdict travels once, in context, and the KIT'S COMMIT CONTROL reads
// it — `ui/Button.tsx`, the one filled-ink primary. A screen that uses the
// shared Button gets the behaviour for free and cannot get it wrong; a screen
// that wants to refuse for its own reason passes `disabled` as before.
//
// The reason is shared with the status line rather than re-typed, so the
// sentence a reader sees on the line is the sentence the refused control
// quotes back.
import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

/**
 * The one offline sentence. The status line prints it; a refused commit
 * control carries it as its accessible description. One string, so they can
 * never drift into two different explanations of the same condition.
 */
export const OFFLINE_COMMIT_REASON =
  "Offline · changes stay on this device and commits are disabled until the gateway is back";

export interface CommitAvailability {
  /** Commits are refused right now. */
  blocked: boolean;
  /** Why, in the reader's words. Empty string when nothing is blocked. */
  reason: string;
}

const AVAILABLE: CommitAvailability = { blocked: false, reason: "" };

const CommitAvailabilityContext = createContext<CommitAvailability>(AVAILABLE);

/**
 * Wraps the shell. Anything rendered inside — routes, dialogs, sheets — can
 * ask whether a commit would be accepted without knowing what a gateway is.
 */
export function CommitAvailabilityProvider({
  value,
  children,
}: {
  value: CommitAvailability;
  children: ReactNode;
}): JSX.Element {
  return (
    <CommitAvailabilityContext.Provider value={value}>
      {children}
    </CommitAvailabilityContext.Provider>
  );
}

/** The current verdict. Outside a provider, commits are allowed — the default
 *  must never be "refuse", or an unmounted test would look like an outage. */
export function useCommitAvailability(): CommitAvailability {
  return useContext(CommitAvailabilityContext);
}

/** The verdict for one gateway status, so App and its tests agree on the rule. */
export function commitAvailabilityFor(
  gatewayStatus: "unknown" | "up" | "down" | undefined
): CommitAvailability {
  // Only a KNOWN outage refuses. "unknown" is the boot window, and refusing
  // every commit for the first few hundred milliseconds of every launch would
  // be a worse lie than letting one write fail loudly.
  return gatewayStatus === "down"
    ? { blocked: true, reason: OFFLINE_COMMIT_REASON }
    : AVAILABLE;
}
