// Renderer-side client for the vault's outbox / blocking-notifications surface
// (#306, #308). An agent stages an external write as an inert artifact; the
// owner decides before anything leaves the vault.

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  nonJsonError,
  readJson,
} from "./gateway-client-core.js";
import type { VaultParkedEntry } from "./gateway-client-vault.js";

export interface OutboxConnectionRef {
  kind: string;
  label: string;
}

export interface OutboxItem {
  itemId: string;
  actorId: string;
  connection: OutboxConnectionRef;
  actor: string | null;
  actorKind: string;
  verb: string;
  target: string;
  artifact: Record<string, unknown>;
  /** `'pending' | 'approved' | 'sent' | 'discarded' | 'failed'`, kept loose. */
  status: string;
  grantId: string | null;
  stagedAt: string;
  decidedAt: string | null;
  drainedAt: string | null;
  result: Record<string, unknown> | null;
  note: string | null;
  /** Offer "edit before approve" only when true — otherwise approving sends
   *  exactly what is staged (#308). */
  canEdit: boolean;
}

export interface OutboxGrant {
  grantId: string;
  actor: string | null;
  actorId: string;
  verb: string;
  target: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface OutboxNeedsAuth {
  connectionId: string;
  kind: string;
  label: string;
  note: string | null;
  attentionAt: string;
}

export interface OutboxScopeTriple {
  schema: string;
  table?: string | null;
  verbs: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

export interface OutboxScopeRequest {
  requestId: string;
  plane: "app" | "agent";
  appId: string;
  scopes: OutboxScopeTriple[];
  requestedAt: string;
}

export interface BlockingSummary {
  outbox: OutboxItem[];
  needsAuth: OutboxNeedsAuth[];
  parked: VaultParkedEntry[];
  scopeRequests: OutboxScopeRequest[];
}

export interface Notice {
  noticeId: string;
  kind: string;
  sourceRef: string;
  headline: string;
  detail: Record<string, unknown>;
  severity: "info" | "warning" | "high";
  count: number;
  firstAt: string;
  lastAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface NotificationsSummary {
  decisions: BlockingSummary & { count: number };
  notices: Notice[];
  unreadNoticeCount: number;
}

/** The gateway's `InvokeOutcome`, verbatim: only `executed` answers 200, and
 *  every other variant is a real 409 body — read `.status`, do not catch. */
export type OutboxOutcome =
  | {
      status: "executed";
      invocationId: string;
      receiptId: string;
      output: unknown;
    }
  | { status: "parked"; invocationId: string; reason: string }
  | {
      status: "denied";
      invocationId?: string;
      receiptId: string;
      reason: string;
    }
  | {
      status: "failed";
      invocationId: string;
      receiptId: string;
      reason: string;
      predicate?: string;
    }
  | { status: "replayed"; invocationId: string; output: unknown };

export interface OutboxDecideOutput {
  item_id: string;
  status: string;
  grant_id?: string;
}

/** Body regardless of status: the deliberate 409s carry a typed outcome. */
async function readOutcome(res: Response, op: string): Promise<OutboxOutcome> {
  const text = await res.text();
  try {
    return JSON.parse(text) as OutboxOutcome;
  } catch {
    throw nonJsonError(op, res.status, text);
  }
}

export async function getBlocking(): Promise<BlockingSummary> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/blocking", {
    method: "GET",
    headers: authHeaders(token),
  });
  return readJson<BlockingSummary>(res, "fetch blocking notifications");
}

export async function getNotifications(
  includeArchived = false
): Promise<NotificationsSummary> {
  const { baseUrl, token } = await auth();
  const suffix = includeArchived ? "?include_archived=true" : "";
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/notifications${suffix}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  return readJson<NotificationsSummary>(res, "fetch Notifications");
}

export async function updateNotice(
  noticeId: string,
  action: "read" | "archive"
): Promise<Notice> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/notifications/notices/${enc(noticeId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ action }),
    }
  );
  const body = await readJson<{ notice: Notice }>(res, `${action} notice`);
  return body.notice;
}

/** A content-free doorbell; callers keep the 60s polling fallback. */
export async function subscribeNotificationsChanges(
  onChange: () => void,
  signal?: AbortSignal
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/notifications/events", {
    method: "GET",
    headers: authHeaders(token),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    throw new Error(`subscribe to Notifications changes: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readNext = async (): Promise<void> => {
    if (signal?.aborted) return;
    const next = await reader.read();
    if (next.done) return;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (
        event
          .split("\n")
          .some((line) => line === "event: notifications-changed")
      )
        onChange();
      boundary = buffer.indexOf("\n\n");
    }
    return readNext();
  };
  await readNext();
}

export interface ReviewEntry {
  receiptId: string;
  action: string;
  objectType: string;
  objectId: string | null;
  decision: string;
  occurredAt: string;
  risk: string | null;
  invocationId: string | null;
  actorId: string | null;
  /** Null when no actor is on the receipt (#552). */
  actorKind: string | null;
  actor: string | null;
  /** Set when a standing grant auto-allowed this receipt (#552). */
  grantId: string | null;
  context: { kind: "fill"; origin: string } | null;
}

export async function getReview(limit = 20): Promise<ReviewEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/review?limit=${enc(String(limit))}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const body = await readJson<{ entries: ReviewEntry[] }>(
    res,
    "fetch review feed"
  );
  return body.entries ?? [];
}

export async function listOutboxItems(
  statuses?: readonly string[]
): Promise<OutboxItem[]> {
  const { baseUrl, token } = await auth();
  const qs =
    statuses && statuses.length > 0 ? `?status=${enc(statuses.join(","))}` : "";
  const res = await doFetch(baseUrl, `/centraid/_vault/outbox${qs}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ items: OutboxItem[] }>(
    res,
    "list outbox items"
  );
  return body.items ?? [];
}

/** An edit passes only the revised `artifact`; the gateway rebuilds the wire
 *  request server-side. There is no client path to submit a raw `request` —
 *  the route refuses one outright (#308). */
export async function decideOutboxItem(input: {
  itemId: string;
  decision: "approve" | "discard";
  /** Only valid with `decision: 'approve'`. */
  artifact?: Record<string, unknown>;
  alwaysAllow?: boolean;
  note?: string;
}): Promise<OutboxOutcome> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/outbox/${enc(input.itemId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({
        decision: input.decision,
        ...(input.artifact === undefined ? {} : { artifact: input.artifact }),
        ...(input.alwaysAllow === undefined
          ? {}
          : { always_allow: input.alwaysAllow }),
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    }
  );
  return readOutcome(res, "decide outbox item");
}

export async function listOutboxGrants(): Promise<OutboxGrant[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/outbox-grants", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ grants: OutboxGrant[] }>(
    res,
    "list outbox grants"
  );
  return body.grants ?? [];
}

/** Revoke a standing grant — any undrained rider it approved reparks (#308). */
export async function revokeOutboxGrant(
  grantId: string
): Promise<OutboxOutcome> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/outbox-grants/${enc(grantId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    }
  );
  return readOutcome(res, "revoke outbox grant");
}

export async function listScopeRequests(): Promise<OutboxScopeRequest[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/scope-requests", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ requests: OutboxScopeRequest[] }>(
    res,
    "list scope requests"
  );
  return body.requests ?? [];
}

/** Approve mints exactly the asked scopes; deny tombstones them (no re-nag). */
export async function decideScopeRequest(input: {
  requestId: string;
  approve: boolean;
}): Promise<{ request: OutboxScopeRequest; approved: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/scope-requests/${enc(input.requestId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ approve: input.approve }),
    }
  );
  return readJson(res, "decide scope request");
}
