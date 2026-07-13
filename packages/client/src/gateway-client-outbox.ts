/*
 * Renderer-side client for the vault's outbox / blocking-inbox surface
 * (issues #306, #308 — `/centraid/_vault/outbox*`, `/_vault/blocking`,
 * `/_vault/scope-requests`). An agent stages an external write (e.g. a
 * gmail send) as an inert artifact; the owner reviews it here — approve,
 * deny, or mint a standing "always allow" grant — before anything leaves
 * the vault. `GET /_vault/blocking` is the unified inbox: pending outbox
 * items + connections needing reconnection + Tier 3/4 parked invocations
 * + manifest scope-widening asks, all in one read.
 *
 * Sibling of `gateway-client-vault.ts` (which already owns the parked-
 * invocation surface reused here) — split into its own module per the
 * outbox/approvals screen's file ownership, not a technical necessity.
 */

import {
  GatewayClientError,
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from './gateway-client-core.js';
import type { VaultParkedEntry } from './gateway-client-vault.js';

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
}

/** One scope triple of a manifest's declared access. */
export interface OutboxScopeTriple {
  schema: string;
  table?: string | null;
  verbs: string;
}

/** A manifest asking beyond its last owner consent (issue #308 A3). */
export interface OutboxScopeRequest {
  requestId: string;
  plane: 'app' | 'agent';
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

/**
 * The gateway's `InvokeOutcome` discriminated union, verbatim — the outbox
 * decide/revoke routes answer 200 only for `'executed'`; every other variant
 * (`parked` / `denied` / `failed` / `replayed`) is a real 409 body, not a
 * transport error, so callers read `.status` rather than catching.
 */
export type OutboxOutcome =
  | { status: 'executed'; invocationId: string; receiptId: string; output: unknown }
  | { status: 'parked'; invocationId: string; reason: string }
  | { status: 'denied'; invocationId?: string; receiptId: string; reason: string }
  | {
      status: 'failed';
      invocationId: string;
      receiptId: string;
      reason: string;
      predicate?: string;
    }
  | { status: 'replayed'; invocationId: string; output: unknown };

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
    throw new GatewayClientError(
      'gateway_error',
      `${op} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

/** The unified blocking inbox: outbox + needs-auth + parked + scope requests. */
export async function getBlocking(): Promise<BlockingSummary> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/blocking', {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<BlockingSummary>(res, 'fetch blocking inbox');
}

/** Outbox items, optionally filtered by status (e.g. `['pending']`). */
export async function listOutboxItems(statuses?: readonly string[]): Promise<OutboxItem[]> {
  const { baseUrl, token } = await auth();
  const qs = statuses && statuses.length > 0 ? `?status=${enc(statuses.join(','))}` : '';
  const res = await doFetch(baseUrl, `/centraid/_vault/outbox${qs}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ items: OutboxItem[] }>(res, 'list outbox items');
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
  decision: 'approve' | 'discard';
  /** Edit-then-approve (issue #308 A5 UI slice): only valid with `decision: 'approve'`. */
  artifact?: Record<string, unknown>;
  alwaysAllow?: boolean;
  note?: string;
}): Promise<OutboxOutcome> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/outbox/${enc(input.itemId)}`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      decision: input.decision,
      ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
      ...(input.alwaysAllow !== undefined ? { always_allow: input.alwaysAllow } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    }),
  });
  return readOutcome(res, 'decide outbox item');
}

/** Standing `(actor, verb, target)` rules, live-first. */
export async function listOutboxGrants(): Promise<OutboxGrant[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/outbox-grants', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ grants: OutboxGrant[] }>(res, 'list outbox grants');
  return body.grants ?? [];
}

/** Revoke a standing grant — any undrained rider it approved reparks (issue #308 A8). */
export async function revokeOutboxGrant(grantId: string): Promise<OutboxOutcome> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/outbox-grants/${enc(grantId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readOutcome(res, 'revoke outbox grant');
}

/** Open manifest scope-widening asks (issue #308 A3). */
export async function listScopeRequests(): Promise<OutboxScopeRequest[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/scope-requests', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ requests: OutboxScopeRequest[] }>(res, 'list scope requests');
  return body.requests ?? [];
}

/** Approve mints exactly the asked scopes; deny tombstones them (no re-nag). */
export async function decideScopeRequest(input: {
  requestId: string;
  approve: boolean;
}): Promise<{ request: OutboxScopeRequest; approved: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/scope-requests/${enc(input.requestId)}`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ approve: input.approve }),
  });
  return readJson(res, 'decide scope request');
}
