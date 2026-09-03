import { authHeaders, doFetch, readJson } from "../../gateway-client-core.js";
import type { GatewayAuth } from "../../gateway-client-core.js";
import { listGatewayLinks } from "../../gateway-client-links.js";
import type { GatewayLink } from "../../gateway-client-links.js";

interface InlineLinkDestination {
  linkId: string;
  vaultId: string;
  partyId: string;
  approved: boolean;
  label: string | null;
}

interface InlineCommonsResident {
  grantId: string;
  itemType: string;
  itemId: string;
  originItemId: string;
}

interface InlineCommonsShareResult extends Record<string, unknown> {
  grantId: string;
  claims: Array<{ partyId: string; claimToken: string }>;
}

export async function loadCommonsResidents(
  auth: GatewayAuth,
  actorVaultId: string
): Promise<InlineCommonsResident[]> {
  const query = new URLSearchParams({ actorVaultId });
  const response = await doFetch(
    auth.baseUrl,
    `/centraid/_gateway/commons/resident?${query.toString()}`,
    { headers: authHeaders(auth.token) }
  );
  const out = await readJson<{ items?: InlineCommonsResident[] }>(
    response,
    "list resident commons items"
  );
  return out.items ?? [];
}

export async function performCommonsRetain(
  auth: GatewayAuth,
  input: { actorVaultId: string; itemType: string; itemId: string }
): Promise<{ retained: boolean; grantIds: string[] }> {
  const response = await doFetch(
    auth.baseUrl,
    "/centraid/_gateway/commons/retain",
    {
      method: "POST",
      headers: authHeaders(auth.token, "application/json"),
      body: JSON.stringify(input),
    }
  );
  return readJson(response, "save commons item to my vault");
}

export function linkDestinationsFor(
  links: readonly GatewayLink[],
  ownVaultId: string
): InlineLinkDestination[] {
  return links.flatMap((link) => {
    if (link.revoked || !link.approved) return [];
    const vaultId =
      link.vaultA === ownVaultId
        ? link.vaultB
        : link.vaultB === ownVaultId
          ? link.vaultA
          : undefined;
    const partyId = link.vaultA === vaultId ? link.partyIdA : link.partyIdB;
    const label = link.vaultA === vaultId ? link.labelA : link.labelB;
    return vaultId && partyId
      ? [
          {
            linkId: link.linkId,
            vaultId,
            partyId,
            approved: true,
            label: label ?? null,
          },
        ]
      : [];
  });
}

export async function loadLinkDestinations(
  ownVaultId: string
): Promise<InlineLinkDestination[]> {
  try {
    return linkDestinationsFor(await listGatewayLinks(), ownVaultId);
  } catch {
    return [];
  }
}

export async function performCommonsShare(
  auth: GatewayAuth,
  opts: {
    sourceVaultId: string;
    containerType: string;
    containerId: string;
    members: {
      partyId?: string;
      vaultId?: string;
      capability: "read" | "read+write";
    }[];
    circleId?: string;
  }
): Promise<InlineCommonsShareResult> {
  const response = await doFetch(auth.baseUrl, "/centraid/_gateway/commons", {
    method: "POST",
    headers: authHeaders(auth.token, "application/json"),
    body: JSON.stringify({
      originVaultId: opts.sourceVaultId,
      containerType: opts.containerType,
      containerId: opts.containerId,
      members: opts.members,
      ...(opts.circleId ? { circleId: opts.circleId } : {}),
    }),
  });
  return readJson<InlineCommonsShareResult>(response, "share commons");
}
