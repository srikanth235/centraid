/*
 * Leases (#726 P4 D8). A live edge is a WINDOW the origin can close, and a
 * lease is what makes that true even when the origin cannot reach the
 * audience to say so: the audience's own sweep drops a shape whose lease has
 * run out, so a partitioned borrower forgets ON SCHEDULE without being told.
 *
 * 30 days, a constant — not a policy knob. Renewed on EVERY authenticated
 * contact, so a reachable peer never notices the clock, and an unreachable one
 * is exactly the case the clock exists for.
 *
 * The signature is the ORIGIN VAULT's own Ed25519 identity key (P1 gave every
 * vault one). Not a device key: devices come and go under an owner, but the
 * thing lending is the vault, and the audience already pinned that vault's
 * public key at link time. Signed bytes are a domain-separated, length-framed
 * string rather than JSON — same discipline as the route assertion, for the
 * same reason: two JSON encoders must never be able to disagree about what was
 * signed.
 */

import { verifyVaultIdentitySignature } from "@centraid/vault";

export const LEASE_TERM_MS = 30 * 24 * 60 * 60 * 1000;
const LEASE_DOMAIN = "centraid/lend-lease/1";

export interface LendLease {
  edgeId: string;
  originVaultId: string;
  audienceVaultId: string;
  /** ISO 8601, UTC. The audience compares strings; both sides mint ISO. */
  expiresAt: string;
  /** Base64 Ed25519 over {@link leaseSigningBytes}. */
  signature: string;
}

export function leaseSigningBytes(lease: Omit<LendLease, "signature">): Buffer {
  return Buffer.from(
    [
      LEASE_DOMAIN,
      lease.edgeId,
      lease.originVaultId,
      lease.audienceVaultId,
      lease.expiresAt,
    ].join("\n"),
    "utf8"
  );
}

/** `VaultRegistry.signAsVault` — `undefined` for a vault this gateway
 *  cannot sign as, which is a refusal, never an unsigned lease. */
export type LeaseSigner = (
  vaultId: string,
  bytes: Buffer
) => Buffer | undefined;

/** Mint (or renew — they are the same act) a lease for one edge. */
export function mintLease(
  sign: LeaseSigner,
  input: {
    edgeId: string;
    originVaultId: string;
    audienceVaultId: string;
    now?: number;
  }
): LendLease | undefined {
  const expiresAt = new Date(
    (input.now ?? Date.now()) + LEASE_TERM_MS
  ).toISOString();
  const unsigned = {
    edgeId: input.edgeId,
    originVaultId: input.originVaultId,
    audienceVaultId: input.audienceVaultId,
    expiresAt,
  };
  const signature = sign(input.originVaultId, leaseSigningBytes(unsigned));
  if (!signature) return undefined;
  return { ...unsigned, signature: signature.toString("base64") };
}

export function parseLease(value: unknown): LendLease | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const strings = [
    "edgeId",
    "originVaultId",
    "audienceVaultId",
    "expiresAt",
    "signature",
  ] as const;
  for (const key of strings) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0)
      return undefined;
  }
  return {
    edgeId: raw.edgeId as string,
    originVaultId: raw.originVaultId as string,
    audienceVaultId: raw.audienceVaultId as string,
    expiresAt: raw.expiresAt as string,
    signature: raw.signature as string,
  };
}

/**
 * A lease is accepted only if it names the edge and the two vaults the
 * audience already believes it is talking to AND verifies against the key the
 * LINK pinned. Fails closed: an unparseable expiry, a mismatched vault, or a
 * bad signature is a refusal, never a shorter lease.
 */
export function acceptLease(
  lease: LendLease,
  expected: {
    edgeId: string;
    originVaultId: string;
    audienceVaultId: string;
    originPublicKey: string;
  }
): boolean {
  if (
    lease.edgeId !== expected.edgeId ||
    lease.originVaultId !== expected.originVaultId ||
    lease.audienceVaultId !== expected.audienceVaultId
  ) {
    return false;
  }
  if (!Number.isFinite(Date.parse(lease.expiresAt))) return false;
  let publicKey: Buffer;
  let signature: Buffer;
  try {
    publicKey = Buffer.from(expected.originPublicKey, "base64");
    signature = Buffer.from(lease.signature, "base64");
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    return verifyVaultIdentitySignature(
      publicKey,
      leaseSigningBytes(lease),
      signature
    );
  } catch {
    return false;
  }
}
