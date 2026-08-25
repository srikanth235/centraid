import { verifyVaultIdentitySignature } from "@centraid/vault";

const ASSERTION_DOMAIN = "centraid/link-route/1";

const HINT_FORBIDDEN = /[\n\r]/u;

export const MAX_ASSERTION_SKEW_MS = 5 * 60 * 1000;

export interface RouteClaim {
  vaultId: string;
  /** Cache only — an EndpointId is never an identity (decision 1). */
  endpointId: string;
  relayHints: string[];
  ts: number;
}

export interface RouteAssertion extends RouteClaim {
  signature: string;
}

/** The exact bytes both sides sign; order and framing are the contract. */
export function routeAssertionBytes(claim: RouteClaim): Buffer {
  return Buffer.from(
    [
      ASSERTION_DOMAIN,
      claim.vaultId,
      claim.endpointId,
      String(claim.relayHints.length),
      ...claim.relayHints,
      String(claim.ts),
    ].join("\n"),
    "utf8"
  );
}

function readHints(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hints: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return undefined;
    if (HINT_FORBIDDEN.test(entry)) return undefined;
    hints.push(entry);
  }
  return hints;
}

export function parseRouteAssertion(raw: unknown): RouteAssertion | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const { vaultId, endpointId, signature } = body;
  if (typeof vaultId !== "string" || vaultId.length === 0) return undefined;
  if (typeof endpointId !== "string" || endpointId.length === 0)
    return undefined;
  if (typeof signature !== "string" || signature.length === 0) return undefined;
  const relayHints = readHints(body.relayHints);
  if (!relayHints) return undefined;
  const ts = body.ts;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0)
    return undefined;
  return { vaultId, endpointId, relayHints, ts, signature };
}

/** Signed route assertion (#726 P3 decision 4): verified against the key RECORDED FOR THAT VAULT at link time — a peer cannot re-key itself by asserting. */
export function verifyRouteAssertion(
  assertion: RouteAssertion,
  storedPeerPublicKeyBase64: string,
  now = Date.now()
): boolean {
  if (assertion.ts > now + MAX_ASSERTION_SKEW_MS) return false;
  let publicKey: Buffer;
  let signature: Buffer;
  try {
    publicKey = Buffer.from(storedPeerPublicKeyBase64, "base64");
    signature = Buffer.from(assertion.signature, "base64");
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    return verifyVaultIdentitySignature(
      publicKey,
      routeAssertionBytes(assertion),
      signature
    );
  } catch {
    return false;
  }
}
