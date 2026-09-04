/**
 * The one pending-write overlay engine (#738).
 *
 * A seat's honest local read is replica ⊕ outbox. Apps declare only how an
 * action projects into replica rows; the shell owns intent identity, status,
 * settlement and presentation metadata. This module is deliberately pure so
 * the browser shell and the native replica adapter consume the same law.
 */

/**
 * THE ONE PENDING COLUMN (#922 G3). A projected row carries the intent that
 * projected it and nothing else the entity's schema does not declare, so a
 * handler — gateway, shell or phone — reads a schema-pure row. Everything the
 * member is told about that write (status, reason, attempts, when it was
 * saved, the versions a conflict names) rides the read's sidecar, keyed by
 * this value.
 */
export const PENDING_OVERLAY_FIELDS = {
  key: "__centraid_pending_key",
} as const;

export type PendingOverlayStatus =
  | "queued"
  | "sending"
  | "parked"
  | "denied"
  | "conflict"
  | "conflict-base-missing"
  | "failed"
  | "expired"
  | "cancelled";

/**
 * Past this, a queued change stops being "in a moment" and starts being a
 * thing the member left behind, so the badge names the day it was saved.
 * NOTHING EXPIRES ON ITS OWN because of this number (#922 G9): it changes the
 * SENTENCE, never the intent — a queued write waits until the member or the
 * gateway settles it.
 */
export const PENDING_OVERLAY_AGED_MS = 24 * 60 * 60 * 1_000;

export type PendingOverlaySettlement =
  | { status: "executed" }
  | {
      status: Exclude<PendingOverlayStatus, "queued" | "sending">;
      reason?: string;
      stewardLabel?: string;
      expectedVersion?: number;
      actualVersion?: number;
    };

export type PendingProjectionValue =
  | null
  | boolean
  | number
  | string
  | PendingProjectionValue[]
  | { [key: string]: PendingProjectionValue };

export interface PendingProjectionUpsert {
  op: "upsert";
  entity: string;
  rowId: string;
  values: Record<string, PendingProjectionValue>;
  purpose?: string;
  shapeId?: string;
}

export interface PendingProjectionDelete {
  op: "delete";
  entity: string;
  rowId: string;
  purpose?: string;
  shapeId?: string;
}

export type PendingProjectionMutation =
  | PendingProjectionUpsert
  | PendingProjectionDelete;

export interface PendingProjectionContext {
  appId: string;
  action: string;
  input: Readonly<Record<string, unknown>>;
  intentId: string;
}

export interface PendingProjectionResult {
  optimistic: PendingProjectionMutation[];
  /**
   * Values the projection MINTED that the write must carry (#922 G2) — the
   * row ids above all. The write door merges them into the action input, so
   * the origin creates the very row the seat is already showing.
   */
  input?: Record<string, PendingProjectionValue>;
  baseVersions?: Array<{
    shapeId?: string;
    entity: string;
    rowId: string;
    version: number;
  }>;
}

export type PendingActionProjection = (
  context: PendingProjectionContext
) => PendingProjectionMutation[] | PendingProjectionResult;

export interface PendingProjectionExclusion {
  /** A structural exclusion, not an unimplemented projection. */
  excluded: true;
  reason: string;
}

export interface PendingProjectionDeclaration {
  appId: string;
  actions: Record<string, PendingActionProjection | PendingProjectionExclusion>;
  /**
   * Actions that revise a retained synthetic row, keyed by the incoming edit
   * action and naming the original queued action(s) it may replace. Keeping
   * this beside the projection prevents foreign keys such as `project_id` or
   * `group_id` from being mistaken for the row currently being edited.
   */
  revisions?: Record<string, readonly string[]>;
}

export interface PendingOverlayPresentation {
  key: string;
  status: PendingOverlayStatus;
  action: string;
  reason?: string;
  stewardLabel?: string;
  expectedVersion?: number;
  actualVersion?: number;
  /** Transport attempts so far, and the first admission (ISO-8601). */
  attempts?: number;
  enqueuedAt?: string;
}

/** One queued write's facts, as the sidecar holds them: the presentation
 *  minus the intent id it is keyed by. */
export type PendingOverlayFacts = Omit<PendingOverlayPresentation, "key">;

/**
 * One read's answer to "what is happening to the writes these rows carry",
 * keyed by intent id. Built once per read from the outbox, shared by every row
 * the read returns, and never a column on any of them.
 */
export type PendingOverlaySidecar = Readonly<
  Record<string, PendingOverlayFacts>
>;

export interface PendingIntentPresentationInput {
  intentId: string;
  state: PendingOverlayStatus | "awaiting-change" | "executed";
  action: string;
  reason?: string;
  conflict?: {
    expectedVersion: number;
    actualVersion: number;
  };
  attempts?: number;
  enqueuedAt?: string;
  /** The mount a write waits on, when the member does not steward the vault. */
  stewardLabel?: string;
}

/**
 * The sidecar entry for one intent. `executed` has no entry: its projection is
 * gone and the canonical row stands on its own.
 */
export function pendingOverlayFacts(
  intent: PendingIntentPresentationInput
): PendingOverlayFacts | undefined {
  if (intent.state === "executed") return undefined;
  const status: PendingOverlayStatus =
    intent.state === "awaiting-change" ? "sending" : intent.state;
  const reason =
    intent.reason ??
    (status === "queued"
      ? "Waiting for a connection."
      : status === "sending"
        ? "Sending this change."
        : undefined);
  return {
    status,
    action: intent.action,
    ...(reason ? { reason } : {}),
    ...(intent.stewardLabel ? { stewardLabel: intent.stewardLabel } : {}),
    ...(typeof intent.attempts === "number"
      ? { attempts: intent.attempts }
      : {}),
    ...(intent.enqueuedAt ? { enqueuedAt: intent.enqueuedAt } : {}),
    ...(intent.conflict
      ? {
          expectedVersion: intent.conflict.expectedVersion,
          actualVersion: intent.conflict.actualVersion,
        }
      : {}),
  };
}

export function definePendingProjection<T extends PendingProjectionDeclaration>(
  declaration: T
): T {
  return declaration;
}

/**
 * THE ROW'S REAL ID, MINTED AT THE SEAT (#922 G2).
 *
 * It used to be `pending:<intent>:<suffix>` — a spelling that announced "this
 * row does not exist yet", which meant the origin minted a DIFFERENT id and
 * every child write filed against the pending one pointed at a row that never
 * existed. Now the projection mints the id the row will actually have, the
 * write carries it, and the origin honours it or refuses it.
 *
 * Deterministic in (intent, suffix), because a replayed intent must project
 * the SAME row rather than a second one; UUID-shaped, because that is what the
 * column holds. Pendingness is not spelled in the id any more — the overlay's
 * own `__centraid_pending_key` says it, on the row, where a reader can see it.
 */
export function stablePendingRowId(intentId: string, suffix = "row"): string {
  const seed = `${intentId}:${suffix}`;
  const words = [0x811c_9dc5, 0x0100_0193, 0x9e37_79b9, 0x85eb_ca6b].map(
    (offset, index) => {
      let hash = offset;
      for (let at = 0; at < seed.length; at += 1) {
        hash ^= seed.charCodeAt(at) + index * 0x27d4_eb2d;
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
      }
      return hash >>> 0;
    }
  );
  const hex = words.map((word) => word.toString(16).padStart(8, "0")).join("");
  // Version 8 (RFC 9562: "custom"), because it IS custom — derived, not random.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function pendingUpsert(
  entity: string,
  rowId: string,
  values: Record<string, PendingProjectionValue>
): PendingProjectionUpsert {
  return { op: "upsert", entity, rowId, values };
}

export function pendingPatch(
  entity: string,
  rowId: unknown,
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[] = []
): PendingProjectionMutation[] {
  if (typeof rowId !== "string" || rowId.length === 0) return [];
  const values: Record<string, PendingProjectionValue> = {};
  for (const key of keys) {
    const value = input[key];
    if (isPendingProjectionValue(value)) values[key] = value;
  }
  return [pendingUpsert(entity, rowId, values)];
}

/**
 * Project the row AWAY while a destructive intent is queued (#922 G6).
 *
 * Without this a member taps delete and the row stays on screen until the
 * gateway answers, with only a badge to say anything happened. Use it wherever
 * the vault command HARD-deletes the row.
 */
export function pendingDelete(
  entity: string,
  rowId: unknown
): PendingProjectionMutation[] {
  if (typeof rowId !== "string" || rowId.length === 0) return [];
  return [{ op: "delete", entity, rowId }];
}

/**
 * The soft-delete half of {@link pendingDelete}: stamp the tombstone column
 * the vault command sets, so every read that filters it out hides the row at
 * once. The instant is cosmetic — what the overlay needs is a NON-NULL value;
 * the canonical timestamp arrives with the answer and replaces it.
 */
export function pendingTombstone(
  entity: string,
  rowId: unknown,
  column = "deleted_at"
): PendingProjectionMutation[] {
  if (typeof rowId !== "string" || rowId.length === 0) return [];
  return [pendingUpsert(entity, rowId, { [column]: new Date().toISOString() })];
}

export function pendingInputValues(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Record<string, PendingProjectionValue> {
  const values: Record<string, PendingProjectionValue> = {};
  for (const key of keys) {
    const value = input[key];
    if (isPendingProjectionValue(value)) values[key] = value;
  }
  return values;
}

export function projectPendingWrite(
  declaration: PendingProjectionDeclaration | undefined,
  context: PendingProjectionContext
): PendingProjectionResult {
  if (!declaration || declaration.appId !== context.appId)
    return { optimistic: [] };
  const projection = declaration.actions[context.action];
  if (!projection || typeof projection !== "function")
    return { optimistic: [] };
  const projected = projection(context);
  return Array.isArray(projected)
    ? { optimistic: projected }
    : {
        optimistic: projected.optimistic,
        ...(projected.input ? { input: projected.input } : {}),
        ...(projected.baseVersions
          ? { baseVersions: projected.baseVersions }
          : {}),
      };
}

/** Stamp the intent onto an upsert: the row's ONE pending column (#922 G3). */
export function decoratePendingMutation<T extends PendingProjectionMutation>(
  mutation: T,
  intent: PendingIntentPresentationInput
): T {
  if (mutation.op === "delete" || intent.state === "executed") return mutation;
  return {
    ...mutation,
    values: {
      ...mutation.values,
      [PENDING_OVERLAY_FIELDS.key]: intent.intentId,
    },
  } as T;
}

/**
 * A projected row as a READ hands it over: the values carrying the intent key,
 * with that read's sidecar attached. Every seat's reader composes exactly this
 * pair, so a surface — and a harness standing in for a reader — has one way to
 * build it rather than three that can drift.
 */
export function pendingOverlayRow(
  mutation: PendingProjectionUpsert,
  intent: PendingIntentPresentationInput
): Record<string, PendingProjectionValue> {
  const facts = pendingOverlayFacts(intent);
  return attachPendingSidecar(
    decoratePendingMutation(mutation, intent).values,
    facts ? { [intent.intentId]: facts } : {}
  );
}

/** The intent a row is projected by, or undefined for a canonical row. */
export function pendingRowIntentId(
  row: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const key = row?.[PENDING_OVERLAY_FIELDS.key];
  return typeof key === "string" ? key : undefined;
}

/**
 * A row plus the read's sidecar is the whole overlay. A row whose intent the
 * sidecar does not name is NOT pending: the write settled between the read and
 * this call, and the caller must draw the canonical row rather than a badge
 * with no facts behind it.
 */
export function readPendingOverlay(
  row: Readonly<Record<string, unknown>> | undefined,
  sidecar: PendingOverlaySidecar | undefined
): PendingOverlayPresentation | undefined {
  const key = pendingRowIntentId(row);
  if (key === undefined) return undefined;
  const facts = sidecar?.[key];
  if (!facts || !isPendingOverlayStatus(facts.status)) return undefined;
  return { key, ...facts };
}

/** "on 3 September" — the day, not a duration, so it reads the same tomorrow. */
function savedOn(enqueuedAt: string): string {
  const saved = new Date(enqueuedAt);
  return Number.isNaN(saved.getTime())
    ? ""
    : ` Saved on this device on ${saved.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
      })}.`;
}

function agedSuffix(pending: PendingOverlayPresentation, now: number): string {
  if (!pending.enqueuedAt) return "";
  const saved = new Date(pending.enqueuedAt).getTime();
  if (Number.isNaN(saved) || now - saved < PENDING_OVERLAY_AGED_MS) return "";
  return savedOn(pending.enqueuedAt);
}

export function pendingOverlayCopy(
  pending: PendingOverlayPresentation,
  now: number = Date.now()
): string {
  if (pending.status === "queued")
    return `Waiting for a connection.${agedSuffix(pending, now)}`;
  if (pending.status === "sending")
    return `Sending this change.${agedSuffix(pending, now)}`;
  if (pending.status === "conflict-base-missing") {
    return (
      pending.reason ??
      "The row this change was based on is gone, so there is nothing to merge with."
    );
  }
  if (pending.status === "expired") {
    return `${pending.reason ?? "This change waited too long to be sent."}${agedSuffix(pending, now)}`;
  }
  if (pending.status === "parked")
    return pending.stewardLabel
      ? `Waiting for ${pending.stewardLabel}.`
      : (pending.reason ?? "Waiting for the owner to approve this change.");
  if (pending.status === "conflict") {
    const versions =
      pending.expectedVersion === undefined ||
      pending.actualVersion === undefined
        ? ""
        : ` Expected version ${pending.expectedVersion}; found ${pending.actualVersion}.`;
    return `${pending.reason ?? "This row changed somewhere else."}${versions}`;
  }
  return pending.reason ?? "This change was not applied.";
}

export function pendingOverlayCanRetry(
  pending: PendingOverlayPresentation
): boolean {
  return (
    pending.status === "denied" ||
    pending.status === "conflict" ||
    pending.status === "failed"
  );
}

export function pendingOverlayCanDiscard(
  pending: PendingOverlayPresentation
): boolean {
  return (
    pendingOverlayCanRetry(pending) ||
    // Retrying a change whose base row is gone would re-CREATE, not
    // reconcile, so it is discardable but never retryable (#922 G5).
    pending.status === "conflict-base-missing" ||
    pending.status === "expired" ||
    pending.status === "cancelled"
  );
}

/**
 * Pure settlement law for every seat. Executed removes the projection; every
 * non-executed result remains a row with its explanation. Persistence is owned
 * by the replica outbox, while this transition owns only visible row state.
 */
export function settlePendingOverlay(
  pending: PendingOverlayPresentation,
  settlement: PendingOverlaySettlement
): PendingOverlayPresentation | undefined {
  if (settlement.status === "executed") return undefined;
  return {
    ...pending,
    status: settlement.status,
    ...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
    ...(settlement.stewardLabel === undefined
      ? {}
      : { stewardLabel: settlement.stewardLabel }),
    ...(settlement.expectedVersion === undefined
      ? {}
      : { expectedVersion: settlement.expectedVersion }),
    ...(settlement.actualVersion === undefined
      ? {}
      : { actualVersion: settlement.actualVersion }),
  };
}

/** Expiry is a terminal presentation transition, never silent row removal. */
export function expirePendingOverlay(
  pending: PendingOverlayPresentation,
  reason = "This pending write expired before it could be applied."
): PendingOverlayPresentation {
  if (
    pending.status !== "queued" &&
    pending.status !== "sending" &&
    pending.status !== "parked"
  )
    return pending;
  return settlePendingOverlay(pending, { status: "expired", reason })!;
}

/**
 * Move a read's sidecar forward with what a later source knows about the same
 * intents. The rows never move: a settlement changes what the sidecar says
 * about a write, not which rows a write projected.
 */
export function enrichPendingSidecar(
  sidecar: PendingOverlaySidecar,
  enrichments: readonly {
    intentId: string;
    status?: PendingOverlayStatus;
    reason?: string;
    stewardLabel?: string;
  }[]
): PendingOverlaySidecar {
  const enriched: Record<string, PendingOverlayFacts> = { ...sidecar };
  for (const enrichment of enrichments) {
    const facts = enriched[enrichment.intentId];
    if (!facts) continue;
    const fields = {
      ...(enrichment.reason ? { reason: enrichment.reason } : {}),
      ...(enrichment.stewardLabel
        ? { stewardLabel: enrichment.stewardLabel }
        : {}),
    };
    if (!enrichment.status) {
      enriched[enrichment.intentId] = { ...facts, ...fields };
      continue;
    }
    if (enrichment.status === "queued" || enrichment.status === "sending") {
      enriched[enrichment.intentId] = {
        ...facts,
        ...fields,
        status: enrichment.status,
      };
      continue;
    }
    const settled = settlePendingOverlay(
      { key: enrichment.intentId, ...facts },
      { ...fields, status: enrichment.status }
    );
    if (settled) {
      const { key: _key, ...rest } = settled;
      enriched[enrichment.intentId] = rest;
    }
  }
  return enriched;
}

/**
 * A query handler returns the app's own view model, so the sidecar cannot be a
 * field on it. It rides as an enumerable symbol instead: it follows the object
 * spreads a view model is built out of, and it cannot leak onto JSON — the
 * gateway's answer to the same query has no local outbox behind it and carries
 * none.
 */
const PENDING_SIDECAR = Symbol.for("centraid.pending-sidecar");

export function attachPendingSidecar<T>(
  value: T,
  sidecar: PendingOverlaySidecar
): T {
  if (!value || typeof value !== "object") return value;
  (value as Record<symbol, unknown>)[PENDING_SIDECAR] = sidecar;
  return value;
}

export function pendingSidecarOf(value: unknown): PendingOverlaySidecar {
  if (!value || typeof value !== "object") return {};
  const sidecar = (value as Record<symbol, unknown>)[PENDING_SIDECAR];
  return sidecar && typeof sidecar === "object"
    ? (sidecar as PendingOverlaySidecar)
    : {};
}

function isPendingOverlayStatus(value: unknown): value is PendingOverlayStatus {
  return (
    value === "queued" ||
    value === "sending" ||
    value === "parked" ||
    value === "denied" ||
    value === "conflict" ||
    value === "conflict-base-missing" ||
    value === "failed" ||
    value === "expired" ||
    value === "cancelled"
  );
}

function isPendingProjectionValue(
  value: unknown
): value is PendingProjectionValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return true;
  if (Array.isArray(value)) return value.every(isPendingProjectionValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isPendingProjectionValue);
}

/**
 * The accessible label a pending badge carries (#805). Both seats read
 * it from here, so the prefix lives beside the copy it prefixes.
 */
export function pendingChangeLabel(
  pending: PendingOverlayPresentation
): string {
  return `Pending change: ${pendingOverlayCopy(pending)}`;
}
