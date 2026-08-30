// The platform half of the frame camera-roll watcher; whether a sweep MAY run
// is `watcher.ts`. Mount this ONCE, at the frame root (#883).

import * as MediaLibrary from "expo-media-library";
import { useEffect } from "react";
import { AppState } from "react-native";

import { runCameraRollSweep, setCameraRollScope } from "./watcher";
import type { CameraRollScope } from "./watcher";

export function useCameraRollWatcher(scope: CameraRollScope | undefined): void {
  const session = scope?.session;
  const gatewayBase = scope?.gatewayBase;
  const vaultId = scope?.vaultId;
  useEffect(() => {
    if (!session || !gatewayBase) {
      setCameraRollScope(undefined);
      return undefined;
    }
    setCameraRollScope({
      session,
      gatewayBase,
      ...(vaultId ? { vaultId } : {}),
    });
    void runCameraRollSweep("app-start");
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void runCameraRollSweep("foreground");
    });
    const library = MediaLibrary.addListener(() => {
      void runCameraRollSweep("library-changed");
    });
    return () => {
      appState.remove();
      library.remove();
    };
  }, [session, gatewayBase, vaultId]);
}
