/*
 * Renderer-side client for snapshot edges and circle-backed commons (#731 —
 * `packages/gateway/src/routes/edges-routes.ts` and `edge-answer-routes.ts`).
 * An edge is a one-shot copy of a fixed item set. Ongoing co-owned sharing
 * uses the commons route below.
 *
 *   GET  /centraid/_gateway/edges              — this DEVICE's own edges
 *   POST /centraid/_gateway/edges               {mode, kind, itemType, ...}
 *   GET  /centraid/_gateway/edges/pending        — parked asks awaiting the
 *                                                   caller's OWNER decision
 *   POST /centraid/_gateway/edges/<edgeId>/answer {decision: "accept"|"refuse"}
 *
 * This is the People panel's data source, independent of any one blueprint
 * app mount — a share is a fact about the household, not about Photos or
 * Tasks. `centraid-inline.ts`'s `place()` covers the SAME wire door
 * from inside an app; this module exists because the People panel runs at
 * shell level, outside any app's `window.centraid`.
 */

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

/** One snapshot edge this device created, as `share_edges` answers it. */
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

/** Every snapshot edge this device created. */
export async function listGatewayEdges(): Promise<GatewayEdge[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, EDGES_PATH, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ edges: GatewayEdge[] }>(res, "list edges");
  return out.edges ?? [];
}

/** Give (copy) a fixed set of items into another vault. Irrevocable the
 *  instant it lands — callers warn BEFORE this fires, never after (D7). */
export async function giveEdge(input: {
  originVaultId: string;
  audienceVaultId: string;
  itemType: string;
  itemIds: string[];
  kind?: EdgeKind;
}): Promise<GatewayEdge> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, EDGES_PATH, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({
      edgeId: crypto.randomUUID(),
      originVaultId: input.originVaultId,
      audienceVaultId: input.audienceVaultId,
      mode: "snapshot",
      kind: input.kind ?? "add",
      itemType: input.itemType,
      itemIds: input.itemIds,
      verbs: "read",
    }),
  });
  return readJson<GatewayEdge>(res, "give");
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

/** One ongoing Commons offer awaiting receiver consent. Domain rows are not
 * projected until the receiver explicitly accepts it. */
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

/** Redeem a one-time, user-carried claim into this owner's chosen vault. The
 * raw token is sent once and is never retained by the client. */
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

/** One give parked by the audience's D9 `ask` receive setting — nothing was
 *  written yet; the audience owner has not answered. */
export interface PendingEdge {
  edgeId: string;
  peerVaultId: string;
  localVaultId: string;
  itemType: string;
  itemCount: number;
  createdAt: string;
}

/** Every parked ask awaiting a decision from an owner this caller is. */
export async function listPendingEdges(): Promise<PendingEdge[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${EDGES_PATH}/pending`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ pending: PendingEdge[] }>(
    res,
    "list pending edges"
  );
  return out.pending ?? [];
}

/**
 * Answer a parked ask. `accept` pulls the closure fresh from the origin and
 * projects it — nothing was staged while it waited; `refuse` deletes the
 * pointer row and writes nothing back to the origin (D9: a refusal reaches
 * forward only).
 */
export async function answerPendingEdge(
  edgeId: string,
  decision: "accept" | "refuse"
): Promise<{ edgeId: string; decision: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${EDGES_PATH}/${enc(edgeId)}/answer`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ decision }),
  });
  return readJson(res, "answer pending edge");
}

/**
 * Ask the gateway whether an edge can be closed. Completed give copies answer
 * with the receiver-owned refusal; commons revocation uses its grant surface.
 */
export async function closeGatewayEdge(
  edgeId: string
): Promise<Record<string, unknown>> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `${EDGES_PATH}/${enc(edgeId)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  return readJson(res, "close edge");
}
