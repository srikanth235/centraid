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
 * Nothing in the product imports this yet — product wiring is E7's.
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
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";

import type { NativeReadRequest, NativeSearchRequest } from "./native-session";

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
        attachPendingSidecar(guardedRow(envelope, guard), sidecar)
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
