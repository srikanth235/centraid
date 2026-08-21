/*
 * Renderer-side client for the gateway's link surface (#726 P2/P3 —
 * `packages/server/src/routes/vault-links-routes.ts`). A link is the channel
 * a grant to another person is delivered over (#825); it is also what a
 * remote pair's ticket redemption lands as (D3: locality is routing, not
 * semantics — one link table serves both).
 *
 *   GET   /centraid/_gateway/links
 *   POST  /centraid/_gateway/links                       {vaultId, otherVaultId}
 *   POST  /centraid/_gateway/links/<linkId>/approve
 *   POST  /centraid/_gateway/links/ticket                 {vaultId}
 *   POST  /centraid/_gateway/links/redeem                 {vaultId, ticket}
 *
 * `ticket`/`redeem` are the remote ceremony's owner-facing door (audit #726
 * finding 1) — before this, the mint/redeem primitives existed only in
 * gateway-internal tests. `mintGatewayLinkTicket` gets back an opaque
 * one-time `ticket` string (the SAME encoding `encodeLinkTicket` produces —
 * paste- or QR-able); `redeemGatewayLinkTicket` hands one back and the
 * gateway dials the peer itself.
 *
 * Not centralized in `@centraid/core/protocol`'s `ROUTES` table: the gateway route
 * itself exports its own local `LINKS_PATH` constant rather than a shared one,
 * so this module mirrors that choice instead of adding a new shared route name
 * for a single consumer.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

const LINKS_PATH = "/centraid/_gateway/links";

/** One link, from the caller's own side (`GatewayLink.vaultA`/`vaultB` are the
 *  RAW pair; `remoteVaultId` is which side, if either, needs routing). */
export interface GatewayLink {
  linkId: string;
  vaultA: string;
  vaultB: string;
  /** Each vault's own name/self-declared label (#726 P6 gap 3) — `null` when
   *  genuinely unknown (an older link proposed before this was recorded).
   *  Symmetric with `vaultA`/`vaultB`: `labelA` names `vaultA`. */
  labelA: string | null;
  labelB: string | null;
  partyIdA?: string | null;
  partyIdB?: string | null;
  approvedByA: boolean;
  approvedByB: boolean;
  /** Both sides have approved — the only state that authorizes an edge. */
  approved: boolean;
  /** The side this gateway must route to reach, or null when both sides are
   *  co-hosted here. Never labelled "remote"/"local" in copy (D3). */
  remoteVaultId: string | null;
  revoked: boolean;
  createdAt: string;
}

/**
 * Total parser for one wire link (#750). The share sheets read a link's
 * LABEL, not just its ids, so a payload whose shape drifted must be dropped
 * here rather than surfaced as a half-built destination: a row missing its
 * pair is not a link, and a label that is not a string is not a name.
 */
function parseGatewayLink(value: unknown): GatewayLink | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof row[key] === "string" && (row[key] as string).length > 0
      ? (row[key] as string)
      : undefined;
  const label = (key: string): string | null =>
    typeof row[key] === "string" ? (row[key] as string) : null;
  const linkId = text("linkId");
  const vaultA = text("vaultA");
  const vaultB = text("vaultB");
  if (!linkId || !vaultA || !vaultB) return undefined;
  return {
    linkId,
    vaultA,
    vaultB,
    labelA: label("labelA"),
    labelB: label("labelB"),
    partyIdA: label("partyIdA"),
    partyIdB: label("partyIdB"),
    approvedByA: row.approvedByA === true,
    approvedByB: row.approvedByB === true,
    approved: row.approved === true,
    remoteVaultId: text("remoteVaultId") ?? null,
    revoked: row.revoked === true,
    createdAt: text("createdAt") ?? "",
  };
}

/** Every link touching a vault this caller owns. */
export async function listGatewayLinks(): Promise<GatewayLink[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, LINKS_PATH, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ links?: unknown }>(res, "list links");
  if (!Array.isArray(out.links)) return [];
  return out.links.flatMap((entry) => {
    const link = parseGatewayLink(entry);
    return link ? [link] : [];
  });
}

/**
 * Propose a link from a vault the caller owns to another vault id — the
 * same-machine (co-hosted) ceremony half; a remote pair links by ticket
 * redemption instead, outside this client's reach.
 */
export async function proposeGatewayLink(
  vaultId: string,
  otherVaultId: string
): Promise<GatewayLink> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, LINKS_PATH, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ vaultId, otherVaultId }),
  });
  return (await readJson<{ link: GatewayLink }>(res, "propose link")).link;
}

/** Approve the caller's own side of a proposed link. */
export async function approveGatewayLink(linkId: string): Promise<GatewayLink> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${LINKS_PATH}/${enc(linkId)}/approve`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
  });
  return (await readJson<{ link: GatewayLink }>(res, "approve link")).link;
}

/** A minted, pasteable/scannable ticket for a vault the caller owns
 *  (#726 audit finding 1). One-time, 15-minute TTL — same shape the P1
 *  device-pairing ticket panel shows, so the People panel can reuse that
 *  idiom rather than inventing a new one. */
export interface GatewayLinkTicket {
  vaultId: string;
  /** Opaque — hand it back to `redeemGatewayLinkTicket` verbatim. */
  ticket: string;
  expiresAt: string;
}

/** Mint a one-time ticket for `vaultId` to show (QR or paste) to whoever is
 *  redeeming it. Owning `vaultId` IS the authorization — the gateway refuses
 *  `not_found` for a vault the caller does not own, same as `proposeGatewayLink`. */
export async function mintGatewayLinkTicket(
  vaultId: string
): Promise<GatewayLinkTicket> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${LINKS_PATH}/ticket`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ vaultId }),
  });
  return readJson<GatewayLinkTicket>(res, "mint link ticket");
}

/** What redeeming a ticket answers when it does not end in a link — a
 *  reachability or protocol fact, never an exception the caller has to
 *  unwrap. `linked` is returned as `{state: "linked", link}` instead; every
 *  other typed refusal (`bad_request`, `protocol_refused`, `not_found`) still
 *  throws via `readJson`, same as the rest of this client. */
export interface RedeemLinkTicketOutcome {
  state: "linked" | "unreachable";
  link?: GatewayLink;
  detail?: string;
}

/**
 * Redeem a ticket someone showed you into `vaultId` — the LOCAL vault the
 * caller owns and wants linked. The gateway dials the peer itself
 * (`serve/peer-dial.ts`); this call simply waits for that ceremony's answer.
 */
export async function redeemGatewayLinkTicket(
  vaultId: string,
  ticket: string
): Promise<RedeemLinkTicketOutcome> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${LINKS_PATH}/redeem`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ vaultId, ticket }),
  });
  return readJson<RedeemLinkTicketOutcome>(res, "redeem link ticket");
}
