import type { NativeModule } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

declare class CentraidNetworkStatusNativeModule extends NativeModule {
  isNetworkRoaming(): Promise<boolean | null>;
}

const native = requireOptionalNativeModule<CentraidNetworkStatusNativeModule>(
  "CentraidNetworkStatus"
);

export async function getCellularRoamingStatus(): Promise<boolean | null> {
  return native ? native.isNetworkRoaming() : null;
}
