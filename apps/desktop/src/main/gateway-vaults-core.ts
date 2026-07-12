/*
 * Pure core for `GATEWAYS_LIST_VAULTS` (issue #376) — fetch + fold
 * `GET /centraid/_vault/vaults` for a gateway the client is NOT (yet)
 * addressing, powering the flat (gateway, vault) switcher. Same
 * "electron-free pure core + injectable fetchImpl" split as
 * `gateway-ops-core.ts`'s `fetchDiagnosticsText`.
 */

/** One row of `GET /centraid/_vault/vaults` (see `renderer/gateway-client-vault.ts`'s `VaultListEntry`). */
export interface GatewayVaultEntry {
  vaultId: string;
  name: string;
  ownerPartyId?: string;
  color?: string;
  icon?: string;
  blurb?: string;
}

export type ListGatewayVaultsResult =
  | { ok: true; vaults: GatewayVaultEntry[] }
  | { ok: false; error: 'unreachable' | 'auth_failed' | 'bad_response' };

/** Fold a raw HTTP status + parsed JSON body into a `ListGatewayVaultsResult`. */
export function foldVaultsResponse(status: number, body: unknown): ListGatewayVaultsResult {
  if (status === 401 || status === 403) return { ok: false, error: 'auth_failed' };
  if (status !== 200) return { ok: false, error: 'unreachable' };
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_response' };
  const raw = (body as Record<string, unknown>).vaults;
  if (!Array.isArray(raw)) return { ok: false, error: 'bad_response' };
  const vaults: GatewayVaultEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.vaultId !== 'string' || typeof r.name !== 'string') continue;
    vaults.push({
      vaultId: r.vaultId,
      name: r.name,
      ...(typeof r.ownerPartyId === 'string' ? { ownerPartyId: r.ownerPartyId } : {}),
      ...(typeof r.color === 'string' ? { color: r.color } : {}),
      ...(typeof r.icon === 'string' ? { icon: r.icon } : {}),
      ...(typeof r.blurb === 'string' ? { blurb: r.blurb } : {}),
    });
  }
  return { ok: true, vaults };
}

const VAULTS_PATH = '/centraid/_vault/vaults';
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Fetch + fold `GET /centraid/_vault/vaults` from `baseUrl`. `fetchImpl` is
 * injectable for tests (same convention as `gateway-ops-core.ts`'s
 * `fetchDiagnosticsText`); the real caller (`gateway-vaults.ts`) passes the
 * global `fetch` and gets the ~3s abort-on-timeout behavior for free.
 */
export async function fetchGatewayVaults(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ListGatewayVaultsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(new URL(VAULTS_PATH, `${baseUrl}/`).toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
    } catch {
      return { ok: false, error: 'unreachable' };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return foldVaultsResponse(res.status, body);
  } finally {
    clearTimeout(timer);
  }
}
