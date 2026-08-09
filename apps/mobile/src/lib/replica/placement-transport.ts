import { ROUTES } from "@centraid/protocol";

import { authHeader } from "../gateway";
import type { PlacementIntent, PlacementRecord } from "./multi-vault-reader";

export class PlacementSubmissionError extends Error {
  constructor(
    message: string,
    readonly placementStatus: "denied" | "failed"
  ) {
    super(message);
    this.name = "PlacementSubmissionError";
  }
}

/**
 * `/edges`' wire status vocabulary (queued|in-flight|established|parked|
 * denied|revoked|completed|failed) succeeded `/placements`' narrower one
 * (…|executed|…, #726 P2). The durable outbox (`multi-vault-reader.ts`,
 * `multi-vault-session.ts`) still only knows the old five-plus-one values —
 * translate the one terminal-success rename here, at the transport boundary,
 * rather than touching every reader of `PlacementRecord.status`.
 */
function toPlacementStatus(status: unknown): PlacementRecord["status"] {
  if (status === "completed" || status === "established") return "executed";
  return status === "queued" ||
    status === "in-flight" ||
    status === "parked" ||
    status === "denied"
    ? status
    : "failed";
}

/** One `/edges` response, always carrying exactly the one item this outbox asked for. */
interface EdgeWire {
  edgeId: string;
  status: string;
  itemIds?: string[];
  reason?: string;
  createdAt?: string;
  updatedAt?: string;
}

function toPlacementRecord(
  edge: EdgeWire,
  input: PlacementIntent
): PlacementRecord {
  // `updatePlacement` (multi-vault-reader.ts) overwrites both timestamps
  // from local state regardless (createdAt kept from the existing row,
  // updatedAt stamped fresh) — these only need to satisfy the shape.
  const now = new Date().toISOString();
  return {
    ...input,
    status: toPlacementStatus(edge.status),
    ...(edge.reason ? { reason: edge.reason } : {}),
    createdAt: edge.createdAt ?? now,
    updatedAt: edge.updatedAt ?? now,
  };
}

/**
 * Shared foreground/background transport for the durable placement outbox.
 * The wire door is `/edges` now (#726 P2) — one edge can carry a SET of
 * items, but this outbox still queues and replays one item per row, so the
 * translation is one-item-in, one-item-out: `PlacementIntent`/
 * `PlacementRecord` (the outbox's own persisted shape) are untouched.
 */
export async function postPlacement(
  baseUrl: string,
  input: PlacementIntent
): Promise<PlacementRecord> {
  const response = await fetch(new URL(ROUTES.gatewayEdges, baseUrl), {
    method: "POST",
    headers: {
      ...authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      edgeId: input.linkToken,
      originVaultId: input.sourceVaultId,
      audienceVaultId: input.targetVaultId,
      mode: "snapshot",
      kind: input.kind,
      itemType: input.itemType,
      itemIds: [input.itemId],
      verbs: "read",
    }),
  });
  const body = (await response.json()) as EdgeWire | { message?: string };
  if (response.status >= 500) {
    throw new Error(`Placement gateway unavailable (${response.status})`);
  }
  if (!response.ok) {
    throw new PlacementSubmissionError(
      "message" in body && body.message
        ? body.message
        : `Placement failed (${response.status})`,
      response.status === 401 || response.status === 403 ? "denied" : "failed"
    );
  }
  return toPlacementRecord(body as EdgeWire, input);
}

/** A live-edge scope declaration — the same shape `consent_grant_scope`
 *  stores (`edges-routes.ts`'s `LendScope`). */
export interface LendScopeInput {
  schema: string;
  table?: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

export interface LendIntent {
  linkToken: string;
  itemType: string;
  scopes: readonly LendScopeInput[];
  sourceVaultId: string;
  targetVaultId: string;
}

export interface LendRecord {
  linkToken: string;
  status: PlacementRecord["status"];
  reason?: string;
}

/**
 * Open a live edge — a LEND, as opposed to `postPlacement`'s GIVE. Unlike
 * `place()`, lending is NOT queued through the durable placement outbox: a
 * live window is a real-time round trip with the origin's peer plane, not a
 * fixed set of bytes to replay later, so a caller offline gets an honest
 * failure instead of a silent queue entry (mirrors the web inline client's
 * `lend()` — "Lending needs a gateway connection").
 */
export async function postLend(
  baseUrl: string,
  input: LendIntent
): Promise<LendRecord> {
  const response = await fetch(new URL(ROUTES.gatewayEdges, baseUrl), {
    method: "POST",
    headers: {
      ...authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      edgeId: input.linkToken,
      originVaultId: input.sourceVaultId,
      audienceVaultId: input.targetVaultId,
      mode: "live",
      kind: "add",
      itemType: input.itemType,
      scopes: input.scopes,
      verbs: "read",
    }),
  });
  const body = (await response.json()) as EdgeWire | { message?: string };
  if (response.status >= 500) {
    throw new Error(`Lend gateway unavailable (${response.status})`);
  }
  if (!response.ok) {
    throw new PlacementSubmissionError(
      "message" in body && body.message
        ? body.message
        : `Lend failed (${response.status})`,
      response.status === 401 || response.status === 403 ? "denied" : "failed"
    );
  }
  const edge = body as EdgeWire;
  return {
    linkToken: input.linkToken,
    status: toPlacementStatus(edge.status),
    ...(edge.reason ? { reason: edge.reason } : {}),
  };
}
