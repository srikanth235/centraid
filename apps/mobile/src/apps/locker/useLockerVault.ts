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
