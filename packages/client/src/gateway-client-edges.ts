/*
 * Renderer-side client for the gateway's edge surface (#726 P2/P4 —
 * `packages/gateway/src/routes/edges-routes.ts` and `edge-answer-routes.ts`).
 * An edge is either a snapshot (`mode: "snapshot"`, a GIVE — a copy, fixed
 * item set) or a live window (`mode: "live"`, a LEND — a standing scope, no
 * fixed items). Both ride the same `POST /centraid/_gateway/edges` door.
 *
 *   GET  /centraid/_gateway/edges              — this DEVICE's own edges
 *   POST /centraid/_gateway/edges               {mode, kind, itemType, ...}
 *   GET  /centraid/_gateway/edges/pending        — parked asks awaiting the
 *                                                   caller's OWNER decision
 *   POST /centraid/_gateway/edges/<edgeId>/answer {decision: "accept"|"refuse"}
 *
 * This is the People panel's data source, independent of any one blueprint
 * app mount — a share is a fact about the household, not about Photos or
 * Tasks. `centraid-inline.ts`'s `place()`/`lend()` cover the SAME wire door
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

export type EdgeMode = "snapshot" | "live";
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

export interface LendScopeInput {
  schema: string;
  table?: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

/** One edge this device created, as the gateway's `share_edges` row answers
 *  it — a GIVE (mode `snapshot`) or a LEND (mode `live`) alike. */
export interface GatewayEdge {
  edgeId: string;
  kind: EdgeKind;
  mode: EdgeMode;
  itemType: string;
  itemIds?: string[];
  scopes?: LendScopeInput[];
  originVaultId: string;
  audienceVaultId: string;
  verbs: string;
  status: EdgeStatus;
  reason?: string;
  accessReceiptId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Every edge this DEVICE created (give or lend, any status) — the origin
 *  half of "who am I sharing with, and how". */
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

/** Lend (open a live window over) a scope to another vault. Revocable at any
 *  time by the origin ("stop lending" — never "take back": what has already
 *  been read cannot be un-seen). */
export async function lendEdge(input: {
  originVaultId: string;
  audienceVaultId: string;
  itemType: string;
  scopes: LendScopeInput[];
}): Promise<GatewayEdge> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, EDGES_PATH, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({
      edgeId: crypto.randomUUID(),
      originVaultId: input.originVaultId,
      audienceVaultId: input.audienceVaultId,
      mode: "live",
      kind: "add",
      itemType: input.itemType,
      scopes: input.scopes,
      verbs: "read",
    }),
  });
  return readJson<GatewayEdge>(res, "lend");
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
 * Close an edge by id — `DELETE /centraid/_gateway/edges/:edgeId` (#726 P6
 * gap 1). The gateway disambiguates the caller's side: the ORIGIN owner
 * reaches `closeLiveEdge` ("Stop lending" — never "take back": what the
 * audience already read cannot be un-seen, only the window can close), the
 * AUDIENCE owner reaches `dropBorrowedEdge` ("Stop borrowing" — the audience's
 * own local decision, needing no peer contact to take effect). One door, one
 * function; the caller only ever supplies the edge id.
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
