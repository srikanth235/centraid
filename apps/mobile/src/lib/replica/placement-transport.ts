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

export interface CommonsIntent {
  containerType: string;
  containerId: string;
  sourceVaultId: string;
  members: readonly {
    /** Required when the destination is a linked, unmounted peer. */
    partyId?: string;
    /** Absent while this is an invitation waiting for the person to join. */
    vaultId?: string;
    capability: "read" | "read+write";
  }[];
  circleId?: string;
}

export interface CommonsRecord {
  grantId: string;
  circleId: string;
  state: "active" | "invited";
  currentSizeBytes: number;
  maxSizeBytes?: number | null;
  claims: Array<{ partyId: string; claimToken: string }>;
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

export interface CommonsResident {
  grantId: string;
  itemType: string;
  itemId: string;
  originItemId: string;
}

export async function listCommonsResidents(
  baseUrl: string,
  actorVaultId: string
): Promise<CommonsResident[]> {
  const query = new URLSearchParams({ actorVaultId });
  const response = await fetch(
    new URL(`${ROUTES.gatewayCommons}/resident?${query.toString()}`, baseUrl),
    { headers: authHeader() }
  );
  if (!response.ok)
    throw new Error(`list resident commons items failed (${response.status})`);
  const out = (await response.json()) as { items?: CommonsResident[] };
  return out.items ?? [];
}

export async function retainCommonsItem(
  baseUrl: string,
  input: { actorVaultId: string; itemType: string; itemId: string }
): Promise<{ retained: boolean; grantIds: string[] }> {
  const response = await fetch(
    new URL(`${ROUTES.gatewayCommons}/retain`, baseUrl),
    {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  if (!response.ok)
    throw new Error(`save commons item failed (${response.status})`);
  return (await response.json()) as {
    retained: boolean;
    grantIds: string[];
  };
}

export async function listCommonsInvitations(
  baseUrl: string,
  actorVaultId: string
): Promise<CommonsInvitation[]> {
  const query = new URLSearchParams({ actorVaultId });
  const response = await fetch(
    new URL(
      `${ROUTES.gatewayCommons}/invitations?${query.toString()}`,
      baseUrl
    ),
    { headers: authHeader() }
  );
  if (!response.ok)
    throw new Error(`list commons invitations failed (${response.status})`);
  const out = (await response.json()) as {
    invitations: CommonsInvitation[];
  };
  return out.invitations ?? [];
}

/** Redeem an ephemeral one-time invite into the authenticated receiver's
 * selected vault. The caller discards claimToken immediately after this call. */
export async function claimCommonsInvitation(
  baseUrl: string,
  actorVaultId: string,
  stewardVaultId: string,
  claimToken: string
): Promise<{ claimed: boolean }> {
  const response = await fetch(
    new URL(`${ROUTES.gatewayCommons}/invitations/claim`, baseUrl),
    {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ actorVaultId, stewardVaultId, claimToken }),
    }
  );
  if (!response.ok)
    throw new Error(`redeem commons invitation failed (${response.status})`);
  return (await response.json()) as { claimed: boolean };
}

export async function answerCommonsInvitation(
  baseUrl: string,
  invitationId: string,
  actorVaultId: string,
  answer: "accept" | "refuse"
): Promise<CommonsInvitation> {
  const response = await fetch(
    new URL(
      `${ROUTES.gatewayCommons}/invitations/${encodeURIComponent(invitationId)}/answer`,
      baseUrl
    ),
    {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ actorVaultId, answer }),
    }
  );
  if (!response.ok)
    throw new Error(`answer commons invitation failed (${response.status})`);
  const out = (await response.json()) as { invitation: CommonsInvitation };
  return out.invitation;
}

/** Compile a shared container into each joined member's vault. */
export async function postCommons(
  baseUrl: string,
  input: CommonsIntent
): Promise<CommonsRecord> {
  const response = await fetch(new URL("/centraid/_gateway/commons", baseUrl), {
    method: "POST",
    headers: {
      ...authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      originVaultId: input.sourceVaultId,
      containerType: input.containerType,
      containerId: input.containerId,
      members: input.members,
      ...(input.circleId ? { circleId: input.circleId } : {}),
    }),
  });
  const body = (await response.json()) as CommonsRecord | { message?: string };
  if (response.status >= 500) {
    throw new Error(`Sharing gateway unavailable (${response.status})`);
  }
  if (!response.ok) {
    throw new PlacementSubmissionError(
      "message" in body && body.message
        ? body.message
        : `Share failed (${response.status})`,
      response.status === 401 || response.status === 403 ? "denied" : "failed"
    );
  }
  return body as CommonsRecord;
}
