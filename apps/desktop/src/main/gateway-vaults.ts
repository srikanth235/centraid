import { resolveGateway } from "./gateway-store.js";
import { fetchGatewayVaults } from "./gateway-vaults-core.js";
import type { ListGatewayVaultsResult } from "./gateway-vaults-core.js";

export type { ListGatewayVaultsResult } from "./gateway-vaults-core.js";

export async function listGatewayVaults(
  gatewayId: string
): Promise<ListGatewayVaultsResult> {
  let resolved = await resolveGateway(gatewayId);
  if (!resolved) return { ok: false, error: "unreachable" };

  if (resolved.profile.kind === "local" && !resolved.url) {
    try {
      const { ensureLocalGateway } = await import("./local-gateway.js");
      const handle = await ensureLocalGateway(resolved.profile.id);
      resolved = { ...resolved, url: handle.url, token: handle.token };
    } catch {
      return { ok: false, error: "unreachable" };
    }
  }
  if (!resolved.url) return { ok: false, error: "unreachable" };

  return fetchGatewayVaults(resolved.url, resolved.token);
}
