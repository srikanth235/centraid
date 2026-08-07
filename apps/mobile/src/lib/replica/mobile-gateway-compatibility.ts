import { authHeader } from "../gateway";
import {
  MobileGatewayCompatibilityError,
  judgeMobileGatewayCompatibility,
} from "./mobile-gateway-compatibility-core";

/**
 * One central compatibility wall for foreground and background construction.
 * Absence of either additive capability means "update", never route-by-route
 * 404 retries (C1(b): a blocking wall, no degraded modes on skew).
 *
 * OFFLINE IS NOT A VERDICT. The predecessor cached a successful online
 * judgment per gateway and, offline, threw a "Reconnect once" wall whenever
 * that cache came up empty. Two things were wrong with that, and together
 * they walled a fully-paired phone out of its own replica:
 *
 *  1. The cache was keyed by the base URL — a tunnel loopback with an
 *     EPHEMERAL PORT (`http://127.0.0.1:65277` was observed persisted on a
 *     real device). Every tunnel start mints a new port, so the marker could
 *     never match again and every offline cold start read as "never
 *     verified".
 *  2. Even with a durable key, "I could not ask" is not a judgment. The wall
 *     exists to stop a REACHABLE gateway that answers wrongly — skew is only
 *     provable by an answer. An unanswered question proves nothing, and a
 *     local-first product must not gate local reads on it (the same defect
 *     `kit/replica/mount-plan.ts` records for the mount itself).
 *
 * So offline fails OPEN, and the cache is gone: the wall is re-raised the
 * moment a gateway actually answers — phase B's first reachability pass calls
 * back in here with `online: true`, which is exactly when skew becomes a
 * provable fact and blocking becomes legitimate.
 */
export async function requireMobileOfflineGateway(input: {
  baseUrl: string;
  online: boolean;
}): Promise<void> {
  if (!input.online) return;
  let response: Response;
  try {
    response = await fetch(new URL("/centraid/_gateway/info", input.baseUrl), {
      headers: authHeader(),
    });
  } catch {
    // The transport having a bad day is the offline case wearing a socket
    // error; same rule, same reason.
    return;
  }
  if (!response.ok) {
    // A 404 is the one status that IS a judgment: this gateway is old enough
    // not to serve the info route at all.
    if (response.status === 404)
      throw new MobileGatewayCompatibilityError("update-gateway");
    return;
  }
  const body = await response.json().catch(() => undefined);
  const judgment = judgeMobileGatewayCompatibility(body);
  if (judgment !== "supported")
    throw new MobileGatewayCompatibilityError(judgment);
}
