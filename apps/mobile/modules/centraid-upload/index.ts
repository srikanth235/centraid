import type { NativeModule } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

declare class CentraidUploadNativeModule extends NativeModule {
  start(total: number): void;
  update(completed: number, total: number): void;
  stop(): void;
}

/**
 * The Android upload foreground service.
 *
 * Android-only: the module declares `platforms: ["android"]`, so this is
 * `undefined` on iOS (where the OS runs the drain under a background task
 * instead) and in any JS-only environment. Callers go through
 * `src/lib/upload/foreground-service.ts`, which owns the refcount that keeps
 * concurrent producers from tearing the service down under one another.
 */
export const nativeUploadForeground =
  requireOptionalNativeModule<CentraidUploadNativeModule>(
    "CentraidUploadForeground"
  );
