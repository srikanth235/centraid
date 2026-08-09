/*
 * What a link ROW is, and how to read it from either side (issue #726 P2 §3 +
 * P3 decisions 1–3). Separate from the store because a link's shape is what
 * every reader needs — the crossing judgment, the peer plane, the remote give
 * — while the store is only how rows are found and written.
 *
 * The row is symmetric: `a` and `b` are just the two vaults in canonical
 * order, and nothing in the shape says which one is "here". That is the whole
 * point of D3 — locality is routing, so it shows up as a route column and
 * nowhere else.
 */

/**
 * Where a vault is reachable, cached. Replaceable address data re-learned
 * from a signed route assertion — never an identity, never an authorization
 * input (P3 decision 1).
 */
export interface LinkRoute {
  endpointId: string;
  relayHints: string[];
  /** Epoch ms of the assertion that installed it; also the replay ordering key. */
  assertedAt: number;
  /** The assertion's base64 Ed25519 signature, so the cache is self-attesting. */
  signature?: string;
}

export interface VaultLink {
  linkId: string;
  vaultA: string;
  vaultB: string;
  /** Base64 raw Ed25519 — the vault's own P1 identity, what signatures verify against. */
  publicKeyA: string;
  publicKeyB: string;
  labelA: string | null;
  labelB: string | null;
  approvedByA: string | null;
  approvedByB: string | null;
  /** Present only for a side this gateway does not hold. */
  routeA?: LinkRoute;
  routeB?: LinkRoute;
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
  public_key_a: string;
  public_key_b: string;
  label_a: string | null;
  label_b: string | null;
  approved_by_a: string | null;
  approved_by_b: string | null;
  route_a_json: string | null;
  route_b_json: string | null;
  permissions_json: string;
  revoked: number;
  created_at: string;
}

type LinkSide = "a" | "b";

function parseRoute(raw: string | null): LinkRoute | undefined {
  if (raw === null) return undefined;
  const parsed = JSON.parse(raw) as LinkRoute;
  return { ...parsed, relayHints: parsed.relayHints ?? [] };
}

export function toLink(row: VaultLinkRow): VaultLink {
  const routeA = parseRoute(row.route_a_json);
  const routeB = parseRoute(row.route_b_json);
  return {
    linkId: row.link_id,
    vaultA: row.vault_a,
    vaultB: row.vault_b,
    publicKeyA: row.public_key_a,
    publicKeyB: row.public_key_b,
    labelA: row.label_a,
    labelB: row.label_b,
    approvedByA: row.approved_by_a,
    approvedByB: row.approved_by_b,
    ...(routeA ? { routeA } : {}),
    ...(routeB ? { routeB } : {}),
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

/** How to reach `vaultId` — `undefined` when it is a vault on this gateway. */
export function routeTo(
  link: VaultLink,
  vaultId: string
): LinkRoute | undefined {
  const side = sideOf(link, vaultId);
  if (side === undefined) return undefined;
  return side === "a" ? link.routeA : link.routeB;
}

/** Both sides approved and not revoked — what an edge's authorization needs. */
export function isLinkApproved(link: VaultLink): boolean {
  return (
    !link.revoked && link.approvedByA !== null && link.approvedByB !== null
  );
}

/** The unordered pair's canonical order — smaller id first (the table's CHECK). */
export function pairOf(vaultX: string, vaultY: string): [string, string] {
  return vaultX < vaultY ? [vaultX, vaultY] : [vaultY, vaultX];
}

/** The link as `localVaultId` sees it — `undefined` unless the far side is routed. */
export function peerViewOf(
  link: VaultLink,
  localVaultId: string
): LinkedPeer | undefined {
  const mine = sideOf(link, localVaultId);
  if (mine === undefined) return undefined;
  const peerVaultId = mine === "a" ? link.vaultB : link.vaultA;
  const route = routeTo(link, peerVaultId);
  // A peer view is a view of a vault elsewhere; a local pair has no far side.
  if (!route) return undefined;
  return {
    linkId: link.linkId,
    localVaultId,
    peerVaultId,
    peerPublicKey: mine === "a" ? link.publicKeyB : link.publicKeyA,
    peerLabel: mine === "a" ? link.labelB : link.labelA,
    myLabel: mine === "a" ? link.labelA : link.labelB,
    route,
    permissions: link.permissions,
  };
}
