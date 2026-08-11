// Member-authored commons commands are signed by the member vault before
// they cross to the steward. The domain separator prevents a signature from
// being replayed as any other vault-identity assertion.

import {
  signWithVaultIdentity,
  verifyVaultIdentitySignature,
} from "../schema/vault-identity.js";

const COMMONS_INTENT_DOMAIN = "centraid:commons-intent:v1";

export interface CommonsMemberSignature {
  memberVaultId: string;
  nonce: string;
  signature: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)])
  );
}

/** Exact bytes the member vault signs and the steward verifies. */
export function commonsIntentBytes(input: {
  grantId: string;
  actorPartyId: string;
  command: string;
  commandInput: unknown;
  memberVaultId: string;
  nonce: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify(
      canonical({
        domain: COMMONS_INTENT_DOMAIN,
        grantId: input.grantId,
        actorPartyId: input.actorPartyId,
        command: input.command,
        commandInput: input.commandInput,
        memberVaultId: input.memberVaultId,
        nonce: input.nonce,
      })
    )
  );
}

export function signCommonsIntent(
  identitySeed: Buffer,
  input: Omit<Parameters<typeof commonsIntentBytes>[0], "nonce"> & {
    nonce: string;
  }
): CommonsMemberSignature {
  return {
    memberVaultId: input.memberVaultId,
    nonce: input.nonce,
    signature: signWithVaultIdentity(
      identitySeed,
      commonsIntentBytes(input)
    ).toString("base64"),
  };
}

export function verifyCommonsIntent(
  publicKey: Buffer,
  input: Omit<Parameters<typeof commonsIntentBytes>[0], "nonce">,
  assertion: CommonsMemberSignature
): boolean {
  try {
    const signature = Buffer.from(assertion.signature, "base64");
    return (
      assertion.memberVaultId === input.memberVaultId &&
      publicKey.length === 32 &&
      signature.length === 64 &&
      verifyVaultIdentitySignature(
        publicKey,
        commonsIntentBytes({ ...input, nonce: assertion.nonce }),
        signature
      )
    );
  } catch {
    return false;
  }
}
