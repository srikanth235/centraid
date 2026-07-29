import type { NativeModule } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

declare class CentraidStorageNativeModule extends NativeModule {
  replicaDirectory(): string;
  directorySize(path: string): number;
}

const native =
  requireOptionalNativeModule<CentraidStorageNativeModule>("CentraidStorage");

/**
 * Durable, backup-excluded, OS-protected replica directory.
 *
 * iOS: Application Support + NSURLIsExcludedFromBackupKey +
 * completeUntilFirstUserAuthentication. Android: credential-encrypted
 * noBackupFilesDir. Both survive cache eviction and are removed on uninstall.
 */
export function replicaStorageDirectory(): string | undefined {
  return native?.replicaDirectory();
}

export function nativeDirectorySize(path: string): number {
  return native?.directorySize(path) ?? 0;
}
