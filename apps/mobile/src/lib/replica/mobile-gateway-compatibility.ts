import { authHeader } from "../gateway";
import {
  MobileGatewayCompatibilityError,
  judgeMobileGatewayCompatibility,
  readMobileGatewayFeatures,
} from "./mobile-gateway-compatibility-core";
import type { MobileGatewayFeatures } from "./mobile-gateway-compatibility-core";

export async function requireMobileOfflineGateway(input: {
  baseUrl: string;
  online: boolean;
}): Promise<MobileGatewayFeatures | undefined> {
  if (!input.online) return undefined;
  let response: Response;
  try {
    response = await fetch(new URL("/centraid/_gateway/info", input.baseUrl), {
      headers: authHeader(),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    if (response.status === 404)
      throw new MobileGatewayCompatibilityError("update-gateway");
    return undefined;
  }
  const body = await response.json().catch(() => undefined);
  const judgment = judgeMobileGatewayCompatibility(body);
  if (judgment !== "supported")
    throw new MobileGatewayCompatibilityError(judgment);
  return readMobileGatewayFeatures(body);
}
