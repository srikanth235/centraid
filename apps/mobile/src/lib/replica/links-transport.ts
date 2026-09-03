import { authHeader } from "../gateway";

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

export async function listLinks(baseUrl: string): Promise<GatewayLink[]> {
  const out = await getJson<{ links?: unknown }>(baseUrl, LINKS_PATH);
  if (!Array.isArray(out.links)) return [];
  return out.links.flatMap((entry) => {
    const link = parseGatewayLink(entry);
    return link ? [link] : [];
  });
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

export interface GatewayLinkTicket {
  vaultId: string;
  ticket: string;
  expiresAt: string;
}

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

export interface RedeemLinkTicketOutcome {
  state: "linked" | "unreachable";
  link?: GatewayLink;
  detail?: string;
}

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
