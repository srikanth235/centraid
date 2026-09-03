import { PENDING_OVERLAY_FIELDS } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { truncatedListNotice } from "@centraid/blueprints/apps/_shared/shared-copy";
import type { InlineQueryModule } from "@centraid/blueprints/apps/inline-types";

// The ctx itself is seat-neutral and lives with the replica engine, so the
// phone imports the SAME builder through `@centraid/client/replica/native`
// (#922). Only the read/search closures below are the shell's.
import { OnlineOnlyGuard } from "../../replica/errors.js";
import {
  buildInlineCtxCore,
  guardedRow,
  inlineReadsFor,
  runInlineQueryCore,
} from "../../replica/inline-query-ctx-core.js";
import type { InlineWireResult } from "../../replica/inline-query-ctx-core.js";
import { assertBoundedReplicaRead } from "../../replica/read-plan.js";
import type {
  ShellReplicaReadRequest,
  ShellReplicaSearchRequest,
} from "../../replica/shell-session.js";
// Inline query ctx over the shell replica. Touching a field the shape does
// not carry marks ONLINE_ONLY so the caller can fall back with the same error.
import type {
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
} from "../../replica/types.js";
import { postStatus } from "../../status-channel.js";

export interface InlineReplicaSession {
  read: (
    appId: string,
    request: ShellReplicaReadRequest
  ) => Promise<ReplicaReadWireResult>;
  search: (
    appId: string,
    request: ShellReplicaSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
}

// Pending identity is shell-owned and rides the row as an enumerable symbol:
// it follows object spreads but cannot leak onto JSON.
const PENDING_ROW_PROVENANCE = Symbol("centraid.pending-row-provenance");

export interface InlineCtxOptions {
  session: InlineReplicaSession;
  appId: string;
  isOnline?: () => boolean;
  signal?: AbortSignal;
  scopeId?: string;
}

interface PendingRowMarker {
  rowId: string;
  identityFields: readonly string[];
  fields: Record<string, unknown>;
}

const pendingFieldNames = Object.values(PENDING_OVERLAY_FIELDS);

function pendingMarker(
  envelope: ReplicaRowEnvelope
): PendingRowMarker | undefined {
  if (typeof envelope.values[PENDING_OVERLAY_FIELDS.key] !== "string")
    return undefined;
  const identityFields = Object.entries(envelope.values).flatMap(
    ([field, value]) =>
      (field === "id" || field.endsWith("_id")) && value === envelope.rowId
        ? [field]
        : []
  );
  if (identityFields.length === 0) return undefined;
  return {
    rowId: envelope.rowId,
    identityFields,
    fields: Object.fromEntries(
      pendingFieldNames.flatMap((field) =>
        envelope.values[field] === undefined
          ? []
          : [[field, envelope.values[field]]]
      )
    ),
  };
}

function carriedPendingMarker(
  source: Record<string | symbol, unknown>,
  carried: Record<string, unknown>,
  markers: readonly PendingRowMarker[]
): PendingRowMarker | undefined {
  const exact = source[PENDING_ROW_PROVENANCE];
  if (exact && typeof exact === "object") return exact as PendingRowMarker;

  // Projections drop the symbol. Match field+value; refuse ambiguity — never
  // assign a parent's controls to its child.
  for (const [field, value] of Object.entries(carried)) {
    if (field !== "id" && !field.endsWith("_id")) continue;
    const candidates = markers.filter(
      (marker) =>
        marker.rowId === value && marker.identityFields.includes(field)
    );
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return undefined;
  }
  return undefined;
}

// Pending identity is shell-owned: carry it across product-field projections
// by row identity. Apps never copy overlay fields by hand.
function carryPendingRows(
  value: unknown,
  markers: readonly PendingRowMarker[],
  scopeId: string | undefined
): unknown {
  if (Array.isArray(value))
    return value.map((item) => carryPendingRows(item, markers, scopeId));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string | symbol, unknown>;
  const carried = Object.fromEntries(
    Object.entries(record as Record<string, unknown>).map(([key, item]) => [
      key,
      carryPendingRows(item, markers, scopeId),
    ])
  );
  const matched = carriedPendingMarker(record, carried, markers);
  if (!matched) return carried;
  return {
    ...carried,
    ...matched.fields,
    ...(scopeId ? { __centraidScopeId: scopeId } : {}),
  };
}

// `resolve` NEVER rejects — `{ cards: [] }` rather than blanking the board.
export function buildInlineCtx(
  options: InlineCtxOptions,
  guard: OnlineOnlyGuard,
  pendingRows: PendingRowMarker[] = []
): unknown {
  const { session, appId, signal } = options;
  return buildInlineCtxCore<ShellReplicaReadRequest, ShellReplicaSearchRequest>(
    {
      // The shell's contributions, and only the shell's: each row carries its
      // pending-row provenance so a projection can be traced back to the
      // intent, and the two 0a duties below need a surface the phone has not
      // got — a stack that names the calling query, and a status line.
      reads: inlineReadsFor(
        session,
        appId,
        (envelope) => {
          const marker = pendingMarker(envelope);
          if (marker) pendingRows.push(marker);
          return guardedRow(
            envelope,
            guard,
            marker ? [[PENDING_ROW_PROVENANCE, marker]] : []
          );
        },
        {
          // THE WEB SEAT'S BOUNDARY (#922 0a). A query that declares no window
          // and does not accept the default one is refused HERE, where the
          // caller's own file is named in the stack, rather than answered with
          // a page silently capped at 1,000 rows.
          beforeRead: assertBoundedReplicaRead,
          // Honesty is not optional and not the app's to forget: a window that
          // cut rows off says so on the one status line, from the read itself.
          // A ranked search page that filled its window hides hits exactly as a
          // list read hides rows, and says so on the same line (#922 0a) —
          // which is why this is `onResult` and not two copies.
          onResult: (result: InlineWireResult) => {
            if (result.truncated && result.appliedLimit !== undefined)
              postStatus(truncatedListNotice(result.appliedLimit));
          },
        }
      ),
      ...(signal ? { signal } : {}),
    },
    guard
  );
}

export async function runInlineQuery(
  module: InlineQueryModule,
  options: InlineCtxOptions & { input?: Record<string, unknown> }
): Promise<unknown> {
  const guard = new OnlineOnlyGuard();
  const pendingRows: PendingRowMarker[] = [];
  const ctx = buildInlineCtx(options, guard, pendingRows);
  const value = await runInlineQueryCore(
    module as never,
    {
      ctx,
      appId: options.appId,
      ...(options.input ? { input: options.input } : {}),
    },
    guard
  );
  return carryPendingRows(value, pendingRows, options.scopeId);
}
