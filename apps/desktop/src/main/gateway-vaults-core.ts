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
  | { ok: false; error: "unreachable" | "auth_failed" | "bad_response" };

export function foldVaultsResponse(
  status: number,
  body: unknown
): ListGatewayVaultsResult {
  if (status === 401 || status === 403)
    return { ok: false, error: "auth_failed" };
  if (status !== 200) return { ok: false, error: "unreachable" };
  if (!body || typeof body !== "object")
    return { ok: false, error: "bad_response" };
  const raw = (body as Record<string, unknown>).vaults;
  if (!Array.isArray(raw)) return { ok: false, error: "bad_response" };
  const vaults: GatewayVaultEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.vaultId !== "string" || typeof r.name !== "string") continue;
    vaults.push({
      vaultId: r.vaultId,
      name: r.name,
      ...(typeof r.ownerPartyId === "string"
        ? { ownerPartyId: r.ownerPartyId }
        : {}),
      ...(typeof r.color === "string" ? { color: r.color } : {}),
      ...(typeof r.icon === "string" ? { icon: r.icon } : {}),
      ...(typeof r.blurb === "string" ? { blurb: r.blurb } : {}),
    });
  }
  return { ok: true, vaults };
}

const VAULTS_PATH = "/centraid/_vault/vaults";
const DEFAULT_TIMEOUT_MS = 3000;

export async function fetchGatewayVaults(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
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
      return { ok: false, error: "unreachable" };
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
