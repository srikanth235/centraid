import { useEffect, useSyncExternalStore } from "react";

import { openTally, readTallyVault, subscribeTallyVault } from "./tally-store";
import type { TallyVaultState } from "./tally-store";

export function useTallyVault(): TallyVaultState {
  return useSyncExternalStore(
    subscribeTallyVault,
    readTallyVault,
    readTallyVault
  );
}

export function useTallySpine(): void {
  useEffect(() => {
    void openTally();
  }, []);
}
