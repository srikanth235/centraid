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

/** URI form, for `expo-file-system`. It throws `URI is not absolute` on the
 *  path form, which is what op-sqlite and the sizer take (#905). */
export function replicaStorageDirectoryUri(): string | undefined {
  const path = replicaStorageDirectory();
  return path === undefined ? undefined : pathToFileUri(path);
}

export function pathToFileUri(path: string): string {
  return path.startsWith("/") ? `file://${path}` : path;
}

/** Bytes under `path` in one crossing; `undefined` means the module is
 *  unlinked, NOT an empty directory — callers fall back to a JS walk. */
export function nativeDirectorySize(path: string): number | undefined {
  return native?.directorySize(path);
}
