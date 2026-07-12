/*
 * `GATEWAYS_LIST_VAULTS` (issue #376) — read the vault list of a gateway the
 * client is not (necessarily) addressing right now, without flipping the
 * active gateway. Powers the flat (gateway, vault) switcher: the renderer
 * can preview every vault on every profile before committing to one.
 *
 * Resolution mirrors `resolveGateway` (`gateway-store.ts`) but this module
 * never writes `settings.json` — it's a read, not a switch. `local` still
 * needs the in-process runtime up to have a URL/token, exactly like
 * `settings.ts`'s `resolveEffective` boots it on demand; `direct` and
 * `iroh` resolve straight through `resolveGateway` (keychain token / loopback
 * proxy respectively).
 */

import { resolveGateway } from './gateway-store.js';
import { fetchGatewayVaults, type ListGatewayVaultsResult } from './gateway-vaults-core.js';

export type { GatewayVaultEntry, ListGatewayVaultsResult } from './gateway-vaults-core.js';

export async function listGatewayVaults(gatewayId: string): Promise<ListGatewayVaultsResult> {
  let resolved = await resolveGateway(gatewayId);
  if (!resolved) return { ok: false, error: 'unreachable' };

  if (resolved.profile.kind === 'local' && !resolved.url) {
    try {
      const { ensureLocalGateway } = await import('./local-gateway.js');
      const handle = await ensureLocalGateway(resolved.profile.id);
      resolved = { ...resolved, url: handle.url, token: handle.token };
    } catch {
      return { ok: false, error: 'unreachable' };
    }
  }
  if (!resolved.url) return { ok: false, error: 'unreachable' };

  return fetchGatewayVaults(resolved.url, resolved.token);
}
