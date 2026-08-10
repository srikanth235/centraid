// Renderer-side transport for the gateway's link surface (#726 P2/P3 —
// `packages/gateway/src/routes/vault-links-routes.ts`), mirroring
// `placement-transport.ts`'s shape. Mobile's own People/Sharing screen data
// source — a link is the ceremony a cross-owner edge needs before it may
// cross, same-machine or across the world alike (D3).
import { authHeader } from "../gateway";

const LINKS_PATH = "/centraid/_gateway/links";

export type ReceiveSetting = "accept" | "ask" | "refuse";

export interface GatewayLink {
  linkId: string;
  vaultA: string;
  vaultB: string;
  /** Each vault's own name/self-declared label (#726 P6 gap 3) — `null` when
   *  genuinely unknown. Symmetric with `vaultA`/`vaultB`: `labelA` names
   *  `vaultA`. */
  labelA: string | null;
  labelB: string | null;
  /** Party identities exchanged by the approved link ceremony. */
  partyIdA?: string | null;
  partyIdB?: string | null;
  approvedByA: boolean;
  approvedByB: boolean;
  approved: boolean;
  remoteVaultId: string | null;
  revoked: boolean;
  createdAt: string;
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    headers: authHeader(),
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return (await response.json()) as T;
}

export async function listLinks(baseUrl: string): Promise<GatewayLink[]> {
  const out = await getJson<{ links: GatewayLink[] }>(baseUrl, LINKS_PATH);
  return out.links ?? [];
}

export async function approveLink(
  baseUrl: string,
  linkId: string
): Promise<GatewayLink> {
  const response = await fetch(
    new URL(`${LINKS_PATH}/${encodeURIComponent(linkId)}/approve`, baseUrl),
    { method: "POST", headers: authHeader() }
  );
  if (!response.ok) throw new Error(`approve link failed (${response.status})`);
  const out = (await response.json()) as { link: GatewayLink };
  return out.link;
}

export async function getReceiveSetting(
  baseUrl: string,
  linkId: string
): Promise<ReceiveSetting> {
  const out = await getJson<{ setting: ReceiveSetting }>(
    baseUrl,
    `${LINKS_PATH}/${encodeURIComponent(linkId)}/receive-setting`
  );
  return out.setting;
}

export async function setReceiveSetting(
  baseUrl: string,
  linkId: string,
  setting: ReceiveSetting
): Promise<ReceiveSetting> {
  const response = await fetch(
    new URL(
      `${LINKS_PATH}/${encodeURIComponent(linkId)}/receive-setting`,
      baseUrl
    ),
    {
      method: "PUT",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ setting }),
    }
  );
  if (!response.ok)
    throw new Error(`set receive setting failed (${response.status})`);
  const out = (await response.json()) as { setting: ReceiveSetting };
  return out.setting;
}

/** A minted, pasteable/scannable ticket for a vault the caller owns
 *  (#726 audit finding 1) — the remote ceremony's owner-facing door. One-time,
 *  15-minute TTL. */
export interface GatewayLinkTicket {
  vaultId: string;
  /** Opaque — hand it back to `redeemLinkTicket` verbatim. */
  ticket: string;
  expiresAt: string;
}

/** Mint a one-time ticket for `vaultId` to show (as a QR, or to paste) to
 *  whoever is redeeming it. Owning `vaultId` IS the authorization — the
 *  gateway refuses `not_found` for a vault the caller does not own. */
export async function mintLinkTicket(
  baseUrl: string,
  vaultId: string
): Promise<GatewayLinkTicket> {
  const response = await fetch(new URL(`${LINKS_PATH}/ticket`, baseUrl), {
    method: "POST",
    headers: { ...authHeader(), "content-type": "application/json" },
    body: JSON.stringify({ vaultId }),
  });
  if (!response.ok)
    throw new Error(`mint link ticket failed (${response.status})`);
  return (await response.json()) as GatewayLinkTicket;
}

/** What redeeming a ticket answers when it does not end in a link — a
 *  reachability or protocol fact, never an exception the caller has to
 *  unwrap. Every other typed refusal still throws, same as this file's other
 *  calls. */
export interface RedeemLinkTicketOutcome {
  state: "linked" | "unreachable";
  link?: GatewayLink;
  detail?: string;
}

/**
 * Redeem a ticket someone showed you into `vaultId` — the LOCAL vault the
 * caller owns and wants linked. The gateway dials the peer itself; this call
 * simply waits for that ceremony's answer.
 */
export async function redeemLinkTicket(
  baseUrl: string,
  vaultId: string,
  ticket: string
): Promise<RedeemLinkTicketOutcome> {
  const response = await fetch(new URL(`${LINKS_PATH}/redeem`, baseUrl), {
    method: "POST",
    headers: { ...authHeader(), "content-type": "application/json" },
    body: JSON.stringify({ vaultId, ticket }),
  });
  if (!response.ok)
    throw new Error(`redeem link ticket failed (${response.status})`);
  return (await response.json()) as RedeemLinkTicketOutcome;
}
