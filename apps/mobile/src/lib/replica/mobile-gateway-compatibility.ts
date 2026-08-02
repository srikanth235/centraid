import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetch as expoFetch } from "expo/fetch";

import { authHeader } from "../gateway";
import {
  MobileGatewayCompatibilityError,
  judgeMobileGatewayCompatibility,
} from "./mobile-gateway-compatibility-core";

/** Tunnel dial + first HTTP stream often lag the pair ALPN on cold iroh. */
const ONLINE_PROBE_ATTEMPTS = 12;
/** Fixed gap (not linear) so a true reconnect wall stays ~18s, not ~99s. */
const ONLINE_PROBE_GAP_MS = 1500;

/**
 * One central compatibility wall for foreground and background construction.
 * Absence of either additive capability means "update", never route-by-route
 * 404 retries. A successful online judgment is cached for offline cold starts.
 *
 * Online probes retry briefly: after a named-member pair the shell can mount
 * before the tunnel's first bi-stream is live (Android nightly 30711575336 —
 * permanent "Reconnect once" wall on a single failed fetch).
 *
 * Uses `expo/fetch` like the rest of the tunnel client — RN's global `fetch`
 * was starving Android `/_gateway/info` over the localhost proxy
 * (30752829174) while Maestro waited a full probe budget.
 */
export async function requireMobileOfflineGateway(input: {
  baseUrl: string;
  gatewayId: string;
  online: boolean;
}): Promise<void> {
  const key = compatibilityKey(input.gatewayId);
  if (!input.online) {
    if ((await AsyncStorage.getItem(key)) === "supported") return;
    // resolveGatewayBase() can flap false right after pair while LAST_BASE
    // still points at a live localhost tunnel — probe before reconnect wall.
  }
  await probeOnlineWithReconnectRetries(input.baseUrl, key, 0);
}

/**
 * Sequential reconnect retries with a fixed gap. Written as recursion so
 * the intentional serial await is not flagged as a parallelizable loop.
 */
async function probeOnlineWithReconnectRetries(
  baseUrl: string,
  key: string,
  attempt: number
): Promise<void> {
  try {
    await probeOnlineCapabilities(baseUrl, key);
  } catch (error) {
    if (!(error instanceof MobileGatewayCompatibilityError)) throw error;
    // Definite product-side mismatch — do not burn the retry budget.
    if (error.disposition !== "reconnect") throw error;
    if (attempt + 1 >= ONLINE_PROBE_ATTEMPTS) throw error;
    await sleep(ONLINE_PROBE_GAP_MS);
    await probeOnlineWithReconnectRetries(baseUrl, key, attempt + 1);
  }
}

async function probeOnlineCapabilities(
  baseUrl: string,
  key: string
): Promise<void> {
  let response: Response;
  try {
    response = await expoFetch(
      new URL("/centraid/_gateway/info", baseUrl).toString(),
      { headers: authHeader() }
    );
  } catch {
    throw new MobileGatewayCompatibilityError("reconnect");
  }
  if (!response.ok) {
    await AsyncStorage.removeItem(key);
    throw new MobileGatewayCompatibilityError(
      response.status === 404 ? "update-gateway" : "reconnect"
    );
  }
  const body = await response.json().catch(() => undefined);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
