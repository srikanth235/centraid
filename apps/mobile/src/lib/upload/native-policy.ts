import * as Battery from "expo-battery";
import * as Network from "expo-network";

import { getCellularRoamingStatus } from "../../../modules/centraid-network-status";
import { Store } from "../../storage";
import type { UploadPolicy } from "./uploader";

const RULES_KEY = "photos.backupRules";
interface TransferRules {
  wifiOnly: boolean;
  allowMetered: boolean;
  allowRoaming: boolean;
  chargerOnly: boolean;
}

export const LAST_SUCCESSFUL_SYNC_KEY = "photos.lastSuccessfulSync";

/** Reads the durable user rules on every item so a long drain reacts promptly. */
export function nativeUploadPolicy(): UploadPolicy {
  return {
    async canTransfer() {
      const rules = await Store.hydrate<TransferRules>(RULES_KEY, {
        wifiOnly: true,
        allowMetered: false,
        allowRoaming: false,
        chargerOnly: false,
      });
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
        // Android reports a reliable boolean. iOS and older Android return
        // unknown, which stays blocked until the user explicitly allows it.
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

/** Replica sync/rebootstrap deliberately shares the upload network policy. */
export async function nativeSyncAllowed(): Promise<boolean> {
  return nativeUploadPolicy().canTransfer();
}
