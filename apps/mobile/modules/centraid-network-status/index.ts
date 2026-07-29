import type { NativeModule } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

declare class CentraidNetworkStatusNativeModule extends NativeModule {
  isNetworkRoaming(): Promise<boolean | null>;
}

const native = requireOptionalNativeModule<CentraidNetworkStatusNativeModule>(
  "CentraidNetworkStatus"
);

/**
 * `null` means the OS does not expose a reliable roaming signal. The backup
 * policy treats that conservatively unless the user explicitly allows it.
 */
export async function getCellularRoamingStatus(): Promise<boolean | null> {
  return native ? native.isNetworkRoaming() : null;
}
