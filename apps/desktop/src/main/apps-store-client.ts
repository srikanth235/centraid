import { loadSettings } from "./settings.js";

interface AuthCache {
  baseUrl: string;
  token: string | undefined;
  vaultId: string | undefined;
}
let cachedAuth: AuthCache | undefined;
let inflightAuth: Promise<AuthCache> | undefined;

async function auth(): Promise<AuthCache> {
  if (cachedAuth) return cachedAuth;
  if (!inflightAuth) {
    inflightAuth = (async () => {
      const settings = await loadSettings();
      const next: AuthCache = {
        baseUrl: settings.gatewayUrl.replace(/\/$/u, ""),
        token: settings.gatewayToken || undefined,
        vaultId: settings.activeVaultId || undefined,
      };
      cachedAuth = next;
      return next;
    })().finally(() => {
      inflightAuth = undefined;
    });
  }
  return inflightAuth;
}

export function resetAppsStoreAuthCache(): void {
  cachedAuth = undefined;
}

function headers(
  token: string | undefined,
  contentType?: string
): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (contentType) h["content-type"] = contentType;
  if (cachedAuth?.vaultId) h["x-centraid-vault"] = cachedAuth.vaultId;
  return h;
}

async function parse<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `${label} HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

export async function openSession(sessionId?: string): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await fetch(`${baseUrl}/centraid/_apps/_sessions`, {
    method: "POST",
    headers: headers(token, "application/json"),
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });
  const out = await parse<{ sessionId: string }>(res, "open-session");
  return out.sessionId;
}
