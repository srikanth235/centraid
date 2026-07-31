/*
 * Renderer-side client for the vault's outbox / blocking-notifications surface
 * (issues #306, #308 — `/centraid/_vault/outbox*`, `/_vault/blocking`,
 * `/_vault/scope-requests`). An agent stages an external write (e.g. a
 * gmail send) as an inert artifact; the owner reviews it here — approve,
 * deny, or mint a standing "always allow" grant — before anything leaves
 * the vault. `GET /_vault/blocking` is the unified notifications: pending outbox
 * items + connections needing reconnection + Tier 3/4 parked invocations
 * + manifest scope-widening asks, all in one read.
 *
 * Sibling of `gateway-client-vault.ts` (which already owns the parked-
 * invocation surface reused here) — split into its own module per the
 * outbox/approvals screen's file ownership, not a technical necessity.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  nonJsonError,
  readJson,
} from "./gateway-client-core.js";
import type { VaultParkedEntry } from "./gateway-client-vault.js";

/** The connection an outbox item will drain through. */
export interface OutboxConnectionRef {
  kind: string;
  label: string;
}

/** One staged external write, from `GET /_vault/outbox` / `blocking().outbox`. */
export interface OutboxItem {
  itemId: string;
  actorId: string;
  connection: OutboxConnectionRef;
  actor: string | null;
  /** `'owner' | 'app' | 'agent' | 'assistant'` — the gateway refines the stored `ai_agent` kind (VaultPlane.refineActorKind); kept loose here. */
  actorKind: string;
  verb: string;
  target: string;
  /** The thing itself, as the owner reads it (to/subject/body, or connector-specific). */
  artifact: Record<string, unknown>;
  /** `'pending' | 'approved' | 'sent' | 'discarded' | 'failed'` (the DB enum; kept loose here). */
  status: string;
  grantId: string | null;
  stagedAt: string;
  decidedAt: string | null;
  drainedAt: string | null;
  result: Record<string, unknown> | null;
  note: string | null;
  /**
   * Whether the gateway has a request rebuilder for this item's verb
   * (issue #308 A5 UI slice) — the owner surface can only offer "edit
   * before approve" when this is `true`; otherwise editing isn't wired for
   * the verb yet and approving sends exactly what's staged.
   */
  canEdit: boolean;
}

/** A standing `(actor, verb, target)` rule minted by "always allow" (issue #306 phase 3). */
export interface OutboxGrant {
  grantId: string;
  actor: string | null;
  actorId: string;
  verb: string;
  target: string;
  createdAt: string;
  revokedAt: string | null;
}

/** A connection the owner needs to reconnect before its queued writes can drain. */
export interface OutboxNeedsAuth {
  connectionId: string;
  kind: string;
  label: string;
  note: string | null;
  /** Canonical start of the current reconnect episode. */
  attentionAt: string;
}

/** One scope triple of a manifest's declared access. */
export interface OutboxScopeTriple {
  schema: string;
  table?: string | null;
  verbs: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

/** A manifest asking beyond its last owner consent (issue #308 A3). */
export interface OutboxScopeRequest {
  requestId: string;
  plane: "app" | "agent";
  appId: string;
  purpose: string;
  scopes: OutboxScopeTriple[];
  requestedAt: string;
}

/** `GET /_vault/blocking` — everything waiting on the owner, unified. */
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

/** The one Notifications wire contract shared by desktop, web, and mobile. */
export interface NotificationsSummary {
  decisions: BlockingSummary & { count: number };
  notices: Notice[];
  unreadNoticeCount: number;
}

/**
 * The gateway's `InvokeOutcome` discriminated union, verbatim — the outbox
 * decide/revoke routes answer 200 only for `'executed'`; every other variant
 * (`parked` / `denied` / `failed` / `replayed`) is a real 409 body, not a
 * transport error, so callers read `.status` rather than catching.
 */
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

/** The `output` shape of an executed `outbox.decide` / `outbox.stage`. */
export interface OutboxDecideOutput {
  item_id: string;
  status: string;
  grant_id?: string;
}

/**
 * Read the raw outcome body regardless of HTTP status — the outbox
 * decide/revoke routes deliberately answer 409 for every non-executed
 * outcome, and the body is still the real (typed) outcome, not an error
 * page, so `readJson`'s throw-on-!ok would drop the fields callers need.
 */
async function readOutcome(res: Response, op: string): Promise<OutboxOutcome> {
  const text = await res.text();
  try {
    return JSON.parse(text) as OutboxOutcome;
  } catch {
    throw nonJsonError(op, res.status, text);
  }
}

/** The unified blocking notifications: outbox + needs-auth + parked + scope requests. */
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

/**
 * Subscribe to the content-free Notifications doorbell. The returned cleanup aborts
 * the authenticated stream; callers keep the 60s polling fallback.
 */
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
  /**
   * Refined actor kind (`app` / `agent` / `assistant` / `owner`) — same path
   * as outbox (VaultPlane.refineActorKind). Null when no actor is on the
   * receipt (issue #552).
   */
  actorKind: string | null;
  /** Display name for the actor when the gateway resolved one. */
  actor: string | null;
  /**
   * Standing outbox grant that auto-allowed this receipt, when present —
   * drives "Auto-allowed by standing grant" + inline Revoke (issue #552).
   */
  grantId: string | null;
  context: { kind: "fill"; origin: string } | null;
}

/** Recent low-friction acts and Locker reveals for review after the fact. */
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

/** Outbox items, optionally filtered by status (e.g. `['pending']`). */
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

/**
 * The owner's decision on one staged item — approve (optionally minting a
 * standing "always allow" grant), approve-with-edits, or discard (zero
 * egress). `outbox.decide`'s atomicity rule (issue #308 A5) requires the
 * artifact AND the injectable request replace together, and this surface
 * never exposes the request half to the owner (it may carry
 * `{{connection:…}}` placeholders) — so an edit passes only the revised
 * `artifact` on an `approve`, and the gateway rebuilds the wire request
 * server-side, keyed by the item's verb (`OutboxItem.canEdit` says whether
 * a rebuilder exists). There is no client path to submit a raw `request` —
 * the route refuses one outright.
 */
export async function decideOutboxItem(input: {
  itemId: string;
  decision: "approve" | "discard";
  /** Edit-then-approve (issue #308 A5 UI slice): only valid with `decision: 'approve'`. */
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

/** Standing `(actor, verb, target)` rules, live-first. */
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

/** Revoke a standing grant — any undrained rider it approved reparks (issue #308 A8). */
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

/** Open manifest scope-widening asks (issue #308 A3). */
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
