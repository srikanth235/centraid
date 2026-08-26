/*
 * Renderer-side client for the gateway's link surface (#726): the channel a
 * grant is delivered over (#825), and where a remote ticket redemption lands
 * (D3 — one table serves both). Outside `ROUTES`: the route owns `LINKS_PATH`.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

const LINKS_PATH = "/centraid/_gateway/links";

export interface GatewayLink {
  linkId: string;
  vaultA: string;
  vaultB: string;
  labelA: string | null;
  labelB: string | null;
  partyIdA?: string | null;
  partyIdB?: string | null;
  approvedByA: boolean;
  approvedByB: boolean;
  approved: boolean;
  /** Null when both sides are co-hosted; never "remote"/"local" in copy (D3). */
  remoteVaultId: string | null;
  revoked: boolean;
  createdAt: string;
}

/** Total parser (#750): a drifted row is dropped, never half-built. */
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

export async function approveGatewayLink(linkId: string): Promise<GatewayLink> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${LINKS_PATH}/${enc(linkId)}/approve`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
  });
  return (await readJson<{ link: GatewayLink }>(res, "approve link")).link;
}

/** One-time, 15-minute TTL. */
export interface GatewayLinkTicket {
  vaultId: string;
  ticket: string;
  expiresAt: string;
}

/** Owning `vaultId` IS the authorization. */
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

/** `unreachable` is a fact, not an exception; other refusals throw. */
export interface RedeemLinkTicketOutcome {
  state: "linked" | "unreachable";
  link?: GatewayLink;
  detail?: string;
}

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
