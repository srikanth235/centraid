import AsyncStorage from "@react-native-async-storage/async-storage";

import { authHeader } from "../gateway";
import {
  MOBILE_GATEWAY_RECONNECT_MESSAGE,
  MOBILE_GATEWAY_UPDATE_MESSAGE,
  supportsMobileOfflineGateway,
} from "./mobile-gateway-compatibility-core";

/**
 * One central compatibility wall for foreground and background construction.
 * Absence of either additive capability means "update", never route-by-route
 * 404 retries. A successful online judgment is cached for offline cold starts.
 */
export async function requireMobileOfflineGateway(input: {
  baseUrl: string;
  gatewayId: string;
  online: boolean;
}): Promise<void> {
  const key = compatibilityKey(input.gatewayId);
  if (!input.online) {
    if ((await AsyncStorage.getItem(key)) === "supported") return;
    throw new Error(MOBILE_GATEWAY_RECONNECT_MESSAGE);
  }
  const response = await fetch(
    new URL("/centraid/_gateway/info", input.baseUrl),
    { headers: authHeader() }
  );
  const body = response.ok
    ? await response.json().catch(() => undefined)
    : null;
  if (!supportsMobileOfflineGateway(body)) {
    await AsyncStorage.removeItem(key);
    throw new Error(MOBILE_GATEWAY_UPDATE_MESSAGE);
  }
  await AsyncStorage.setItem(key, "supported");
}

function compatibilityKey(gatewayId: string): string {
  return `centraid:mobile-offline-capabilities:${encodeURIComponent(gatewayId)}`;
}
