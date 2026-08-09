/*
 * Signed route assertions (issue #726 P3 decision 4).
 *
 * When a gateway's endpoint keypair rotates or a vault moves hosts, every
 * peer's cached route goes stale. Rather than a directory or a re-run of the
 * ceremony, the moving side pushes a signed statement to each known link:
 * "vault V is now reachable at endpoint E via these relays, as of T". The
 * receiver verifies it against the STORED vault public key — the identity it
 * recorded at link time — so a route can only be moved by the vault that owns
 * it, and never by whoever happens to hold the current EndpointId.
 *
 * The signed bytes are a length-framed, domain-separated string rather than
 * JSON: two JSON serializers disagree about key order and number formatting,
 * and a signature is only as good as the exactness of what it covers.
 */

import { verifyVaultIdentitySignature } from "@centraid/vault";

/** Domain separator — a signature here can never be replayed elsewhere. */
const ASSERTION_DOMAIN = "centraid/link-route/1";

/** A relay hint is a URL; a newline in one would blur the framing below. */
const HINT_FORBIDDEN = /[\n\r]/u;

/** Assertions from the future are refused rather than trusted (clock skew). */
export const MAX_ASSERTION_SKEW_MS = 5 * 60 * 1000;

export interface RouteClaim {
  vaultId: string;
  /** Route cache only — an EndpointId is never an identity (decision 1). */
  endpointId: string;
  relayHints: string[];
  /** Epoch ms; also the replay ordering key on the receiving side. */
  ts: number;
}

export interface RouteAssertion extends RouteClaim {
  /** Base64 Ed25519 signature over `routeAssertionBytes(claim)`. */
  signature: string;
}

/** The exact bytes both sides sign and verify. Order and framing are the contract. */
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

/**
 * Parse an assertion off the wire. Total: a malformed body is `undefined`, a
 * state for the caller to name — never an exception.
 */
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

/**
 * Verify against the public key RECORDED FOR THAT VAULT at link time. An
 * assertion signed with any other key — including one offered in the same
 * request — fails: a peer cannot re-key itself by asserting.
 */
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
    // A structurally invalid key or signature is a refusal, not a crash.
    return false;
  }
}
