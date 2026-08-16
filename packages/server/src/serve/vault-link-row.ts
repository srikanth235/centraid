/*
 * What a link ROW is, and how to read it from either side (issue #726 P2 §3 +
 * P3 decisions 1–3; reshaped by issue #750). Separate from the store because
 * a link's shape is what every reader needs — the crossing judgment, the peer
 * plane, the remote give — while the store is only how rows are found and
 * written.
 *
 * The row is symmetric AND slim: `a` and `b` are just the two vaults in
 * canonical order plus the two approvals — pure permission. Identity (public
 * keys, labels) lives in `vault_directory` and reachability lives in
 * `vault_routes`, one row per vault either way (#750 invariants 1–2), so
 * nothing in a link can drift from the vault it names. Readers that need a
 * side's key, label, or route resolve it through the store's directory
 * lookups (`directoryEntry`/`routeFor`/`peerViewFor`).
 */

/**
 * Where a vault is reachable — the in-memory shape of that vault's single
 * `vault_routes` row. Replaceable address data re-learned from a signed route
 * assertion — never an identity, never an authorization input (P3 decision 1).
 */
export interface LinkRoute {
  endpointId: string;
  relayHints: string[];
  /** Epoch ms of the assertion that installed it; also the replay ordering key. */
  assertedAt: number;
  /** The assertion's base64 Ed25519 signature, so the cache is self-attesting. */
  signature?: string;
}

/** A vault's `vault_directory` row: its one stable identity record (#750). */
export interface VaultDirectoryEntry {
  vaultId: string;
  /** Base64 raw Ed25519 — the vault's own P1 identity, what signatures verify against. */
  publicKey: string;
  label: string | null;
  createdAt: string;
}

export interface VaultLink {
  linkId: string;
  vaultA: string;
  vaultB: string;
  approvedByA: string | null;
  approvedByB: string | null;
  permissions: Record<string, unknown>;
  revoked: boolean;
  createdAt: string;
}

/** A link read from one vault's point of view — always a routed far side. */
export interface LinkedPeer {
  linkId: string;
  localVaultId: string;
  peerVaultId: string;
  peerPublicKey: string;
  /** Party identities exchanged during the approved link ceremony. */
  peerPartyId?: string;
  localPartyId?: string;
  peerLabel: string | null;
  myLabel: string | null;
  route: LinkRoute;
  permissions: Record<string, unknown>;
}

export interface PeerLinkInput {
  localVaultId: string;
  localPublicKey: string;
  localLabel: string;
  peerVaultId: string;
  peerPublicKey: string;
  peerLabel: string;
  route: LinkRoute;
  permissions?: Record<string, unknown>;
}

export interface LinkRedemption extends Omit<
  PeerLinkInput,
  "localVaultId" | "localPublicKey"
> {
  ticketId: string;
  secret: string;
}

export interface VaultLinkRow {
  link_id: string;
  vault_a: string;
  vault_b: string;
  approved_by_a: string | null;
  approved_by_b: string | null;
  permissions_json: string;
  revoked: number;
  created_at: string;
}

type LinkSide = "a" | "b";

export function toLink(row: VaultLinkRow): VaultLink {
  return {
    linkId: row.link_id,
    vaultA: row.vault_a,
    vaultB: row.vault_b,
    approvedByA: row.approved_by_a,
    approvedByB: row.approved_by_b,
    permissions: JSON.parse(row.permissions_json) as Record<string, unknown>,
    revoked: row.revoked === 1,
    createdAt: row.created_at,
  };
}

/** Which side of the link `vaultId` sits on, or `undefined` when neither. */
export function sideOf(link: VaultLink, vaultId: string): LinkSide | undefined {
  if (vaultId === link.vaultA) return "a";
  if (vaultId === link.vaultB) return "b";
  return undefined;
}

/** Both sides approved and not revoked — what an edge's authorization needs. */
export function isLinkApproved(link: VaultLink): boolean {
  return (
    !link.revoked && link.approvedByA !== null && link.approvedByB !== null
  );
}

export function partyIdForLinkedVault(
  link: VaultLink,
  vaultId: string
): string | undefined {
  const ids = link.permissions["commonsPartyIds"];
  if (!ids || typeof ids !== "object") return undefined;
  const value = (ids as Record<string, unknown>)[vaultId];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The unordered pair's canonical order — smaller id first (the table's CHECK). */
export function pairOf(vaultX: string, vaultY: string): [string, string] {
  return vaultX < vaultY ? [vaultX, vaultY] : [vaultY, vaultX];
}

/**
 * A ceremony named a vault this gateway already knows, but under a different
 * identity key (#750 invariant 1). Thrown, never coerced: the directory is
 * the thing that remembers which key a vault id means, so letting a later
 * claim overwrite it would make the memory worthless.
 */
export class VaultDirectoryIdentityError extends Error {
  readonly code = "vault_directory_identity_mismatch";
  constructor(readonly vaultId: string) {
    super(
      `vault ${vaultId} is already in this gateway's directory under a different identity key`
    );
    this.name = "VaultDirectoryIdentityError";
  }
}
