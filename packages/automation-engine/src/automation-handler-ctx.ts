/**
 * Parent-side handlers for the worker's `ctx.*` messages (issue #80).
 *
 * Split out of `automation-handler-runner.ts` so the runner stays focused
 * on worker lifecycle + message routing. Each function here takes the
 * audit `AgentRunsStore` (when present) and returns a reply that
 * matches the worker's expected wire shape.
 */

import type {
  AutomationDispatchContext,
  AutomationInvokeDispatcher,
  AutomationToolDispatcher,
  AutomationToolResult,
} from './automation-handler-runner.js';
import type { AgentRunsStore } from '@centraid/app-engine';
import {
  closeRunNode,
  openRunNode,
  rowToRunRef,
  type RunEventSink,
} from './automation-handler-audit.js';

export interface ToolCallWire {
  name: string;
  args: unknown;
}

export interface AuditState {
  store: AgentRunsStore;
  runId: string;
  automationId: string;
  ordinal: number;
  nextBatchId: number;
  /** Live run-stream sink. No-op until the host wires its bus (issue #158). */
  emit: RunEventSink;
}

export function nextOrdinal(audit: AuditState): number {
  return audit.ordinal++;
}

export function nextBatchIdFor(audit: AuditState, n: number): number | undefined {
  if (n <= 1) return undefined;
  return audit.nextBatchId++;
}

export interface DispatchBatchArgs {
  audit: AuditState;
  toolDispatcher: AutomationToolDispatcher;
  dispatchCtx: AutomationDispatchContext;
  calls: ToolCallWire[];
}

/**
 * Dispatch one batch of `ctx.tool` calls and record each as a
 * `run_nodes` row. There is no runtime retry — a failed `ctx.tool`
 * rejects the handler's Promise, and the handler (which is plain JS)
 * owns retry/backoff/error-classification via `try/catch`. See the
 * "Run audit & state" block of the builder system prompt.
 */
export async function dispatchToolBatch(args: DispatchBatchArgs): Promise<AutomationToolResult[]> {
  const { audit, calls, toolDispatcher, dispatchCtx } = args;
  const ordinals = calls.map(() => nextOrdinal(audit));
  const batchId = nextBatchIdFor(audit, calls.length);
  const started = Date.now();
  // Open every node (durable "running" row + `node.start`) BEFORE the batch
  // dispatches, so the parallel lane shows all calls in flight at once.
  const nodeIds = calls.map((call, i) =>
    openRunNode({
      store: audit.store,
      emit: audit.emit,
      runId: audit.runId,
      ordinal: ordinals[i]!,
      ...(batchId !== undefined ? { batchId } : {}),
      kind: 'tool',
      name: call.name,
      args: call.args,
      started,
    }),
  );
  let results: AutomationToolResult[];
  try {
    results = await toolDispatcher(
      calls.map((c) => ({ name: c.name, args: c.args })),
      dispatchCtx,
    );
  } catch (err) {
    // The dispatcher rejected wholesale (e.g. CLI spawn blew up). The runner's
    // catch turns this into failed tool replies and the run keeps going — so if
    // we don't settle the nodes here they'd stay `ended_at = NULL` forever and
    // the live stream would never see them terminate. Close every opened node
    // as failed (durable close + `node.end`), then rethrow so the runner still
    // sends its per-call failure replies to the worker.
    const ended = Date.now();
    const error = err instanceof Error ? err.message : String(err);
    for (let i = 0; i < nodeIds.length; i++) {
      closeRunNode({
        store: audit.store,
        emit: audit.emit,
        nodeId: nodeIds[i]!,
        ordinal: ordinals[i]!,
        ok: false,
        error,
        started,
        ended,
      });
    }
    throw err;
  }
  const ended = Date.now();
  return calls.map((_call, i) => {
    const result = results[i] ?? { ok: false, error: 'no result returned by dispatcher' };
    // Phase 3 (issue #158): prefer the dispatcher's real per-tool window when
    // it reported one (mock onToolStart/onToolResults); else the batch span.
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId: nodeIds[i]!,
      ordinal: ordinals[i]!,
      ok: result.ok,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      started: result.startedAt ?? started,
      ended: result.endedAt ?? ended,
    });
    return result;
  });
}

export interface CtxReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function handleStateMessage(
  audit: AuditState,
  method: 'get' | 'set' | 'delete',
  key: string,
  value: unknown,
): CtxReply {
  try {
    if (method === 'get') {
      const entry = audit.store.stateGet(audit.automationId, key);
      if (!entry) return { ok: true, result: undefined };
      try {
        return { ok: true, result: JSON.parse(entry.valueJson) as unknown };
      } catch {
        return { ok: true, result: entry.valueJson };
      }
    }
    if (method === 'set') {
      const json = JSON.stringify(value === undefined ? null : value);
      audit.store.stateSet(audit.automationId, key, json, Date.now());
      return { ok: true };
    }
    if (method === 'delete') {
      audit.store.stateDelete(audit.automationId, key);
      return { ok: true };
    }
    return { ok: false, error: `unknown state method: ${String(method)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleRunsMessage(
  audit: AuditState,
  method: 'last' | 'list',
  filter: { automationId?: string; status?: 'ok' | 'error'; since?: number; limit?: number },
): CtxReply {
  try {
    const automationId = filter.automationId ?? audit.automationId;
    const limit = filter.limit ?? 50;
    // Fetch one extra row so we can drop the in-progress self-run without
    // short-changing the caller's limit.
    const rows = audit.store
      .listRuns({
        automationId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.since !== undefined ? { since: filter.since } : {}),
        limit: limit + 1,
      })
      .filter((r) => r.runId !== audit.runId)
      .slice(0, limit);
    if (method === 'last') {
      const first = rows[0];
      return { ok: true, result: first ? rowToRunRef(first) : undefined };
    }
    return { ok: true, result: rows.map(rowToRunRef) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleInvokeMessage(
  audit: AuditState,
  dispatchCtx: AutomationDispatchContext,
  invokeDispatcher: AutomationInvokeDispatcher | undefined,
  name: string,
  input: unknown,
): Promise<CtxReply> {
  if (!invokeDispatcher) {
    return { ok: false, error: 'ctx.invoke is not wired by the host runtime' };
  }
  const ordinal = nextOrdinal(audit);
  const started = Date.now();
  const nodeId = openRunNode({
    store: audit.store,
    emit: audit.emit,
    runId: audit.runId,
    ordinal,
    kind: 'invoke',
    name,
    args: input,
    started,
  });
  try {
    const res = await invokeDispatcher(name, { input, parentRunId: audit.runId }, dispatchCtx);
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: true,
      result: res.output,
      ...(res.childRunId ? { childRunId: res.childRunId } : {}),
      started,
      ended: Date.now(),
    });
    return { ok: true, result: res.output };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const tagged = err as { childRunId?: unknown };
    const childRunId = typeof tagged.childRunId === 'string' ? tagged.childRunId : undefined;
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: false,
      error,
      ...(childRunId ? { childRunId } : {}),
      started,
      ended: Date.now(),
    });
    return { ok: false, error };
  }
}
