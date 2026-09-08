import {
  PENDING_OVERLAY_FIELDS,
  attachPendingSidecar,
  pendingRowIntentId,
  pendingSidecarOf,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingOverlaySidecar } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { truncatedListNotice } from "@centraid/blueprints/apps/_shared/shared-copy";
import type { InlineQueryModule } from "@centraid/blueprints/apps/inline-types";
import type {
  Page,
  PageCursor,
  PageQuery,
  PageRequest,
} from "@centraid/core/page";

// The ctx itself is seat-neutral and lives with the replica engine, so the
// phone imports the SAME builder through `@centraid/client/replica/native`
// (#922). Only the read/search closures below are the shell's.
import { OnlineOnlyError, OnlineOnlyGuard } from "../../replica/errors.js";
import {
  buildInlineCtxCore,
  guardedRow,
  inlineReadsFor,
  runInlineQueryCore,
} from "../../replica/inline-query-ctx-core.js";
import type { InlineWireResult } from "../../replica/inline-query-ctx-core.js";
import type { SeatReadOverlay } from "../../replica/seat/read-overlay.js";
import type { ShellReplicaSearchRequest } from "../../replica/shell-session.js";
// Inline query ctx over the shell replica. Touching a field the shape does
// not carry marks ONLINE_ONLY so the caller can fall back with the same error.
import type {
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
} from "../../replica/types.js";
import { postStatus } from "../../status-channel.js";

export interface InlineReplicaSession {
  search: (
    appId: string,
    request: ShellReplicaSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
  /** The paged read path (#996 wave 4). Absent on a session with no seat. */
  page?: <Row extends object>(
    query: PageQuery<Row>,
    request: PageRequest,
    overlay?: SeatReadOverlay
  ) => Promise<Page<Row>>;
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
  /** The intent that projected the row: its ONE pending column (#922 G3). */
  intentId: string;
}

function pendingMarker(
  envelope: ReplicaRowEnvelope
): PendingRowMarker | undefined {
  const intentId = pendingRowIntentId(envelope.values);
  if (intentId === undefined) return undefined;
  const identityFields = Object.entries(envelope.values).flatMap(
    ([field, value]) =>
      (field === "id" || field.endsWith("_id")) && value === envelope.rowId
        ? [field]
        : []
  );
  if (identityFields.length === 0) return undefined;
  return { rowId: envelope.rowId, identityFields, intentId };
}

/**
 * A page row's pending provenance.
 *
 * The seat's worker drew the outbox over these rows, so a row the member is
 * still waiting on carries its intent key like any other (#922 G3). The
 * identity field is the handler's own primary key rather than a guess over
 * every `*_id` column: a page states its key, so there is nothing to infer.
 */
function pageRowMarker(
  row: Record<string, unknown>,
  pkColumn: string
): PendingRowMarker | undefined {
  const intentId = pendingRowIntentId(row);
  if (intentId === undefined) return undefined;
  const rowId = row[pkColumn];
  if (typeof rowId !== "string") return undefined;
  return { rowId, identityFields: [pkColumn], intentId };
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
// by row identity. Apps never copy overlay fields by hand — and there is only
// one to copy, the key; the facts stay on the read's sidecar (#922 G3).
function carryPendingRows(
  value: unknown,
  markers: readonly PendingRowMarker[],
  scopeId: string | undefined,
  sidecar: PendingOverlaySidecar
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      carryPendingRows(item, markers, scopeId, sidecar)
    );
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string | symbol, unknown>;
  const carried = Object.fromEntries(
    Object.entries(record as Record<string, unknown>).map(([key, item]) => [
      key,
      carryPendingRows(item, markers, scopeId, sidecar),
    ])
  );
  const matched = carriedPendingMarker(record, carried, markers);
  if (!matched) return carried;
  return attachPendingSidecar(
    {
      ...carried,
      [PENDING_OVERLAY_FIELDS.key]: matched.intentId,
      ...(scopeId ? { __centraidScopeId: scopeId } : {}),
    },
    sidecar
  );
}

// `resolve` NEVER rejects — `{ cards: [] }` rather than blanking the board.
export function buildInlineCtx(
  options: InlineCtxOptions,
  guard: OnlineOnlyGuard,
  pendingRows: PendingRowMarker[] = [],
  sidecars: PendingOverlaySidecar[] = []
): unknown {
  const { session, appId, signal } = options;
  return buildInlineCtxCore<ShellReplicaSearchRequest>(
    {
      // The shell's contributions, and only the shell's: each row carries its
      // pending-row provenance so a projection can be traced back to the
      // intent, and the two 0a duties below need a surface the phone has not
      // got — a stack that names the calling query, and a status line.
      reads: inlineReadsFor(
        session,
        appId,
        (envelope, sidecar) => {
          const marker = pendingMarker(envelope);
          if (marker) pendingRows.push(marker);
          const row = guardedRow(
            envelope,
            guard,
            marker ? [[PENDING_ROW_PROVENANCE, marker]] : []
          );
          // The row a handler holds answers for itself: the key names its
          // intent, the sidecar it carries says what is happening to it.
          return marker ? attachPendingSidecar(row, sidecar) : row;
        },
        {
          // Honesty is not optional and not the app's to forget: a ranked
          // search page that filled its window hides hits, and says so on the
          // one status line, from the read itself (#922 0a).
          onResult: (result: InlineWireResult) => {
            if (result.pending) sidecars.push(result.pending);
            if (result.truncated && result.appliedLimit !== undefined)
              postStatus(truncatedListNotice(result.appliedLimit));
          },
        }
      ),
      ...(session.page
        ? {
            // A PAGE'S ROWS ARE ROWS. They come off the seat's own file with
            // every column present — there is nothing for `guardedRow` to
            // mask, which is the point of R8 — but they still carry pending
            // provenance, because the worker drew the outbox over them and the
            // member's own unsettled write must be traceable to its intent.
            page: <Row extends object>(request: {
              query: PageQuery<Row>;
              limit: number;
              after?: PageCursor;
              overlay?: SeatReadOverlay;
            }): Promise<Page<Row>> =>
              session.page!<Row>(
                request.query,
                {
                  limit: request.limit,
                  ...(request.after ? { after: request.after } : {}),
                },
                request.overlay
              )
                .catch((error: unknown) => {
                  // A SEAT WITH NO COPY IS AN ONLINE-ONLY RUN, NOT AN APP ERROR
                  // (#996 wave 4, W4-D2 / R9). Handlers catch their own vault
                  // failures and turn them into a "cannot read this vault"
                  // screen, so a refusal that only rejects HERE is swallowed
                  // there and the query never falls back — the member sees a
                  // dead app instead of the same handler answered by the
                  // gateway's paged door. Marking the guard is what makes
                  // `runInlineQueryCore` re-raise it past the handler's own
                  // catch, with the code the inline runner falls back on.
                  if (error instanceof OnlineOnlyError) throw guard.mark(error);
                  throw error;
                })
                .then((page) => {
                  for (const row of page.rows) {
                    const marker = pageRowMarker(
                      row as Record<string, unknown>,
                      request.query.order.pkColumn
                    );
                    if (!marker) continue;
                    pendingRows.push(marker);
                    // The row's own sidecar IS this read's answer to "what is
                    // happening to these writes" (#996 wave 4b). Without it the
                    // marker names an intent the sidecar cannot describe, and
                    // `readPendingOverlay` refuses to draw a badge with no
                    // facts behind it — which is a queued row rendering as a
                    // settled one.
                    sidecars.push(pendingSidecarOf(row));
                  }
                  return page;
                }),
          }
        : {}),
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
  const sidecars: PendingOverlaySidecar[] = [];
  const ctx = buildInlineCtx(options, guard, pendingRows, sidecars);
  const value = await runInlineQueryCore(
    module as never,
    {
      ctx,
      appId: options.appId,
      ...(options.input ? { input: options.input } : {}),
    },
    guard
  );
  // One query reads several entities; the view model it returns is answered by
  // all of their sidecars at once.
  const sidecar = Object.assign({}, ...sidecars) as PendingOverlaySidecar;
  return attachPendingSidecar(
    carryPendingRows(value, pendingRows, options.scopeId, sidecar),
    sidecar
  );
}
