export const DEFAULT_ALLOWED_HOSTNAMES: readonly string[] = Object.freeze([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

export function hostnameFromHostHeader(
  hostHeader: string | string[] | undefined
): string | undefined {
  if (hostHeader === undefined) return undefined;
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (typeof raw !== "string") return undefined;
  const host = raw.trim();
  if (host === "") return undefined;

  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return undefined;
    const hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest !== "" && !/^:\d+$/u.test(rest)) return undefined;
    return hostname.toLowerCase();
  }

  const colon = host.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/u.test(host.slice(colon + 1))) {
    return host.slice(0, colon).toLowerCase();
  }
  if (host.includes(":")) return undefined;
  return host.toLowerCase();
}

export function isAllowedHostHeader(
  hostHeader: string | string[] | undefined,
  extraAllowedHostnames: readonly string[] = []
): boolean {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (hostname === undefined) return false;
  for (const allowed of DEFAULT_ALLOWED_HOSTNAMES) {
    if (hostname === allowed) return true;
  }
  for (const allowed of extraAllowedHostnames) {
    if (hostname === allowed.trim().toLowerCase()) return true;
  }
  return false;
}

export interface CorsDecision {
  allowOrigin: string | null;
  credentials: boolean;
}

export interface DecideCorsInput {
  origin: string | string[] | undefined;
  credentialedOrigins: readonly string[];
  bearerAuthIntent: boolean;
}

export function decideCors(input: DecideCorsInput): CorsDecision {
  const raw = input.origin;
  if (raw === undefined || Array.isArray(raw)) {
    return { allowOrigin: "*", credentials: false };
  }
  if (raw === "null" || raw === "") {
    return { allowOrigin: "*", credentials: false };
  }

  if (input.credentialedOrigins.includes(raw) || input.bearerAuthIntent) {
    return { allowOrigin: raw, credentials: true };
  }

  return { allowOrigin: "*", credentials: false };
}

export function hasBearerAuthIntent(
  authorization: string | string[] | undefined,
  accessControlRequestHeaders: string | string[] | undefined
): boolean {
  const auth = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof auth === "string" && /^Bearer\s+\S+/iu.test(auth.trim()))
    return true;

  const acrh = Array.isArray(accessControlRequestHeaders)
    ? accessControlRequestHeaders.join(",")
    : accessControlRequestHeaders;
  if (typeof acrh !== "string") return false;
  return acrh
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .includes("authorization");
}
