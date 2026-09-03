import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

const EDGES_PATH = "/centraid/_gateway/edges";
const COMMONS_PATH = "/centraid/_gateway/commons";

export type EdgeMode = "snapshot";
export type EdgeKind = "add" | "move";
export type EdgeStatus =
  | "queued"
  | "in-flight"
  | "established"
  | "parked"
  | "denied"
  | "revoked"
  | "completed"
  | "failed";

export interface GatewayEdge {
  edgeId: string;
  kind: EdgeKind;
  mode: EdgeMode;
  itemType: string;
  itemIds?: string[];
  originVaultId: string;
  audienceVaultId: string;
  verbs: string;
  status: EdgeStatus;
  reason?: string;
  accessReceiptId?: string;
  createdAt: string;
  updatedAt: string;
}

export async function listGatewayEdges(): Promise<GatewayEdge[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, EDGES_PATH, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ edges: GatewayEdge[] }>(res, "list edges");
  return out.edges ?? [];
}

export async function createCommons(input: {
  originVaultId: string;
  containerType: string;
  containerId: string;
  members: {
    partyId?: string;
    vaultId?: string;
    capability: "read" | "read+write";
  }[];
  circleId?: string;
  circleName?: string;
}): Promise<Record<string, unknown>> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, COMMONS_PATH, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input),
  });
  return readJson<Record<string, unknown>>(res, "share commons");
}

export interface CommonsInvitation {
  invitationId: string;
  grantId: string;
  stewardVaultId: string;
  memberVaultId: string;
  currentSizeBytes: number;
  status: "pending" | "accepted" | "refused";
  createdAt: string;
  answeredAt?: string;
}

export async function listCommonsInvitations(
  actorVaultId: string
): Promise<CommonsInvitation[]> {
  const { baseUrl, token } = await auth();
  const query = new URLSearchParams({ actorVaultId });
  const res = await doFetch(
    baseUrl,
    `${COMMONS_PATH}/invitations?${query.toString()}`,
    { method: "GET", headers: authHeaders(token) }
  );
  const out = await readJson<{ invitations: CommonsInvitation[] }>(
    res,
    "list commons invitations"
  );
  return out.invitations ?? [];
}

export async function claimCommonsInvitation(
  actorVaultId: string,
  stewardVaultId: string,
  claimToken: string
): Promise<{ claimed: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${COMMONS_PATH}/invitations/claim`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ actorVaultId, stewardVaultId, claimToken }),
  });
  return readJson(res, "redeem commons invitation");
}

export async function answerCommonsInvitation(
  invitationId: string,
  actorVaultId: string,
  answer: "accept" | "refuse"
): Promise<CommonsInvitation> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `${COMMONS_PATH}/invitations/${enc(invitationId)}/answer`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ actorVaultId, answer }),
    }
  );
  const out = await readJson<{ invitation: CommonsInvitation }>(
    res,
    "answer commons invitation"
  );
  return out.invitation;
}

export interface CommonsRecoveryGrant {
  actorVaultId: string;
  grantId: string;
  containerType: string;
  steward: {
    presence:
      | "unknown"
      | "reachable"
      | "degraded"
      | "absent"
      | "link-down"
      | "parked";
    stewardVaultId?: string;
    silentForMs?: number;
    fault?: string;
  };
  supersededBy?: string;
}

export interface CommonsRecoveryDelivery {
  partyId: string;
  memberVaultId?: string;
  state: "queued" | "delivered" | "claim" | "unreachable";
}

export interface CommonsRecoveryOutcome {
  state: "recovered";
  grantId: string;
  invitedPartyIds: string[];
  invitations: CommonsRecoveryDelivery[];
  replayed: boolean;
}

const RECOVERY_REFUSALS: Record<string, string> = {
  "already-steward": "You already run this shared space.",
  "parked-on-fault":
    "This copy stopped syncing because its history could not be verified, so it must not be used to re-found the space.",
  "grant-not-live": "That shared space is no longer live.",
  "no-local-replica":
    "This vault holds no copy of that shared space to re-found it from.",
};

export async function listCommonsRecovery(
  actorVaultId: string
): Promise<CommonsRecoveryGrant[]> {
  const { baseUrl, token } = await auth();
  const query = new URLSearchParams({ actorVaultId });
  const res = await doFetch(
    baseUrl,
    `${COMMONS_PATH}/recovery?${query.toString()}`,
    { method: "GET", headers: authHeaders(token) }
  );
  const out = await readJson<{
    grants?: Omit<CommonsRecoveryGrant, "actorVaultId">[];
  }>(res, "read shared-space recovery");
  return (out.grants ?? []).map((grant) => ({ ...grant, actorVaultId }));
}

export async function recoverCommons(
  actorVaultId: string,
  grantId: string
): Promise<CommonsRecoveryOutcome> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${COMMONS_PATH}/recovery`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ actorVaultId, grantId }),
  });
  if (res.status === 409) {
    const refusal = (await res.json()) as { reason?: string };
    const reason = refusal.reason ?? "unknown";
    throw new Error(RECOVERY_REFUSALS[reason] ?? `Recovery refused: ${reason}`);
  }
  return readJson<CommonsRecoveryOutcome>(res, "recover shared space");
}
