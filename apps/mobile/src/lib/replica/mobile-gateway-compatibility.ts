import AsyncStorage from "@react-native-async-storage/async-storage";

import { authHeader } from "../gateway";
import {
  MobileGatewayCompatibilityError,
  judgeMobileGatewayCompatibility,
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
    throw new MobileGatewayCompatibilityError("reconnect");
  }
  let response: Response;
  try {
    response = await fetch(new URL("/centraid/_gateway/info", input.baseUrl), {
      headers: authHeader(),
    });
  } catch {
    throw new MobileGatewayCompatibilityError("reconnect");
  }
  if (!response.ok) {
    await AsyncStorage.removeItem(key);
    throw new MobileGatewayCompatibilityError(
      response.status === 404 ? "update-gateway" : "reconnect"
    );
  }
  const body = response.ok
    ? await response.json().catch(() => undefined)
    : null;
  const judgment = judgeMobileGatewayCompatibility(body);
  if (judgment !== "supported") {
    await AsyncStorage.removeItem(key);
    throw new MobileGatewayCompatibilityError(judgment);
  }
  await AsyncStorage.setItem(key, "supported");
}

function compatibilityKey(gatewayId: string): string {
  return `centraid:mobile-offline-capabilities:${encodeURIComponent(gatewayId)}`;
}
