/**
 * The phone's inline-query `ctx` (#922 wave 1, ruling (i) — precondition (a)).
 *
 * There is ONE ctx builder, and it is not here: `inline-query-ctx-core.ts` in
 * `@centraid/client/replica/native` holds the online guard, the row proxy, the
 * verb surface and the runner, and the shell's `inlineQueryCtx.ts` calls the
 * same functions. This file is the seat's whole contribution — how a read
 * reaches rows on a phone — and nothing else. When the spike first landed it
 * restated 93 of the core's lines; that duplication is deleted, not tolerated.
 *
 * Read-only by construction: every write and gateway-only verb rejects inside
 * the core, so the `handler-contract` rule holds without trusting the handler.
 *
 * A handler never sees this seat's multi-vault provenance (#922 E7,
 * precondition (b)). The mounted plane decorates every row with
 * `__centraidScopeId` and its siblings; a handler that SPREADS a row — Tally's
 * `recurring` does — would otherwise emit them into a payload the web seat's
 * payload does not carry, and the two seats would answer differently for the
 * same rows. `withoutScopeProvenance` is the one place that strip happens.
 */
import { attachPendingSidecar } from "@centraid/blueprints/apps/_shared/pending-overlay";
import {
  buildInlineCtxCore,
  guardedRow,
  inlineReadsFor,
  OnlineOnlyGuard,
  runInlineQueryCore,
} from "@centraid/client/replica/native";
import type {
  InlinePage,
  InlineQueryRunnable,
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";

import type { NativeReadRequest, NativeSearchRequest } from "./native-session";
import {
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_ID,
  REPLICA_SCOPE_LABEL,
} from "./vault-source";

/** The keys the session stamps and a handler must never receive. */
const SCOPE_PROVENANCE: readonly string[] = [
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_ID,
  REPLICA_SCOPE_LABEL,
];

/**
 * The envelope as the seat's replica session hands it over. Which vault a row
 * came from is this seat's fact about its own open file, not a column of the
 * entity, so it stops here — on the ENVELOPE, before `guardedRow` wraps
 * the values, so the unavailable-field proxy is built over the stripped set
 * and no key is read through it to strip one.
 */
export function withoutScopeProvenance(
  envelope: ReplicaRowEnvelope
): ReplicaRowEnvelope {
  const values = envelope.values as Record<string, unknown>;
  if (!SCOPE_PROVENANCE.some((key) => key in values)) return envelope;
  return {
    ...envelope,
    values: Object.fromEntries(
      Object.entries(values).filter(([key]) => !SCOPE_PROVENANCE.includes(key))
    ) as typeof envelope.values,
  };
}

/**
 * What a handler needs from the phone: the read plane, and — since #996 wave
 * 4b — the SEAT's own paged read.
 *
 * `page` is optional for one reason and it is not compatibility: a phone that
 * has not finished copying the vault has no seat, and `ctx.vault.page` is then
 * the core's online-only stub, which is the same answer a browser that turned
 * "Keep an offline copy" off gives (W4-D2, R9). It is never the old store's
 * handle: that file is `replica_row`/`payload_json` and a handler's plain SQL
 * over the vault's real tables cannot run on it at all.
 */
export interface NativeInlineQuerySession {
  read: (
    appId: string,
    request: NativeReadRequest
  ) => Promise<ReplicaReadWireResult>;
  search: (
    appId: string,
    request: NativeSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
  page?: InlinePage;
}

/** The seat's one contribution to a read plane: a page over its own file. */
export interface NativeSeatPagePort {
  page: InlinePage;
}

/**
 * The read plane a handler actually runs on: the session's rows, the seat's
 * pages.
 *
 * They are separate objects because they are separate FILES until W5 — the
 * session's is the old store's, the seat's is `vault.db` — and composing them
 * here rather than inside the session keeps that seam visible at the one place
 * a screen hands a plane over.
 */
export function seatReadPlane(
  session: NativeInlineQuerySession,
  seat: NativeSeatPagePort | undefined
): NativeInlineQuerySession {
  if (!seat) return session;
  return {
    read: (appId, request) => session.read(appId, request),
    search: (appId, request) => session.search(appId, request),
    page: seat.page,
  };
}

export interface NativeInlineCtxOptions {
  session: NativeInlineQuerySession;
  appId: string;
  signal?: AbortSignal;
}

export function buildNativeInlineCtx(
  options: NativeInlineCtxOptions,
  guard: OnlineOnlyGuard
): unknown {
  const { session, appId, signal } = options;
  return buildInlineCtxCore<NativeReadRequest, NativeSearchRequest>(
    {
      // Every row the handler sees carries the read's pending sidecar, so the
      // phone answers `readPendingOverlay(row, pendingSidecarOf(row))` exactly
      // as the shell does (#922 G3).
      reads: inlineReadsFor(session, appId, (envelope, sidecar) =>
        attachPendingSidecar(
          guardedRow(withoutScopeProvenance(envelope), guard),
          sidecar
        )
      ),
      ...(session.page ? { page: session.page } : {}),
      ...(signal ? { signal } : {}),
    },
    guard
  );
}

/** Run one blueprint query handler against the phone's mounted replica. */
export function runNativeInlineQuery(
  module: InlineQueryRunnable,
  options: NativeInlineCtxOptions & { input?: Record<string, unknown> }
): Promise<unknown> {
  const guard = new OnlineOnlyGuard();
  const ctx = buildNativeInlineCtx(options, guard);
  return runInlineQueryCore(
    module,
    {
      ctx,
      appId: options.appId,
      ...(options.input ? { input: options.input } : {}),
    },
    guard
  );
}
