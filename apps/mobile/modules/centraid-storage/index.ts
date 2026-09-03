import type { NativeModule } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

declare class CentraidStorageNativeModule extends NativeModule {
  replicaDirectory(): string;
  directorySize(path: string): number;
}

const native =
  requireOptionalNativeModule<CentraidStorageNativeModule>("CentraidStorage");

export function replicaStorageDirectory(): string | undefined {
  return native?.replicaDirectory();
}

export function replicaStorageDirectoryUri(): string | undefined {
  const path = replicaStorageDirectory();
  return path === undefined ? undefined : pathToFileUri(path);
}

export function pathToFileUri(path: string): string {
  return path.startsWith("/") ? `file://${path}` : path;
}

export function nativeDirectorySize(path: string): number | undefined {
  return native?.directorySize(path);
}
