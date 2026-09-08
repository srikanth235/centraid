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
  InlineQueryRunnable,
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";

import {
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_ID,
  REPLICA_SCOPE_IDS,
  REPLICA_SCOPE_LABEL,
  REPLICA_SCOPE_LABELS,
  REPLICA_WRITABLE_SCOPE_IDS,
} from "./multi-vault-provenance";
import type { NativeReadRequest, NativeSearchRequest } from "./native-session";

/** The keys the mounted plane adds and a handler must never receive. */
const SCOPE_PROVENANCE: readonly string[] = [
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_ID,
  REPLICA_SCOPE_IDS,
  REPLICA_SCOPE_LABEL,
  REPLICA_SCOPE_LABELS,
  REPLICA_WRITABLE_SCOPE_IDS,
];

/**
 * The envelope as the web seat's replica session hands it over. Which vault a
 * row came from is this seat's fact about its own mounted plane, not a column
 * of the entity, so it stops here — on the ENVELOPE, before `guardedRow` wraps
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

/** What a handler needs from the phone: the mounted read plane, nothing else. */
export interface NativeInlineQuerySession {
  read: (
    appId: string,
    request: NativeReadRequest
  ) => Promise<ReplicaReadWireResult>;
  search: (
    appId: string,
    request: NativeSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
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
