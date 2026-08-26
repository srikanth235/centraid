/*
 * Link row, readable from either side (#726 / #750). Symmetric AND slim: `a`/`b` plus approvals are pure permission. Identity lives in `vault_directory`, reachability in `vault_routes` — one row per vault (#750 invariants 1–2). Resolve key/label/route through `directoryEntry`/`routeFor`/`peerViewFor`.
 */

/** `vault_routes` in memory — replaceable address data, never identity or an authorization input (P3 decision 1). */
export interface LinkRoute {
  endpointId: string;
  relayHints: string[];
  assertedAt: number;
  signature?: string;
}

export interface VaultDirectoryEntry {
  vaultId: string;
  /** Base64 raw Ed25519 — P1 identity signatures verify against. */
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

export interface LinkedPeer {
  linkId: string;
  localVaultId: string;
  peerVaultId: string;
  peerPublicKey: string;
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

export type LinkChangeReason =
  | "proposed"
  | "approved"
  | "linked"
  | "parties"
  | "revoked";

/**
 * After the gateway-database transaction closes, never inside it: a listener writes a DIFFERENT database (`share_party_vault_binding` via `link-party-bindings.ts`), which a rollback here could not take back.
 */
export type LinkChangeListener = (
  link: VaultLink,
  reason: LinkChangeReason
) => void;

export interface LinkSideLookups {
  routeFor: (vaultId: string) => LinkRoute | undefined;
  directoryEntry: (vaultId: string) => VaultDirectoryEntry | undefined;
}

export function peerViewOf(
  link: VaultLink,
  localVaultId: string,
  lookups: LinkSideLookups
): LinkedPeer | undefined {
  const mine = sideOf(link, localVaultId);
  if (mine === undefined) return undefined;
  const peerVaultId = mine === "a" ? link.vaultB : link.vaultA;
  // A local pair has no far side.
  const route = lookups.routeFor(peerVaultId);
  if (!route) return undefined;
  const peer = lookups.directoryEntry(peerVaultId);
  if (!peer) return undefined;
  const mineEntry = lookups.directoryEntry(localVaultId);
  const partyIds =
    typeof link.permissions["commonsPartyIds"] === "object" &&
    link.permissions["commonsPartyIds"] !== null
      ? (link.permissions["commonsPartyIds"] as Record<string, unknown>)
      : {};
  return {
    linkId: link.linkId,
    localVaultId,
    peerVaultId,
    peerPublicKey: peer.publicKey,
    ...(typeof partyIds[peerVaultId] === "string"
      ? { peerPartyId: partyIds[peerVaultId] }
      : {}),
    ...(typeof partyIds[localVaultId] === "string"
      ? { localPartyId: partyIds[localVaultId] }
      : {}),
    peerLabel: peer.label,
    myLabel: mineEntry?.label ?? null,
    route,
    permissions: link.permissions,
  };
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

export function sideOf(link: VaultLink, vaultId: string): LinkSide | undefined {
  if (vaultId === link.vaultA) return "a";
  if (vaultId === link.vaultB) return "b";
  return undefined;
}

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

/** Canonical pair order — smaller id first (the table's CHECK). */
export function pairOf(vaultX: string, vaultY: string): [string, string] {
  return vaultX < vaultY ? [vaultX, vaultY] : [vaultY, vaultX];
}

/** Ceremony named a known vault under a different identity key (#750 invariant 1). Thrown, never coerced. */
export class VaultDirectoryIdentityError extends Error {
  readonly code = "vault_directory_identity_mismatch";
  constructor(readonly vaultId: string) {
    super(
      `vault ${vaultId} is already in this gateway's directory under a different identity key`
    );
    this.name = "VaultDirectoryIdentityError";
  }
}
