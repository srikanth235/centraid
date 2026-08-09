/*
 * Renderer-side client for the gateway's link surface (#726 P2/P3 —
 * `packages/gateway/src/routes/vault-links-routes.ts`). A link is the
 * same-machine "ceremony" a cross-owner edge needs before it may cross; it is
 * also what a remote pair's ticket redemption lands as (D3: locality is
 * routing, not semantics — one link table serves both).
 *
 *   GET   /centraid/_gateway/links
 *   POST  /centraid/_gateway/links                       {vaultId, otherVaultId}
 *   POST  /centraid/_gateway/links/<linkId>/approve
 *   GET   /centraid/_gateway/links/<linkId>/receive-setting
 *   PUT   /centraid/_gateway/links/<linkId>/receive-setting {setting}
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
 * Not centralized in `@centraid/protocol`'s `ROUTES` table: the gateway route
 * itself exports its own local `LINKS_PATH` constant rather than a shared one
 * (same precedent as the edges-answer sub-paths), so this module mirrors that
 * choice instead of adding a new shared route name for a single consumer.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

const LINKS_PATH = "/centraid/_gateway/links";

/** D9's per-direction preference (#726 P3 decision 9). No row on the gateway
 *  means `"accept"` — an approved link behaves as it did before D9 existed. */
export type ReceiveSetting = "accept" | "ask" | "refuse";

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

/** The caller's own borrow-budget setting for one link (#726 P6 gap 2) — how
 *  much local storage this vault will hold BORROWED from the other side. */
export interface BorrowBudget {
  linkId: string;
  vaultId: string;
  budgetBytes: number;
  /** `true` when no custom row exists — `budgetBytes` is the constant default. */
  isDefault: boolean;
}

/** Every link touching a vault this caller owns. */
export async function listGatewayLinks(): Promise<GatewayLink[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, LINKS_PATH, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ links: GatewayLink[] }>(res, "list links");
  return out.links ?? [];
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

/** The caller's OWN receiving preference for gives arriving over this link —
 *  never the peer's, which this gateway cannot read or set (D9). */
export async function getReceiveSetting(
  linkId: string
): Promise<ReceiveSetting> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `${LINKS_PATH}/${enc(linkId)}/receive-setting`,
    { method: "GET", headers: authHeaders(token) }
  );
  const out = await readJson<{ setting: ReceiveSetting }>(
    res,
    "read receive setting"
  );
  return out.setting;
}

export async function setReceiveSetting(
  linkId: string,
  setting: ReceiveSetting
): Promise<ReceiveSetting> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `${LINKS_PATH}/${enc(linkId)}/receive-setting`,
    {
      method: "PUT",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ setting }),
    }
  );
  const out = await readJson<{ setting: ReceiveSetting }>(
    res,
    "set receive setting"
  );
  return out.setting;
}

/** The caller's OWN per-link borrow budget (#726 P6 gap 2) — never the
 *  peer's, same one-side discipline as the receive setting above. */
export async function getBorrowBudget(linkId: string): Promise<BorrowBudget> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `${LINKS_PATH}/${enc(linkId)}/borrow-budget`,
    { method: "GET", headers: authHeaders(token) }
  );
  return readJson<BorrowBudget>(res, "read borrow budget");
}

export async function setBorrowBudget(
  linkId: string,
  budgetBytes: number
): Promise<BorrowBudget> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `${LINKS_PATH}/${enc(linkId)}/borrow-budget`,
    {
      method: "PUT",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ budgetBytes }),
    }
  );
  return readJson<BorrowBudget>(res, "set borrow budget");
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
