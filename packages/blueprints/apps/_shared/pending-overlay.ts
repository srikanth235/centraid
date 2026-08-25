/**
 * The one pending-write overlay engine (#738).
 *
 * A seat's honest local read is replica ⊕ outbox. Apps declare only how an
 * action projects into replica rows; the shell owns intent identity, status,
 * settlement and presentation metadata. This module is deliberately pure so
 * the browser shell and the native replica adapter consume the same law.
 */

export const PENDING_OVERLAY_FIELDS = {
  key: "__centraid_pending_key",
  status: "__centraid_pending_status",
  reason: "__centraid_pending_reason",
  action: "__centraid_pending_action",
  steward: "__centraid_pending_steward",
  expectedVersion: "__centraid_pending_expected_version",
  actualVersion: "__centraid_pending_actual_version",
} as const;

export type PendingOverlayStatus =
  | "queued"
  | "sending"
  | "parked"
  | "denied"
  | "conflict"
  | "failed"
  | "expired"
  | "cancelled";

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
}

export interface PendingIntentPresentationInput {
  intentId: string;
  state: PendingOverlayStatus | "awaiting-change" | "executed";
  action: string;
  reason?: string;
  conflict?: {
    expectedVersion: number;
    actualVersion: number;
  };
}

export function definePendingProjection<T extends PendingProjectionDeclaration>(
  declaration: T
): T {
  return declaration;
}

export function stablePendingRowId(intentId: string, suffix = "row"): string {
  return `pending:${intentId}:${suffix}`;
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
        ...(projected.baseVersions
          ? { baseVersions: projected.baseVersions }
          : {}),
      };
}

/** Decorate an upsert at read time so state transitions never stale a row. */
export function decoratePendingMutation<T extends PendingProjectionMutation>(
  mutation: T,
  intent: PendingIntentPresentationInput
): T {
  if (mutation.op === "delete" || intent.state === "executed") return mutation;
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
    ...mutation,
    values: {
      ...mutation.values,
      [PENDING_OVERLAY_FIELDS.key]: intent.intentId,
      [PENDING_OVERLAY_FIELDS.status]: status,
      [PENDING_OVERLAY_FIELDS.action]: intent.action,
      ...(reason ? { [PENDING_OVERLAY_FIELDS.reason]: reason } : {}),
      ...(intent.conflict
        ? {
            [PENDING_OVERLAY_FIELDS.expectedVersion]:
              intent.conflict.expectedVersion,
            [PENDING_OVERLAY_FIELDS.actualVersion]:
              intent.conflict.actualVersion,
          }
        : {}),
    },
  } as T;
}

export function readPendingOverlay(
  row: Readonly<Record<string, unknown>> | undefined
): PendingOverlayPresentation | undefined {
  if (!row) return undefined;
  const key = row[PENDING_OVERLAY_FIELDS.key];
  const status = row[PENDING_OVERLAY_FIELDS.status];
  const action = row[PENDING_OVERLAY_FIELDS.action];
  if (
    typeof key !== "string" ||
    !isPendingOverlayStatus(status) ||
    typeof action !== "string"
  )
    return undefined;
  const reason = row[PENDING_OVERLAY_FIELDS.reason];
  const stewardLabel = row[PENDING_OVERLAY_FIELDS.steward];
  const expectedVersion = row[PENDING_OVERLAY_FIELDS.expectedVersion];
  const actualVersion = row[PENDING_OVERLAY_FIELDS.actualVersion];
  return {
    key,
    status,
    action,
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof stewardLabel === "string" ? { stewardLabel } : {}),
    ...(typeof expectedVersion === "number" ? { expectedVersion } : {}),
    ...(typeof actualVersion === "number" ? { actualVersion } : {}),
  };
}

export function pendingOverlayCopy(
  pending: PendingOverlayPresentation
): string {
  if (pending.status === "queued") return "Waiting for a connection.";
  if (pending.status === "sending") return "Sending this change.";
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

export function enrichPendingRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  enrichments: readonly {
    intentId: string;
    status?: PendingOverlayStatus;
    reason?: string;
    stewardLabel?: string;
  }[]
): T[] {
  const byIntent = new Map(enrichments.map((item) => [item.intentId, item]));
  return rows.map((row) => {
    const pending = readPendingOverlay(row);
    const enrichment = pending ? byIntent.get(pending.key) : undefined;
    if (!enrichment) return row;
    const enrichmentFields = {
      ...(enrichment.reason ? { reason: enrichment.reason } : {}),
      ...(enrichment.stewardLabel
        ? { stewardLabel: enrichment.stewardLabel }
        : {}),
    };
    const enriched =
      enrichment.status === "queued" || enrichment.status === "sending"
        ? { ...pending!, ...enrichmentFields, status: enrichment.status }
        : enrichment.status
          ? settlePendingOverlay(pending!, {
              ...enrichmentFields,
              status: enrichment.status,
            })!
          : pending!;
    return {
      ...row,
      [PENDING_OVERLAY_FIELDS.status]: enriched.status,
      ...(enriched.reason
        ? { [PENDING_OVERLAY_FIELDS.reason]: enriched.reason }
        : {}),
      ...(enriched.stewardLabel
        ? { [PENDING_OVERLAY_FIELDS.steward]: enriched.stewardLabel }
        : {}),
    };
  });
}

function isPendingOverlayStatus(value: unknown): value is PendingOverlayStatus {
  return (
    value === "queued" ||
    value === "sending" ||
    value === "parked" ||
    value === "denied" ||
    value === "conflict" ||
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
