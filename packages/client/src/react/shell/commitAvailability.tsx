import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

export const OFFLINE_COMMIT_REASON =
  "Offline · changes stay on this device and commits are disabled until the vault host is back";

export interface CommitAvailability {
  blocked: boolean;
  reason: string;
}

const AVAILABLE: CommitAvailability = { blocked: false, reason: "" };

const CommitAvailabilityContext = createContext<CommitAvailability>(AVAILABLE);

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

export function useCommitAvailability(): CommitAvailability {
  return useContext(CommitAvailabilityContext);
}

export function commitAvailabilityFor(
  gatewayStatus: "unknown" | "up" | "down" | undefined
): CommitAvailability {
  return gatewayStatus === "down"
    ? { blocked: true, reason: OFFLINE_COMMIT_REASON }
    : AVAILABLE;
}
