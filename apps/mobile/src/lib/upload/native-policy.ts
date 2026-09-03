import * as Battery from "expo-battery";
import * as Network from "expo-network";

import { getCellularRoamingStatus } from "../../../modules/centraid-network-status";
import { hydrateTransferPolicy } from "../../kit/transfer/transfer-policy";
import type { UploadPolicy } from "./uploader";

export const LAST_SUCCESSFUL_SYNC_KEY = "photos.lastSuccessfulSync";

export function nativeUploadPolicy(): UploadPolicy {
  return {
    async canTransfer() {
      const rules = await hydrateTransferPolicy();
      if (rules.never) return false;
      const network = await Network.getNetworkStateAsync();
      if (!network.isConnected) return false;
      if (rules.wifiOnly && network.type !== Network.NetworkStateType.WIFI)
        return false;
      if (
        !rules.wifiOnly &&
        !rules.allowMetered &&
        network.type === Network.NetworkStateType.CELLULAR
      )
        return false;
      if (
        !rules.wifiOnly &&
        rules.allowMetered &&
        !rules.allowRoaming &&
        network.type === Network.NetworkStateType.CELLULAR
      ) {
        const roaming = await getCellularRoamingStatus();
        if (roaming !== false) return false;
      }
      if (rules.chargerOnly) {
        const state = await Battery.getBatteryStateAsync();
        if (
          state !== Battery.BatteryState.CHARGING &&
          state !== Battery.BatteryState.FULL
        )
          return false;
      }
      return true;
    },
  };
}

export async function nativeSyncAllowed(): Promise<boolean> {
  return nativeUploadPolicy().canTransfer();
}

export async function nativeRowSyncAllowed(): Promise<boolean> {
  return !(await hydrateTransferPolicy()).never;
}
