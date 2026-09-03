import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import {
  onLockerAppState,
  openLocker,
  readLockerVault,
  subscribeLockerVault,
} from "./locker-store";
import type { LockerVaultState } from "./locker-store";

export function useLockerVault(): LockerVaultState {
  return useSyncExternalStore(
    subscribeLockerVault,
    readLockerVault,
    readLockerVault
  );
}

/**
 * The frame's own effects. Called exactly once per mounted Locker frame:
 * the status read on arrival, and the hide → lock subscription for as long as
 * a Locker surface is on screen.
 *
 * The status read is idempotent by design — it asks the gateway whether a
 * passphrase exists, which is a fact about the vault rather than a session —
 * so a second Locker screen pushed onto the stack costs one extra read and
 * never disturbs an open session.
 */
export function useLockerBoundary(): void {
  useEffect(() => {
    void openLocker();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      onLockerAppState(next);
    });
    return () => subscription.remove();
  }, []);
}
