import * as Battery from "expo-battery";
import * as Network from "expo-network";

import { getCellularRoamingStatus } from "../../../modules/centraid-network-status";
// The RECORD is frame-owned (#711, S4): one policy for every byte-bearing app,
// not one per app. This file keeps the EVALUATION — what the radios and the
// battery say about it right now — because that is the drain loop's business.
// See `kit/transfer/transfer-policy.ts` for why the storage key never changes.
import { hydrateTransferPolicy } from "../../kit/transfer/transfer-policy";
import type { UploadPolicy } from "./uploader";

export const LAST_SUCCESSFUL_SYNC_KEY = "photos.lastSuccessfulSync";

/** Reads the durable user rules on every item so a long drain reacts promptly. */
export function nativeUploadPolicy(): UploadPolicy {
  return {
    async canTransfer() {
      const rules = await hydrateTransferPolicy();
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
